# MARS site handoff

Public marketing site for MARS (an open model that masters one workflow). Vite 7 + TypeScript 5.9 + Three.js 0.180 +
GSAP 3.13 + Lenis; no video, everything is rendered live in WebGL. Deployed on Vercel (project `mars`, `cleanUrls`), every
branch gets a preview. This file covers the site state, the /how landscape decision and what is still open.

## 1. Site state

Pages (two Vite entries, `index.html` and `how.html`; a dev middleware in `vite.config.ts` maps `/how` to `how.html`):

- `/` home: one irregular Mars body with the MARS wordmark; scrolling opens render-pass windows (wireframe, observe,
  evaluate, refine, beauty) as GL scissor regions aligned with DOM frames, then the planet settles above the waitlist.
  Code: `src/main.ts` (page), `src/scene.ts` (`MarsScene`), `src/geometry.ts`, `src/shaders.ts`, `src/audio.ts`.
- `/how` the loop: a fractured Martian stele over a fog-tinted plain, a bottom title carousel with five moves (the loop,
  observe, evaluate, refine, ascend), 90 degrees of camera orbit per move (a full 360 over the four turns), click/tap to
  open the stone onto the move's live render pass, a rewind control on ascend, sound toggle, HINTS line.
  Code: `src/how.ts` (page), `src/how/world.ts` (`HowWorld`), `stele.ts`, `carousel.ts`, `passes.ts` (`LivePasses`),
  `landscape.ts` + `landscapeShaders.ts`. `src/how/scorer.ts` is not imported anywhere on `main` (left over from v4).
- `/specimen.html` type specimen (static, in `public/`).

Run and verify (Node 24 via nvm; `package.json` pins `>=24 <25`):

    source ~/.nvm/nvm.sh && nvm use 24
    npm install            # postinstall (scripts/fonts.mjs) downloads the two Fontshare fonts, needs network
    npm run dev            # Vite on 0.0.0.0:5173
    npx tsc --noEmit       # types only; `npm run build` already runs tsc --noEmit before `vite build`
    npm run build          # production bundle in dist/ (gitignored)
    npm test               # scripts/verify.mjs + scripts/howcheck.mjs: needs the dev server on 5173 AND a Chromium with CDP on 29229, plus python3 + PIL

`npm test` runs the home checks (frames rest/mid/beauty and panel counts, canvas within the 2.4 MP budget, hidpi scissor
alignment at DPR 2, unknown frame fallback, intro, waitlist form, sound, about, captions, reduced motion, 390 px overflow,
WebGL fallback, zero console/HTTP errors) and then `scripts/howcheck.mjs` for `/how` (the five frames and the unknown-name
fallback, a tap on the landscape does not open the stele while a tap on the stele does, Escape closes, canvas within the
tier budget at DPR 1 and 2, reduced motion, WebGL fallback, 390 px overflow, zero console/page errors). `node scripts/capture.mjs` writes approval
screenshots to `shots/` (gitignored). Verified on this checkout: `npm install`, `npx tsc --noEmit` and `npm run build` pass.

Review URLs (checked against the code, the README is partly stale):

- Home: `/?frame=intro|rest|mid|full|close|beauty` (`frames` map in `src/main.ts`; unknown names fall back to rest).
- Home: `/?tier=full|mid|lite` forces a quality tier (`detectTier` reads it). Not documented in the README.
- /how: `/how?frame=<move label>` where the labels are `the loop`, `observe`, `evaluate`, `refine`, `ascend`; add `&open=1`
  to open the stone. `frame=loop` (as the README says) does not match any label and only lands on the loop because the
  unmatched index falls back to 0. `&demo=1` does nothing: no `demo` parameter exists in `src/`; the README's /how
  paragraph (typed task, latency drag, trace upload, `Scorer`) describes the v4 page, not the v5 stele page on `main`.

Performance budget (home page, `src/scene.ts`):

- `TIERS`: full = DPR cap 1.5, 2.4 MP pixel budget, detail 36, wire 260, bake 2048; mid = 1.25, 1.8 MP, 26, 200, 1536;
  lite = 1.0, 1.2 MP, 18, 140, 1024. Effective DPR = min(devicePixelRatio, cap, sqrt(budget / (w*h))).
- `detectTier`: `?tier=` override; software GL (SwiftShader/llvmpipe/softpipe) -> lite; `innerWidth < 700` or Intel HD/UHD
  4xx-6xx, Mali-G/T, Adreno 1xx-5xx -> mid; otherwise full. The result is exposed as `body.dataset.tier`.
- Rendering pauses in hidden tabs (`visibilitychange` removes the gsap ticker); reduced motion skips the intro and does not
  start Lenis or the ticker at all (the page is static); WebGL failure or `webglcontextlost` hides the canvas and shows the
  `#fallback` SVG outline with the form, `body.dataset.renderer = 'fallback'`.
- `/how` on `main` does NOT use the tiers: `HowWorld.resize` caps DPR at 2 (1.5 under 700 px) with no pixel budget, and the
  rAF loop keeps running in hidden tabs. It has the same `#fallback` path and a reduced-motion path (zero durations, stone
  pre-formed, no crack sound). The tier integration below changes the first two points.

## 2. The /how landscape decision

Facts as handed over from the integration session:

- The unmerged branches `devin/v5-landscape` (integration), `devin/v5-landscape-ground`, `-sky`, `-colony`, `-flora` built a
  Martian landscape behind the /how stele: `src/how/landscape{,Ground,GroundRelief,Kit,Sky,Colony,Flora,Terrain,Shaders}.ts`,
  about 2.9k lines, replacing the 240-line `landscape.ts` + `landscapeShaders.ts` on `main`. All five branch off `cb37a87`,
  before the orbit-360, loopback, how-copy and SECURITY_MODEL merges on `main`.
- `v5-landscape` already contained the sky and colony work. `v5-landscape-ground` carried the flora merge plus newer ground
  detail (boulders, outcrops, pads, rovers, antenna farms) and was NOT in `v5-landscape`.
- The union (`v5-landscape` + `v5-landscape-ground`) was merged onto current `main` as one branch. Everything that is not
  the landscape itself (stele, carousel, 360 orbit, rewind, sound toggle, HINTS line, copy) is kept exactly as on `main`.
- `devin/v5-passes` and `devin/v5-carousel` are abandoned alternatives and were ignored.

Integration changes made on top of the union:

- `FOG` colours moved to `src/how/landscapeTerrain.ts` (removes a module cycle).
- The landscape's colonisation `stage` now follows the carousel position: barren at the loop move, fully settled at ascend.
- `HowWorld` now uses the home page's quality tiers (`TIERS` / `detectTier`, exported from `src/scene.ts`; on `main` they are
  still module-private) for the DPR cap and pixel budget, and exposes `body.dataset.tier` on /how too.
- `lite`: coarser terrain grid, single-pass hairlines, no flora/dust/plumes, and a `LITE` shader define that skips per-pixel
  regolith and sky-layer noise. `mid`: drops the extra hairline passes and the flora's weather (motes, dust devils, mist,
  meteor). `full`: everything.
- `/how` now also skips `world.render` while the tab is hidden, like the home page.
- Phones share the sparse set regardless of tier (coarser grid, half the boulders at 180 tris, no ground dust/plumes) and keep
  the mid/full shaders and flora.
- Measured frame times (software GL on the integration VM, `node scripts/howshots.mjs <port> <tag>` with `TIER=`; only
  comparable to each other, not to real hardware): `main` /how 131-134 ms/frame at 1440x900 and 46 ms at 390x844; this
  branch on `lite` 160-330 ms (1.2-2.5x, canvas capped at 1385x866 by the 1.2 MP budget) and 68-125 ms (1.5-2.7x); `mid` on the phone viewport 109-142 ms; `full` at 1440x900
  430-590 ms (the full tier is never selected on software GL).

## 3. What remains

- Tune the lite/mid cut-offs on real low-end hardware; measurements so far are software-GL only. Phones get `mid`
  (`innerWidth < 700`), which keeps the flora: check it on a mid-range Android before relying on it.
- Art pass on hairline density near the stele.
- Consider lazy-building the flora after first paint.
- Delete the old `devin/v5-landscape*` branches (and `v5-passes`, `v5-carousel`, `v5-stele` if nobody needs them) once the
  PR merges.

Observations from reading `main` (mine, not from the integration session):

- README drift: the /how paragraph describes v4 (`&demo=1`, typed inputs, `Scorer`); `frame=loop` should read `the loop`;
  `&open=1` and `?tier=` are undocumented; the test description implies /how coverage that does not exist.
- `npm install` with Node 24.19's bundled npm 10.8.3 rewrites `package-lock.json` (drops `libc` fields written by a newer
  npm). Use `npm ci` or revert the lockfile before committing.
- `scripts/verify.mjs` shells out to `python3` with PIL for the hidpi probe; that dependency is not mentioned anywhere.
- `src/how/scorer.ts` is dead code on `main`; delete it or wire it back when the API exists.
