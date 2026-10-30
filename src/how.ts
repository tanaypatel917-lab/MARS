import './style.css';
import './how/carousel.css';
import './how/how.css';
import gsap from 'gsap';
import { CustomEase } from 'gsap/CustomEase';
import * as THREE from 'three';
import { HowWorld, type Hit, type WorldState } from './how/world';
import { Carousel } from './how/carousel';
import { FOG } from './how/landscape';
import type { PassIndex } from './how/passes';
import { Ambient } from './audio';

gsap.registerPlugin(CustomEase);
const lusion = CustomEase.create('lusion', '0.35, 0, 0, 1');
const osmo = CustomEase.create('osmo', '0.625, 0.05, 0, 1');
const select = <T extends Element = HTMLElement>(selector: string, root: ParentNode = document) => {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`Missing element: ${selector}`);
  return element;
};
/** Lusion's SecondOrderDynamics (f, ζ, r): frame-rate independent smoothing with a little overshoot. */
class Dynamics {
  private y: number; private yd = 0; private xp: number;
  private readonly k1: number; private readonly k2: number; private readonly k3: number;
  constructor(x0: number, f = 1.5, zeta = .8, r = 2) { this.y = x0; this.xp = x0; this.k1 = zeta / (Math.PI * f); this.k2 = 1 / ((2 * Math.PI * f) ** 2); this.k3 = r * zeta / (2 * Math.PI * f); }
  update(dt: number, x: number) {
    if (dt <= 0) return this.y;
    const xd = (x - this.xp) / dt; this.xp = x;
    const k2 = Math.max(this.k2, dt * dt / 2 + dt * this.k1 / 2, dt * this.k1);
    this.y += dt * this.yd; this.yd += dt * (x + this.k3 * xd - this.y - this.k1 * this.yd) / k2;
    return this.y;
  }
  get value() { return this.y; }
}

interface Move { title: string; label: string; body: string; meta: string }
const MOVES: Move[] = [
  { title: 'THE\nLOOP', label: 'the loop', body: 'One open-weights model, pointed at the tasks your team already runs. Four moves — observe, evaluate, refine, ascend — repeated until day 100 beats day 1.', meta: 'inside the stone: the model as it ships today' },
  { title: 'OBSERVE', label: 'observe', body: 'Every run of your workflow becomes a trace: the input, the tool calls, the output, the latency. Collected where the work already happens, kept on your machines.', meta: '2 000 traces · a drop-in SDK or a local proxy' },
  { title: 'EVALUATE', label: 'evaluate', body: 'Evals are code you write once and run on every output: right shape, matches the reference, within budget. What passes collects; what fails falls away.', meta: 'pass 0 720 / 1 000 · deterministic checks' },
  { title: 'REFINE', label: 'refine', body: 'A low-rank adapter is trained on what passed — on hardware you own, inside a time and memory envelope you set. The weights grow where the passes landed.', meta: '04h 12m · 19.4 GB · one 24 GB GPU' },
  { title: 'ASCEND', label: 'ascend', body: 'The candidate meets the incumbent on a held-out set. It ships only if it wins; otherwise it is discarded and the loop goes again. Rollback is one commit.', meta: 'candidate 77 % vs incumbent 58 % · shipped' },
];
const HINTS = ['scroll to turn · hover the stone · click to open', 'scroll to turn · click to open', 'click to open', 'click to open', 'click to open'];

const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const fine = matchMedia('(pointer: fine)').matches;
const mobile = innerWidth < 700;
const params = new URLSearchParams(location.search);
const canvas = select<HTMLCanvasElement>('#scene');
const cursor = select('#cursor');
const hint = select('#hint');
const closeButton = select<HTMLButtonElement>('#close');
const links = select('header .links');
const prevButton = select<HTMLButtonElement>('.arrow.prev');
const nextButton = select<HTMLButtonElement>('.arrow.next');
const detail = select('#detail');
const detailIndex = select('#detail-index'), detailMove = select('#detail-move'), detailBody = select('#detail-body'), detailMeta = select('#detail-meta');
const body = document.body;
const soundButton = select<HTMLButtonElement>('#sound');
const wave = soundButton.querySelector<HTMLCanvasElement>('.wav')!.getContext('2d')!;
const ambient = new Ambient();
let gestured = false;
const d = (seconds: number) => reduced ? 0 : seconds;

let world: HowWorld | null = null;
try { world = new HowWorld(canvas, mobile); } catch (error) { console.warn('WebGL unavailable', error); select('#fallback').hidden = false; }
body.dataset.renderer = world ? 'ready' : 'fallback';
body.dataset.intro = 'done';
body.dataset.ui = 'on';

const carousel = new Carousel(select('#carousel'), MOVES.map(m => m.title), { reducedMotion: reduced });
const state: WorldState = {
  time: 0, position: 0, pass: 0, blend: 1, pointer: { x: 0, y: 0 }, tilt: { x: 0, y: 0 },
  facet: -1, lift: 0, explode: 0, reveal: 0, core: 0, fade: 1, spawn: reduced ? 0 : 1,
};
// the stone forms out of the dust on arrival (home's spawn cut), never pops in
gsap.to(state, { spawn: 0, duration: d(2.4), ease: 'power2.inOut', delay: d(.3) });
const tiltX = new Dynamics(0, 1.2, .75), tiltY = new Dynamics(0, 1.2, .75);
const fog = new THREE.Color(FOG[0]);
if (world) world.landscape.fog.copy(fog);
let open = false, hit: Hit | null = null, lastMove = -1;
let openTimeline: gsap.core.Timeline | undefined;
const pointer = { x: innerWidth / 2, y: innerHeight / 2, nx: 0, ny: 0, moved: false };

/** Text for the current move; swaps with a short fade while open. */
const describe = (i: number) => {
  const move = MOVES[i];
  detailIndex.textContent = i === 0 ? 'iter 000' : `iter 00${i}`;
  detailMove.textContent = move.label;
  detailBody.textContent = move.body;
  detailMeta.textContent = move.meta;
  hint.textContent = HINTS[i];
};
const retint = (i: number) => {
  gsap.to(fog, { r: new THREE.Color(FOG[i]).r, g: new THREE.Color(FOG[i]).g, b: new THREE.Color(FOG[i]).b, duration: d(1.1), ease: lusion, overwrite: true,
    onUpdate: () => { world?.landscape.fog.copy(fog); } });
};
const onMove = (i: number) => {
  if (i === lastMove) return;
  const previous = lastMove; lastMove = i;
  retint(i);
  if (world && open && previous >= 0) {
    world.passes.setPrevious(previous as PassIndex);
    state.pass = i as PassIndex; state.blend = 0;
    gsap.to(state, { blend: 1, duration: d(1), ease: lusion, overwrite: 'auto' });
    gsap.timeline().to(detail, { opacity: 0, y: 8, duration: d(.25), ease: 'power2.in' }).add(() => describe(i)).to(detail, { opacity: 1, y: 0, duration: d(.5), ease: osmo });
  } else {
    state.pass = i as PassIndex; state.blend = 1; describe(i);
  }
  prevButton.disabled = i === 0; nextButton.disabled = i === MOVES.length - 1;
};
carousel.onChange(onMove);

const setOpen = (next: boolean) => {
  if (next === open) return;
  open = next;
  if (gestured && !reduced) ambient.crack(open);
  body.dataset.open = open ? 'on' : 'off';
  openTimeline?.kill();
  body.classList.toggle('open', open);
  closeButton.hidden = !open; prevButton.hidden = !open; nextButton.hidden = !open;
  gsap.to(links, { opacity: open ? 0 : 1, duration: d(.4), ease: 'power2.out', overwrite: true, onComplete: () => { links.style.pointerEvents = open ? 'none' : ''; } });
  gsap.killTweensOf(state, 'explode,core,reveal,lift');
  if (open) {
    state.facet = -1;
    openTimeline = gsap.timeline({ defaults: { overwrite: 'auto' } })
      .to(state, { lift: 0, duration: d(.2) }, 0)
      .to(state, { explode: 1, duration: d(1.25), ease: 'back.out(1.25)' }, 0)
      .to(state, { core: 1, duration: d(.9), ease: 'power2.out' }, d(.15))
      .to(state, { reveal: 1, duration: d(1.1), ease: 'power2.inOut' }, d(.45))
      .fromTo(detail, { opacity: 0, y: 24 }, { opacity: 1, y: 0, duration: d(.8), ease: osmo }, d(.55))
      .fromTo([closeButton, prevButton, nextButton], { opacity: 0 }, { opacity: 1, duration: d(.5), stagger: .05 }, d(.5));
    if (fine) closeButton.focus({ preventScroll: true });
  } else {
    openTimeline = gsap.timeline({ defaults: { overwrite: 'auto' } })
      .to(detail, { opacity: 0, y: 12, duration: d(.3), ease: 'power2.in' }, 0)
      .to([closeButton, prevButton, nextButton], { opacity: 0, duration: d(.25) }, 0)
      .to(state, { reveal: 0, duration: d(.5), ease: 'power2.in' }, 0)
      .to(state, { core: 0, duration: d(.7), ease: 'power2.inOut' }, d(.2))
      .to(state, { explode: 0, duration: d(1.1), ease: 'power3.inOut' }, d(.1));
  }
};
closeButton.addEventListener('click', () => setOpen(false));
addEventListener('pointerdown', () => { gestured = true; }, { once: true, capture: true });
addEventListener('keydown', () => { gestured = true; }, { once: true, capture: true });
soundButton.addEventListener('click', async () => {
  const on = soundButton.getAttribute('aria-pressed') === 'true';
  if (on) ambient.stop(); else await ambient.start();
  soundButton.setAttribute('aria-pressed', String(!on));
  soundButton.setAttribute('aria-label', on ? 'Sound off' : 'Sound on');
});
/** Lusion-style live waveform in the sound button: the drone's own samples, a flat line when muted. */
const drawWave = () => {
  const w = wave.canvas.width, h = wave.canvas.height, samples = ambient.waveform();
  wave.clearRect(0, 0, w, h); wave.lineWidth = 1.2; wave.strokeStyle = getComputedStyle(soundButton).color; wave.beginPath();
  for (let i = 0; i < w; i++) { const v = samples ? samples[Math.floor(i / w * samples.length)] : 0; const y = h / 2 + v * h * .9; i ? wave.lineTo(i, y) : wave.moveTo(i, y); }
  wave.stroke();
};
prevButton.addEventListener('click', () => carousel.prev());
nextButton.addEventListener('click', () => carousel.next());

const hover = (facet: number) => {
  if (facet === state.facet) return;
  state.facet = facet;
  body.classList.toggle('over', facet >= 0);
  gsap.to(state, { lift: facet >= 0 ? 1 : 0, duration: d(.55), ease: osmo, overwrite: 'auto' });
};
const pick = () => {
  if (!world) return;
  hit = world.pick(pointer.nx, pointer.ny, open);
  if (open) body.classList.toggle('over', !!hit?.screen);
  else hover(hit ? hit.facet : -1);
};
addEventListener('pointermove', e => {
  pointer.x = e.clientX; pointer.y = e.clientY; pointer.moved = true;
  pointer.nx = (e.clientX / innerWidth) * 2 - 1; pointer.ny = 1 - (e.clientY / innerHeight) * 2;
  cursor.style.opacity = fine ? '1' : '0';
  pick();
}, { passive: true });
addEventListener('pointerdown', e => {
  if ((e.target as Element | null)?.closest('a, button, #detail, #carousel')) return;
  pointer.nx = (e.clientX / innerWidth) * 2 - 1; pointer.ny = 1 - (e.clientY / innerHeight) * 2;
  pick();
  if (!open && hit) setOpen(true);
});
addEventListener('keydown', e => {
  if (e.key === 'Escape' && open) setOpen(false);
  else if ((e.key === 'Enter' || e.key === ' ') && !(e.target as Element | null)?.closest('a, button')) { e.preventDefault(); setOpen(!open); }
});
carousel.bind(window);
addEventListener('resize', () => world?.resize());

// review states: /how?frame=observe&open=1
const frame = params.get('frame');
const frameIndex = frame ? MOVES.findIndex(m => m.label === frame) : -1;
if (frameIndex >= 0) carousel.set(frameIndex);
onMove(Math.max(0, frameIndex));
if (params.get('open') === '1') setOpen(true);

// the cursor follows with a short lag, the camera and the screen tilt with a longer one
const cursorPos = { x: innerWidth / 2, y: innerHeight / 2 };
let last = performance.now();
const tick = (now: number) => {
  const dt = Math.min(.05, (now - last) / 1000); last = now;
  state.time = now / 1000;
  carousel.update(dt);
  state.position = carousel.position;
  state.tilt.x = tiltX.update(dt, pointer.moved ? pointer.nx : 0);
  state.tilt.y = tiltY.update(dt, pointer.moved ? pointer.ny : 0);
  state.pointer.x = pointer.nx; state.pointer.y = pointer.ny;
  cursorPos.x += (pointer.x - cursorPos.x) * Math.min(1, dt * 22); cursorPos.y += (pointer.y - cursorPos.y) * Math.min(1, dt * 22);
  cursor.style.transform = `translate(${cursorPos.x}px, ${cursorPos.y}px) translate(-50%, -50%)`;
  if (world) world.render(state);
  if ((now | 0) % 2 === 0) drawWave();
  requestAnimationFrame(tick);
};
requestAnimationFrame(tick);
body.dataset.ready = 'true';
