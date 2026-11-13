# Bam Bam Reviews

Website for **Bam Bam Reviews**, a podcast reviewing cannabis products: flower, edibles, vapes, glass and accessories. For adults 21+ only.

**Live site:** https://harleyloft47-king.github.io/bam-bam-reviews-play/

## What's on the site

- **21+ age check**: month/day/year pickers; remembers verified visitors for 30 days
- **Header**: BAM BAM title with the caveman mascot art (`mascot.webp`)
- **Latest episode**: spoken intro ("Wham bam, let's smoke a couple grams...")
- **Tune in**: live show and radio schedules with countdowns and an automatic LIVE NOW badge
  - Live: Mon / Wed / Fri, 8–9 PM, plus every other Saturday 7–9 PM (starting Nov 14, 2026)
  - Radio: Tue / Thu / Sun, 9–10 PM, plus the alternate Saturdays 7–9 PM (starting Nov 21, 2026)
  - Times are set in UTC-7 and shown in each visitor's own time zone
- **Reviews**: cards rated 1–5 on the Bam Scale, filterable by category
- **Hosts** and **Send us gear** pitch form

## Admin

The admin is a claude.ai page, **Bam Bam Admin** (https://claude.ai/artifact/T5AUXh92bcsSRFR4CXAyfM).
Only the owner's Claude account can open and edit it. It stores the site content and review photos in the page's
own database. A scheduled task copies saved changes into this repository (`content.json` and `photos/`) every hour,
and GitHub Pages then updates the site.

- **Reviews**: add, edit, delete, up to 4 photos each, Bam rating
- **Live & Radio**: weekly show times, every-other-week specials, stream and station links, time zone
- **Site info**: latest episode, Spotify / Apple / RSS links, hosts

## Two versions of the same file

`index.html` runs in two places and adapts to each:

| | claude.ai artifact | GitHub Pages (bam-bam-reviews-play) |
| --- | --- | --- |
| Reviews | Saved in the artifact's database; hosts add, delete and attach photos on the page | From `content.json` (synced from Bam Bam Admin) |
| Spoken intro | Claude voice | `intro.mp3` (TTSMaker "Ethan" voice), falling back to the browser voice |
| Sign-in needed | Yes, for reviews and voice | No |


## Still placeholder

- Spotify / Apple Podcasts / RSS links
- YouTube live link and the 101.9 FM radio station
- Host names and bios
- The pitch form doesn't send anywhere yet
