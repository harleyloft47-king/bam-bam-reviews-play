/* Bam Bam live chat engine.
 *
 * Messages travel over free public MQTT brokers (WebSocket). We connect to two brokers at once and
 * de-duplicate, so chat keeps working if one is down. Anyone can post as a viewer; only the host's
 * messages and moderation (delete, mute, pause) are signed with the host's private key, and every
 * client checks that signature against the public key in content.json before trusting them.
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
      ws.onopen = () => {
        const id = "bb" + Math.random().toString(36).slice(2, 12);
        ws.send(packet(0x10, [...str("MQTT"), 4, 0x02, 0, 60, ...str(id)]));
      };
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
      if (kind === 2) { // CONNACK
        if (body[1] !== 0) return;
        this.up = true; this.retry = 1000; this.onState();
        this.subs.forEach(t => this.sendSub(t));
        clearInterval(this.ping); this.ping = setInterval(() => this.raw(new Uint8Array([0xC0, 0])), 30000);
      } else if (kind === 3) { // PUBLISH
        const qos = (type >> 1) & 3;
        const tl = (body[0] << 8) | body[1];
        const topic = dec.decode(body.slice(2, 2 + tl));
        const payload = body.slice(2 + tl + (qos ? 2 : 0));
        try { this.onMessage(topic, dec.decode(payload)); } catch (_) {}
      }
    }
    raw(p) { if (this.ws && this.ws.readyState === 1) this.ws.send(p); }
    sendSub(topic) { const id = this.pid++ & 0xffff || 1; this.raw(packet(0x82, [id >> 8, id & 255, ...str(topic), 0])); }
    subscribe(topic) { this.subs.add(topic); if (this.up) this.sendSub(topic); }
    publish(topic, text, retain) { if (!this.up) return false; this.raw(packet(0x30 | (retain ? 1 : 0), [...str(topic), ...enc.encode(text)])); return true; }
  }

  // ---------- signatures (ECDSA P-256) ----------
  const ALG = { name: "ECDSA", namedCurve: "P-256" }, SIGN = { name: "ECDSA", hash: "SHA-256" };
  const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const unb64u = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), c => c.charCodeAt(0));
  function body(o) { const c = Object.assign({}, o); delete c.sig; return JSON.stringify(c); }

  // ---------- chat room ----------
  const NAME_MAX = 24, TEXT_MAX = 200, KEEP = 150;
  const clean = (s, n) => String(s == null ? "" : s).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, n);

  async function createChat(cfg) {
    // cfg: {room, pub:{x,y}, privD?, onUpdate(state)}
    if (!cfg || !/^[A-Za-z0-9_-]{6,40}$/.test(cfg.room || "") || !cfg.pub || !cfg.pub.x || !cfg.pub.y) return null;
    if (!window.crypto || !crypto.subtle || typeof WebSocket === "undefined") return null;
    const base = "bambamchat/" + cfg.room;
    const T_LIVE = base + "/live", T_HIST = base + "/hist";
    const pubKey = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: cfg.pub.x, y: cfg.pub.y, ext: true }, ALG, false, ["verify"]);
    let privKey = null;
    if (cfg.privD) {
      try { privKey = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: cfg.pub.x, y: cfg.pub.y, d: cfg.privD, ext: true }, ALG, false, ["sign"]); }
      catch (_) { privKey = null; }
    }
    const st = { items: [], byId: new Map(), muted: new Set(), deleted: new Set(), locked: false, online: 0, isHost: !!privKey, histTs: 0 };
    const seen = new Set();

    async function verify(o) {
      if (typeof o.sig !== "string") return false;
      try { return await crypto.subtle.verify(SIGN, pubKey, unb64u(o.sig), enc.encode(body(o))); } catch (_) { return false; }
    }
    async function sign(o) { o.sig = b64u(await crypto.subtle.sign(SIGN, privKey, enc.encode(body(o)))); return o; }

    function add(m) {
      if (st.byId.has(m.id)) return;
      st.byId.set(m.id, m); st.items.push(m);
      st.items.sort((a, b) => a.ts - b.ts);
      while (st.items.length > KEEP) st.byId.delete(st.items.shift().id);
    }
    let pending = 0;
    function changed() { clearTimeout(pending); pending = setTimeout(() => cfg.onUpdate && cfg.onUpdate(view()), 30); if (st.isHost) scheduleHist(); }
    function view() {
      return {
        locked: st.locked, isHost: st.isHost, connected: clients.some(c => c.up),
        messages: st.items.filter(m => !st.deleted.has(m.id) && !(m.t === "m" && st.muted.has(m.n.toLowerCase()))),
        muted: [...st.muted],
      };
    }

    async function onRaw(topic, text) {
      if (text.length > 20000) return;
      let o; try { o = JSON.parse(text); } catch (_) { return; }
      if (!o || typeof o !== "object") return;
      if (topic === T_HIST) {
        if (o.t !== "hist" || !(await verify(o)) || o.ts <= st.histTs) return;
        st.histTs = o.ts;
        (o.muted || []).forEach(n => st.muted.add(String(n).toLowerCase()));
        (o.deleted || []).forEach(id => st.deleted.add(String(id)));
        st.locked = !!o.lock;
        for (const m of (o.items || [])) {
          if (m.t === "m") { const v = viewerMsg(m); if (v) add(v); }
          else if (m.t === "h" && await verify(m)) add({ t: "h", id: m.id, x: clean(m.x, TEXT_MAX * 2), ts: m.ts, sig: m.sig });
        }
        return changed();
      }
      if (topic !== T_LIVE) return;
      const key = o.t + ":" + (o.id || o.n || "") + ":" + o.ts;
      if (seen.has(key)) return; seen.add(key); if (seen.size > 2000) seen.clear();
      if (o.t === "m") { const v = viewerMsg(o); if (v) { add(v); changed(); } return; }
      if (!(await verify(o))) return; // host-only actions below
      if (o.t === "h") add({ t: "h", id: String(o.id), x: clean(o.x, TEXT_MAX * 2), ts: o.ts, sig: o.sig });
      else if (o.t === "del") st.deleted.add(String(o.id));
      else if (o.t === "mute") st.muted.add(String(o.n).toLowerCase());
      else if (o.t === "unmute") st.muted.delete(String(o.n).toLowerCase());
      else if (o.t === "lock") st.locked = !!o.on;
      else if (o.t === "clear") { st.items.forEach(m => st.deleted.add(m.id)); }
      changed();
    }
    function viewerMsg(o) {
      const n = clean(o.n, NAME_MAX), x = clean(o.x, TEXT_MAX), id = clean(o.id, 40);
      if (!n || !x || !/^[A-Za-z0-9_-]{6,40}$/.test(id) || typeof o.ts !== "number") return null;
      return { t: "m", id, n, x, ts: o.ts };
    }

    const clients = BROKERS.map(url => new Mini(url, onRaw, () => changed()));
    clients.forEach(c => { c.subscribe(T_LIVE); c.subscribe(T_HIST); });
    const send = (topic, obj, retain) => { const s = JSON.stringify(obj); let ok = false; clients.forEach(c => { ok = c.publish(topic, s, retain) || ok; }); return ok; };
    const newId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

    // host keeps a signed snapshot of recent chat as a retained message, so newcomers see history
    let histTimer = 0;
    function scheduleHist() { clearTimeout(histTimer); histTimer = setTimeout(publishHist, 2500); }
    async function publishHist() {
      if (!privKey) return;
      const items = st.items.filter(m => !st.deleted.has(m.id)).slice(-60).map(m => m.t === "h" ? { t: "h", id: m.id, x: m.x, ts: m.ts, sig: m.sig } : m);
      const o = await sign({ t: "hist", ts: Date.now(), items, muted: [...st.muted], deleted: [...st.deleted].slice(-300), lock: st.locked });
      st.histTs = o.ts;
      send(T_HIST, o, true);
    }
    if (privKey) setInterval(publishHist, 60000);

    let lastSend = 0;
    const api = {
      view,
      async say(name, text) {
        const n = clean(name, NAME_MAX), x = clean(text, TEXT_MAX);
        if (!x) return { error: "empty" };
        if (st.locked && !privKey) return { error: "locked" };
        if (Date.now() - lastSend < 1500) return { error: "slow" };
        lastSend = Date.now();
        if (privKey) {
          const o = await sign({ t: "h", id: newId(), x: clean(text, TEXT_MAX * 2), ts: Date.now() });
          add({ t: "h", id: o.id, x: o.x, ts: o.ts, sig: o.sig }); changed();
          return send(T_LIVE, o) ? {} : { error: "offline" };
        }
        if (!n) return { error: "name" };
        if (st.muted.has(n.toLowerCase())) return { error: "muted" };
        const o = { t: "m", id: newId(), n, x, ts: Date.now() };
        add(o); changed();
        return send(T_LIVE, o) ? {} : { error: "offline" };
      },
      async mod(action, arg) {
        if (!privKey) return;
        const o = { t: action, ts: Date.now() };
        if (action === "del") { o.id = arg; st.deleted.add(arg); }
        else if (action === "mute" || action === "unmute") { o.n = arg; action === "mute" ? st.muted.add(arg.toLowerCase()) : st.muted.delete(arg.toLowerCase()); }
        else if (action === "lock") { o.on = !!arg; st.locked = !!arg; }
        else if (action === "clear") { st.items.forEach(m => st.deleted.add(m.id)); }
        send(T_LIVE, await sign(o)); changed(); publishHist();
      },
      close() { clients.forEach(c => { c.closed = true; try { c.ws.close(); } catch (_) {} }); },
    };
    return api;
  }

  window.BamChat = { createChat, NAME_MAX, TEXT_MAX, reserved: n => /bam\s*bam|host|admin|moderator|^mod$/i.test(n) };
})();
