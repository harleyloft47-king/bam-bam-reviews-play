# Bam Bam Reviews

Website for **Bam Bam Reviews**, a podcast reviewing cannabis products: flower, edibles, vapes, glass and accessories. For adults 21+ only.

## What's on the site

- **21+ age check**: month/day/year pickers; remembers verified visitors for 30 days
- **Header**: BAM BAM title with the caveman mascot art (`mascot.webp`)
- **Latest episode**: spoken intro ("Wham bam, let's smoke a couple grams...")
- **Tune in**: live show and radio schedules with countdowns and an automatic LIVE NOW badge
  - Live: Mon / Wed / Fri, 8–9 PM, plus every other Saturday 7–9 PM (starting Nov 14, 2026)
  - Radio: Tue / Thu / Sun, 9–10 PM, plus the alternate Saturdays 7–9 PM (starting Nov 21, 2026)
  - Times are set in UTC-7 and shown in each visitor's own time zone
- **Reviews**: cards rated 1–5 on the Bam Scale, filterable by category, with add (including up to 4 photos) and delete for the hosts
- **Hosts** and **Send us gear** pitch form

## Files

| File | What it is |
| --- | --- |
| `index.html` | The whole site: markup, styles and script in one file |
| `mascot.webp` | Header artwork |

## Hosting notes

The site was built to run as a Claude artifact. Two features use platform services that only exist there:

- **Saving reviews** (add/delete) uses the artifact's built-in database, and **review photos** use its file storage.
- **The spoken intro** uses Claude's text-to-speech voice.

If you host `index.html` somewhere else (GitHub Pages, Netlify, your own domain), the rest of the site works as-is, but those two parts need replacing: reviews with a small backend or a hosted database, and the intro with a recorded audio file.

## Still placeholder

- Spotify / Apple Podcasts / RSS links
- YouTube live link and the 101.9 FM radio station
- Host names and bios
- The pitch form doesn't send anywhere yet
