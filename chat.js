/* Bam Bam live chat + accounts engine.
 *
 * Messages travel over free public MQTT brokers (WebSocket). We connect to two brokers at once and
 * de-duplicate, so chat keeps working if one is down.
 *
 * Accounts: each viewer's browser makes its own signing key when they create an account. The account
 * ID is derived from that key, and every message is signed with it, so nobody can post as someone
 * else. The host's messages and moderation (delete, mute, ban, pause) are signed with the host key,
 * and every client checks that signature against the public key in content.json before trusting them.
 */
(function () {
  "use strict";
  const BROKERS = (window.BAMCHAT_BROKERS && window.BAMCHAT_BROKERS.length) ? window.BAMCHAT_BROKERS : ["wss://broker.hivemq.com:8884/mqtt", "wss://broker.emqx.io:8084/mqtt"];
  const enc = new TextEncoder(), dec = new TextDecoder();

  // ---------- minimal MQTT 3.1.1 client (QoS 0 + retained) ----------
  function lenBytes(n) { const out = []; do { let b = n % 128; n = Math.floor(n / 128); if (n > 0) b |= 128; out.push(b); } while (n > 0); return out; }
  function str(s) { const b = enc.encode(s); return [b.length >> 8, b.length & 255, ...b]; }
  function packet(type, body) { return new Uint8Array([type, ...lenBytes(body.length), ...body]); }

  class Mini {
    constructor(url, onMessage, onState) {
      this.url = url; this.onMessage = onMessage; this.onState = onState;
      this.subs = new Set(); this.buf = new Uint8Array(0); this.pid = 1; this.up = false; this.retry = 1000; this.closed = false;
      this.open();
    }
    open() {
      if (this.closed) return;
      let ws;
      try { ws = new WebSocket(this.url, ["mqtt"]); } catch (_) { return this.later(); }
      ws.binaryType = "arraybuffer"; this.ws = ws;
      ws.onopen = () => ws.send(packet(0x10, [...str("MQTT"), 4, 0x02, 0, 60, ...str("bb" + Math.random().toString(36).slice(2, 12))]));
      ws.onmessage = ev => this.feed(new Uint8Array(ev.data));
      ws.onclose = () => { this.up = false; clearInterval(this.ping); this.onState(); this.later(); };
      ws.onerror = () => { try { ws.close(); } catch (_) {} };
    }
    later() { if (this.closed) return; setTimeout(() => this.open(), this.retry); this.retry = Math.min(this.retry * 2, 30000); }
    feed(chunk) {
      const b = new Uint8Array(this.buf.length + chunk.length); b.set(this.buf); b.set(chunk, this.buf.length); this.buf = b;
      for (;;) {
        if (this.buf.length < 2) return;
        let mul = 1, len = 0, i = 1, byte;
        do { if (i >= this.buf.length) return; byte = this.buf[i++]; len += (byte & 127) * mul; mul *= 128; } while (byte & 128);
        if (this.buf.length < i + len) return;
        const type = this.buf[0], body = this.buf.slice(i, i + len);
        this.buf = this.buf.slice(i + len);
        this.handle(type, body);
      }
    }
    handle(type, body) {
      const kind = type >> 4;
      if (kind === 2) {
        if (body[1] !== 0) return;
        this.up = true; this.retry = 1000; this.onState();
        this.subs.forEach(t => this.sendSub(t));
        clearInterval(this.ping); this.ping = setInterval(() => this.raw(new Uint8Array([0xC0, 0])), 30000);
      } else if (kind === 3) {
        const qos = (type >> 1) & 3;
        const tl = (body[0] << 8) | body[1];
        const topic = dec.decode(body.slice(2, 2 + tl));
        const payload = body.slice(2 + tl + (qos ? 2 : 0));
        try { this.onMessage(topic, dec.decode(payload)); } catch (_) {}
      }
    }
    raw(p) { if (this.ws && this.ws.readyState === 1) this.ws.send(p); }
    sendSub(topic) { const id = (this.pid++ & 0xffff) || 1; this.raw(packet(0x82, [id >> 8, id & 255, ...str(topic), 0])); }
    subscribe(topic) { this.subs.add(topic); if (this.up) this.sendSub(topic); }
    publish(topic, text, retain) { if (!this.up) return false; this.raw(packet(0x30 | (retain ? 1 : 0), [...str(topic), ...enc.encode(text)])); return true; }
  }

  // ---------- signatures (ECDSA P-256) ----------
  const ALG = { name: "ECDSA", namedCurve: "P-256" }, SIGN = { name: "ECDSA", hash: "SHA-256" };
  const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const unb64u = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), c => c.charCodeAt(0));
  const body = o => { const c = Object.assign({}, o); delete c.sig; return JSON.stringify(c); };
  const B64U = /^[A-Za-z0-9_-]{43}$/;
  async function accountIdFor(k) { return "u" + b64u((await crypto.subtle.digest("SHA-256", enc.encode(k.x + "." + k.y))).slice(0, 9)); }
  const keyCache = new Map();
  async function verifyWith(k, o) {
    if (!k || !B64U.test(k.x || "") || !B64U.test(k.y || "") || typeof o.sig !== "string") return false;
    const ck = k.x + k.y;
    try {
      let key = keyCache.get(ck);
      if (!key) { key = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: k.x, y: k.y, ext: true }, ALG, false, ["verify"]); keyCache.set(ck, key); }
      return await crypto.subtle.verify(SIGN, key, unb64u(o.sig), enc.encode(body(o)));
    } catch (_) { return false; }
  }

  // ---------- this browser's account ----------
  const NAME_MAX = 20, TEXT_MAX = 200, KEEP = 150;
  const clean = (s, n) => String(s == null ? "" : s).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
  const reserved = n => /bam\s*bam|host|admin|moderator|^mod$|staff|official/i.test(n);
  const validName = n => /^[A-Za-z0-9_. -]{3,20}$/.test(n) && !reserved(n);
  const ACCT_KEY = "bambam-account";
  const Account = {
    get() { try { const a = JSON.parse(localStorage.getItem(ACCT_KEY) || "null"); return a && a.id && a.priv && a.pub ? a : null; } catch (_) { return null; } },
    async create(name) {
      name = clean(name, NAME_MAX);
      if (!validName(name)) throw new Error(reserved(name) ? "reserved" : "bad name");
      const kp = await crypto.subtle.generateKey(ALG, true, ["sign", "verify"]);
      const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
      const pub = { x: jwk.x, y: jwk.y };
      const a = { id: await accountIdFor(pub), name, pub, priv: jwk.d, created: Date.now(), ageOk: true };
      try { localStorage.setItem(ACCT_KEY, JSON.stringify(a)); } catch (_) { throw new Error("storage"); }
      return a;
    },
    rename(name) {
      const a = this.get(); name = clean(name, NAME_MAX);
      if (!a || !validName(name)) return null;
      a.name = name; try { localStorage.setItem(ACCT_KEY, JSON.stringify(a)); } catch (_) {}
      return a;
    },
    async signer(a) { return crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: a.pub.x, y: a.pub.y, d: a.priv, ext: true }, ALG, false, ["sign"]); },
  };

  // ---------- chat room ----------
  async function createChat(cfg) {
    // cfg: {room, pub:{x,y}, privD?, account?, onUpdate(view), onAccounts?(list)}
    if (!cfg || !/^[A-Za-z0-9_-]{6,40}$/.test(cfg.room || "") || !cfg.pub || !cfg.pub.x || !cfg.pub.y) return null;
    if (!window.crypto || !crypto.subtle || typeof WebSocket === "undefined") return null;
    const base = "bambamchat/" + cfg.room;
    const T_LIVE = base + "/live", T_HIST = base + "/hist", T_ACCT = base + "/acct/";
    const hostPub = { x: cfg.pub.x, y: cfg.pub.y };
    let hostKey = null;
    if (cfg.privD) {
      try { hostKey = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: hostPub.x, y: hostPub.y, d: cfg.privD, ext: true }, ALG, false, ["sign"]); } catch (_) { hostKey = null; }
    }
    let me = cfg.account || null, myKey = null;
    if (me && !hostKey) { try { myKey = await Account.signer(me); } catch (_) { me = null; } }

    const st = { items: [], byId: new Map(), mutedA: new Set(), bannedA: new Set(), deleted: new Set(), locked: false, histTs: 0, accounts: new Map() };
    const seen = new Set();
    const isHost = !!hostKey;

    function add(m) {
      if (st.byId.has(m.id)) return;
      st.byId.set(m.id, m); st.items.push(m);
      st.items.sort((a, b) => a.ts - b.ts);
      while (st.items.length > KEEP) st.byId.delete(st.items.shift().id);
    }
    function touchAccount(id, name, k, ts, extra) {
      const a = st.accounts.get(id) || { id, name, pub: k, created: ts, lastSeen: ts, messages: 0 };
      if (name) a.name = name;
      if (ts > (a.lastSeen || 0)) a.lastSeen = ts;
      if (extra && extra.created && (!a.created || extra.created < a.created)) a.created = extra.created;
      if (extra && extra.msg) a.messages = (a.messages || 0) + 1;
      st.accounts.set(id, a);
    }
    let pending = 0, accTimer = 0;
    function changed() {
      clearTimeout(pending); pending = setTimeout(() => cfg.onUpdate && cfg.onUpdate(view()), 30);
      if (isHost) scheduleHist();
      if (cfg.onAccounts) { clearTimeout(accTimer); accTimer = setTimeout(() => cfg.onAccounts(accounts()), 120); }
    }
    function view() {
      return {
        locked: st.locked, isHost, connected: clients.some(c => c.up), me,
        banned: !!(me && st.bannedA.has(me.id)), mutedMe: !!(me && st.mutedA.has(me.id)),
        messages: st.items.filter(m => !st.deleted.has(m.id) && !(m.t === "m" && (st.mutedA.has(m.a) || st.bannedA.has(m.a)))),
      };
    }
    function accounts() {
      return [...st.accounts.values()].map(a => Object.assign({}, a, { muted: st.mutedA.has(a.id), banned: st.bannedA.has(a.id) }))
        .sort((x, y) => (y.lastSeen || 0) - (x.lastSeen || 0));
    }
    async function viewerMsg(o) {
      const n = clean(o.n, NAME_MAX), x = clean(o.x, TEXT_MAX), id = clean(o.id, 40);
      if (!n || !x || !/^[A-Za-z0-9_-]{6,40}$/.test(id) || typeof o.ts !== "number" || !o.k || typeof o.a !== "string") return null;
      if (o.a !== await accountIdFor(o.k)) return null;
      if (!(await verifyWith(o.k, o))) return null;
      return { t: "m", id, n, x, ts: o.ts, a: o.a, k: { x: o.k.x, y: o.k.y }, sig: o.sig };
    }

    async function onRaw(topic, text) {
      if (text.length > 30000) return;
      let o; try { o = JSON.parse(text); } catch (_) { return; }
      if (!o || typeof o !== "object") return;
      if (topic.startsWith(T_ACCT)) { // account registration (retained, one per account)
        if (o.t !== "reg" || !o.k || !(await verifyWith(o.k, o))) return;
        const id = await accountIdFor(o.k);
        if (topic !== T_ACCT + id || o.a !== id) return;
        const n = clean(o.n, NAME_MAX); if (!n) return;
        touchAccount(id, n, { x: o.k.x, y: o.k.y }, Number(o.ts) || 0, { created: Number(o.created) || 0 });
        return changed();
      }
      if (topic === T_HIST) {
        if (o.t !== "hist" || !(await verifyWith(hostPub, o)) || o.ts <= st.histTs) return;
        st.histTs = o.ts;
        st.mutedA = new Set((o.mutedA || []).map(String));
        st.bannedA = new Set((o.bannedA || []).map(String));
        (o.deleted || []).forEach(id => st.deleted.add(String(id)));
        st.locked = !!o.lock;
        for (const m of (o.items || [])) {
          if (m.t === "m") { const v = await viewerMsg(m); if (v) add(v); }
          else if (m.t === "h" && await verifyWith(hostPub, m)) add({ t: "h", id: m.id, x: clean(m.x, TEXT_MAX * 2), ts: m.ts, sig: m.sig });
        }
        return changed();
      }
      if (topic !== T_LIVE) return;
      const key = o.t + ":" + (o.id || o.a || "") + ":" + o.ts;
      if (seen.has(key)) return; seen.add(key); if (seen.size > 3000) seen.clear();
      if (o.t === "m") {
        const v = await viewerMsg(o); if (!v) return;
        add(v); touchAccount(v.a, v.n, v.k, v.ts, { msg: true }); return changed();
      }
      if (!(await verifyWith(hostPub, o))) return; // everything below is host-only
      if (o.t === "h") add({ t: "h", id: String(o.id), x: clean(o.x, TEXT_MAX * 2), ts: o.ts, sig: o.sig });
      else if (o.t === "del") st.deleted.add(String(o.id));
      else if (o.t === "mute") st.mutedA.add(String(o.a));
      else if (o.t === "unmute") st.mutedA.delete(String(o.a));
      else if (o.t === "ban") st.bannedA.add(String(o.a));
      else if (o.t === "unban") st.bannedA.delete(String(o.a));
      else if (o.t === "lock") st.locked = !!o.on;
      else if (o.t === "clear") st.items.forEach(m => st.deleted.add(m.id));
      changed();
    }

    const clients = BROKERS.map(url => new Mini(url, onRaw, () => { changed(); if (me && myKey) register(); }));
    clients.forEach(c => { c.subscribe(T_LIVE); c.subscribe(T_HIST); if (isHost || cfg.onAccounts) c.subscribe(T_ACCT + "+"); });
    const send = (topic, obj, retain) => { const s = JSON.stringify(obj); let ok = false; clients.forEach(c => { ok = c.publish(topic, s, retain) || ok; }); return ok; };
    const newId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    async function signAs(key, o) { o.sig = b64u(await crypto.subtle.sign(SIGN, key, enc.encode(body(o)))); return o; }

    // announce this viewer's account (retained, so the host's tracker sees everyone who has signed up)
    let lastReg = 0;
    async function register() {
      if (!me || !myKey || Date.now() - lastReg < 20000) return;
      lastReg = Date.now();
      const o = await signAs(myKey, { t: "reg", a: me.id, n: me.name, k: me.pub, created: me.created, ts: Date.now() });
      send(T_ACCT + me.id, o, true);
    }

    // host: keep a signed snapshot of recent chat + mute/ban lists as a retained message
    let histTimer = 0;
    function scheduleHist() { clearTimeout(histTimer); histTimer = setTimeout(publishHist, 2500); }
    async function publishHist() {
      if (!hostKey) return;
      const items = st.items.filter(m => !st.deleted.has(m.id)).slice(-60);
      const o = await signAs(hostKey, { t: "hist", ts: Date.now(), items, mutedA: [...st.mutedA], bannedA: [...st.bannedA], deleted: [...st.deleted].slice(-300), lock: st.locked });
      st.histTs = o.ts;
      send(T_HIST, o, true);
    }
    if (hostKey) setInterval(publishHist, 60000);

    let lastSend = 0;
    return {
      view, accounts,
      async say(text) {
        if (Date.now() - lastSend < 1500) return { error: "slow" };
        if (hostKey) {
          const x = clean(text, TEXT_MAX * 2); if (!x) return { error: "empty" };
          lastSend = Date.now();
          const o = await signAs(hostKey, { t: "h", id: newId(), x, ts: Date.now() });
          add({ t: "h", id: o.id, x: o.x, ts: o.ts, sig: o.sig }); changed();
          return send(T_LIVE, o) ? {} : { error: "offline" };
        }
        if (!me || !myKey) return { error: "account" };
        const x = clean(text, TEXT_MAX); if (!x) return { error: "empty" };
        if (st.bannedA.has(me.id)) return { error: "banned" };
        if (st.mutedA.has(me.id)) return { error: "muted" };
        if (st.locked) return { error: "locked" };
        lastSend = Date.now();
        const o = await signAs(myKey, { t: "m", id: newId(), n: me.name, x, ts: Date.now(), a: me.id, k: me.pub });
        add(Object.assign({}, o)); changed(); register();
        return send(T_LIVE, o) ? {} : { error: "offline" };
      },
      async mod(action, arg) {
        if (!hostKey) return;
        const o = { t: action, ts: Date.now() };
        if (action === "del") { o.id = String(arg); st.deleted.add(o.id); }
        else if (["mute", "unmute", "ban", "unban"].includes(action)) {
          o.a = String(arg);
          if (action === "mute") st.mutedA.add(o.a); else if (action === "unmute") st.mutedA.delete(o.a);
          else if (action === "ban") st.bannedA.add(o.a); else st.bannedA.delete(o.a);
        }
        else if (action === "lock") { o.on = !!arg; st.locked = !!arg; }
        else if (action === "clear") st.items.forEach(m => st.deleted.add(m.id));
        send(T_LIVE, await signAs(hostKey, o)); changed(); publishHist();
      },
      setAccount: async a => { me = a; myKey = a ? await Account.signer(a) : null; lastReg = 0; register(); changed(); },
      seedAccounts(list) { (list || []).forEach(a => { if (a && a.id && /^u[A-Za-z0-9_-]{12}$/.test(a.id)) touchAccount(a.id, clean(a.name, NAME_MAX), a.pub, a.lastSeen || 0, { created: a.created }); }); changed(); },
      close() { clients.forEach(c => { c.closed = true; try { c.ws.close(); } catch (_) {} }); },
    };
  }

  // ---------- talk-to-text (browser speech recognition) ----------
  // Fills the box with what you say; you still press Send, so nothing goes out by accident.
  function dictate(input, button, onNote) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR || !input || !button) { if (button) button.hidden = true; return null; }
    let rec = null, listening = false, base = "";
    const setUI = on => {
      listening = on; button.classList.toggle("listening", on);
      button.setAttribute("aria-pressed", String(on));
      button.setAttribute("aria-label", on ? "Stop talking" : "Talk to type");
      button.title = on ? "Listening… tap to stop" : "Talk to type";
    };
    function stop() { if (rec) { try { rec.stop(); } catch (_) {} } }
    button.addEventListener("click", () => {
      if (listening) return stop();
      rec = new SR();
      rec.lang = navigator.language || "en-US";
      rec.interimResults = true; rec.continuous = false; rec.maxAlternatives = 1;
      base = input.value ? input.value.replace(/\s*$/, " ") : "";
      rec.onresult = e => {
        let text = "";
        for (let i = 0; i < e.results.length; i++) text += e.results[i][0].transcript;
        input.value = (base + text).slice(0, input.maxLength > 0 ? input.maxLength : 400);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      };
      rec.onerror = e => {
        const m = e.error === "not-allowed" || e.error === "service-not-allowed" ? "Allow the microphone to talk to type."
          : e.error === "no-speech" ? "Didn't catch that. Tap the mic and try again."
          : e.error === "network" ? "Talk-to-type needs an internet connection." : "";
        if (m && onNote) onNote(m);
      };
      rec.onend = () => { setUI(false); input.focus(); };
      try { rec.start(); setUI(true); if (onNote) onNote("Listening… talk now, then hit Send."); }
      catch (_) { setUI(false); }
    });
    setUI(false); button.hidden = false;
    return { stop };
  }

  window.BamChat = { createChat, Account, NAME_MAX, TEXT_MAX, reserved, validName, dictate };
})();
