# MARS

A real-time, scroll-driven introduction to open models that master one workflow.

Built with Vite, TypeScript, Three.js and GSAP. No video footage.

## Run

Use Node24 (`source ~/.nvm/nvm.sh && nvm use 24`), then `npm install` and `npm run dev`.
The install step downloads the two Fontshare fonts from their official source;
see [FONTS.md](FONTS.md) for licenses and repository restrictions.

Review states: `?frame=intro`, `rest`, `mid`, `full`, `close`, `beauty`.

`/how` is the loop in depth: one chapter per pass beside the same planet (`src/how.ts`, `how.html`). Review states: `/how?frame=loop`, `observe`, `evaluate`, `refine`, `ascend`.
Type specimen: `/specimen.html`. `shots/` is intentionally gitignored.

`npm run build` and `npx tsc --noEmit` check the production bundle/types.
With the server on5173 and Chromium CDP on29229, `npm test` verifies the
frame/phase scaffold, form validation, reduced motion, WebGL fallback and mobile
overflow. `node scripts/capture.mjs` writes approval screenshots to `shots/`.

## Milestone 2: one planet, five passes

Design language after guillaumecolombel.fr: black page, corner-only UI, one
irregular Mars body that never cuts away. Scrolling opens render-pass windows
over it (wireframe, uv "observe", normals "evaluate", transmission "refine",
beauty), each a GL scissor region aligned with its DOM frame, then the windows
fold away and the finished planet remains above the waitlist. A hairline
silhouette comes from a mask render target; the intro sweeps it in and densifies
the wireframe. Pointer light, live grain, a cursor dot and scroll-velocity spin
are the only decoration. DPR ≤ 1.5 and a 2.4MP budget; rendering pauses in hidden tabs;
reduced motion skips the intro. The sound toggle plays a generated drone (off by default).

The email form is a demo: native validation and an explicit non-persistent success
message. It stores/sends nothing. The endpoint TODO is in `src/main.ts`.
Vercel builds every branch from GitHub (project `mars`); previews sit behind Vercel Deployment Protection until it is switched off.
`About` opens a window in the same panel style; `Waitlist` jumps to the end.
