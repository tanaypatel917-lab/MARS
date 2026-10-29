# MARS

A real-time, scroll-driven introduction to open models that master one workflow.

Built with Vite, TypeScript, Three.js and GSAP. No video footage.

## Run

Use Node24 (`source ~/.nvm/nvm.sh && nvm use 24`), then `npm install` and `npm run dev`.
The install step downloads the two Fontshare fonts from their official source;
see [FONTS.md](FONTS.md) for licenses and repository restrictions.

Approval views: `?frame=orbit`, `?frame=loop`, `?frame=arrival`.
Type specimen: `/specimen.html`. `shots/` is intentionally gitignored.

`npm run build` and `npx tsc --noEmit` check the production bundle/types.
With the server on5173 and Chromium CDP on29229, `npm test` verifies the
frame/phase scaffold, form validation, reduced motion, WebGL fallback and mobile
overflow. `node scripts/capture.mjs` writes approval screenshots to `shots/`.

## Milestone 1

Orbit, Loop and Arrival are art-direction approval frames. Launch/Approach remain
rough transitions. One renderer/camera, one normalized ScrollTrigger state,
instanced ring particles and procedural planet/terrain; no external model assets.
DPR≤1.5 and2.2MP budget; bloom at half resolution, grain/vignette final pass.
Rendering pauses in hidden tabs; reduced motion renders one static state per chapter.
Ambient audio is reserved in `#sound-slot` only; no audio is loaded or played.

The email form is a demo: native validation and an explicit non-persistent success
message. It stores/sends nothing. The endpoint TODO is in `src/main.ts`.
No deployment is configured at this milestone.
