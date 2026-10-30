# Type study 01

All fonts are served as local WOFF2 files. No Google Fonts or runtime font API.
Approval specimen: `/specimen.html`; screenshot `shots/font-specimen.png`.

| Role | Face | Source | License / web embedding |
|---|---|---|---|
| Display / wordmark | Switzer Medium 500, Indian Type Foundry | https://www.fontshare.com/fonts/switzer | ITF Free Font License v2.0 (17 Aug 2026), §01 explicitly permits commercial websites and self-hosted CSS @font-face |
| /how typing field | Switzer Variable (wght 100–900), Indian Type Foundry — weight follows typing speed, after Pangram Pangram's axis-driven specimens | https://www.fontshare.com/fonts/switzer | same ITF FFL v2.0 |
| Body | General Sans Regular 400, Indian Type Foundry | https://www.fontshare.com/fonts/general-sans | Same ITF Free Font License, commercial web embedding permitted |
| Labels | Commit Mono Regular 400 (variable source v1.43), Eigil Nikolajsen | https://uncut.wtf/monospace/commit-mono/ → https://commitmono.com/ | SIL Open Font License 1.1; commercial use, web embedding and redistribution with license permitted |

Switzer provides a quiet, precise grotesk rather than a novelty sci-fi face. General Sans softens longer technical copy; Commit Mono keeps telemetry understated. Only one weight per role is used. No font files have been modified, subsetted or converted.

Full licenses are retained in `public/licenses/Fontshare-FFL.txt` and `public/licenses/CommitMono-OFL.txt`. The Fontshare license was obtained inside the official Switzer download ZIP at `https://api.fontshare.com/v2/fonts/download/switzer`. Commit Mono is from the upstream `src/fonts/fontlab/CommitMonoV143-VF.woff2` with its upstream LICENSE-FONT.

**Redistribution:** Fontshare §02 prohibits redistribution through repositories, despite allowing self-hosting for the licensee's site. Therefore the two Fontshare binaries are gitignored. `npm install` runs `scripts/fonts.mjs` to acquire unmodified WOFF2 directly from Fontshare for the site operator; an internet connection is required at setup. They are then served locally from `public/fonts`, not fetched by visitors from Fontshare. Commit Mono can be committed under OFL with its license. Anyone working independently with the Fontshare fonts should obtain their own official copies and review that license.
