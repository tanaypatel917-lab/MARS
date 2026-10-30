import './style.css';
import gsap from 'gsap';
import { CustomEase } from 'gsap/CustomEase';
import Lenis from 'lenis';
import { MarsScene, type FrameState } from './scene';
import { Simulation, latencyFor, tracesFromJson, type Scorer, type Trace, type Verdict } from './how/scorer';
import { Odometer } from './how/odometer';
import { BlobCursor } from './how/cursor';

gsap.registerPlugin(CustomEase);
const osmo = CustomEase.create('osmo', '0.625, 0.05, 0, 1');
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const clamp01 = (value: number) => clamp(value, 0, 1);
const smooth = (value: number) => { const t = clamp01(value); return t * t * (3 - 2 * t); };
const ease = (value: number, start: number, duration: number) => osmo(clamp01((value - start) / duration));
const select = <T extends Element = HTMLElement>(selector: string, root: ParentNode = document) => {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`Missing element: ${selector}`);
  return element;
};

/** Lusion's SecondOrderDynamics: frame-rate independent smoothing with a little overshoot (f 1.5, ζ .8, r 2). */
class Dynamics {
  private y: number; private yd = 0; private xp: number;
  private readonly k1: number; private readonly k2: number; private readonly k3: number;
  constructor(x0: number, f = 1.5, zeta = .8, r = 2) {
    this.y = x0; this.xp = x0;
    this.k1 = zeta / (Math.PI * f); this.k2 = 1 / ((2 * Math.PI * f) ** 2); this.k3 = r * zeta / (2 * Math.PI * f);
  }
  update(dt: number, x: number) {
    if (dt <= 0) return this.y;
    const xd = (x - this.xp) / dt; this.xp = x;
    const k2 = Math.max(this.k2, dt * dt / 2 + dt * this.k1 / 2, dt * this.k1);
    this.y += dt * this.yd;
    this.yd += dt * (x + this.k3 * xd - this.y - this.k1 * this.yd) / k2;
    return this.y;
  }
  snap(x: number) { this.y = x; this.xp = x; this.yd = 0; }
  get value() { return this.y; }
}

const STAGES = ['loop', 'observe', 'evaluate', 'refine', 'ascend'] as const;
const CAPTIONS = [
  'the loop · observe, evaluate, refine, ascend',
  'observe · type a task. every keystroke is one real run of your workflow',
  'evaluate · drag the latency budget. passes stay lit, fails are flung off',
  'refine · hold to train. hours on your gpu, terrain under your pointer',
  'ascend · drag the candidate onto the incumbent. the winner is the model',
];
const scorer: Scorer = new Simulation();
const incumbent = (scorer as Simulation).incumbent ?? .58;
const sections = STAGES.map(id => select(`#${id}`));
for (const section of sections) {
  section.querySelectorAll<HTMLElement>('h1, h2, .copy > p:not(.label):not(.go):not(.meter):not(.gate)').forEach(block => {
    let i = 0;
    block.innerHTML = block.innerHTML.split(/(<[^>]+>)/).map(part => part.startsWith('<') ? part : part.split(' ').map(word => word ? `<span class="word"><span style="transition-delay:${Math.min(i++, 40) * 18}ms">${word}</span></span>` : '').join(' ')).join('');
  });
}
const canvas = select<HTMLCanvasElement>('#scene');
const counterHost = select('#counter');
const tag = select('.tag');
const rail = select('.rail i');
const taskInput = select<HTMLInputElement>('#task');
const upload = select<HTMLInputElement>('#upload');
const observeMeter = select('#observe-meter');
const threshold = select('#threshold');
const evaluateMeter = select('#evaluate-meter');
const evalLines = [...document.querySelectorAll<HTMLElement>('.eval .line')];
const holdButton = select('#hold');
const refineMeter = select('#refine-meter');
const candidateRate = select('#candidate-rate');
const incumbentRate = select('#incumbent-rate');
const runGate = select('#run-gate');
const verdictOut = select('#verdict');
const handle = select<HTMLButtonElement>('#candidate');
const magnets = [...document.querySelectorAll<HTMLElement>('.magnet')];
const motion = matchMedia('(prefers-reduced-motion: reduce)');
const fine = matchMedia('(pointer: fine)');
const params = new URLSearchParams(location.search);
const frame = params.get('frame');
const GLYPHS = '0123456789·abcdefghijklmnopqrstuvwxyz';

// ---- state -------------------------------------------------------------------------------------------------------
const pointer = { x: 0, y: 0, tx: 0, ty: 0, cx: innerWidth / 2, cy: innerHeight / 2, hot: false, seen: false, down: false };
let scene: MarsScene | undefined;
let lenis: Lenis | undefined;
let blob: BlobCursor | undefined;
let start = 0, lastTick = 0, spin = 0, spinVelocity = 0, progress = 0, lastCaption = '';
let stage = 0, locked = -1;
const done = [true, false, false, false, false];
const shown = [0, 0, 0, 0, 0];

const traces: Trace[] = [];
let pool = 2000;
let ms = new Float32Array(pool), born = new Float32Array(pool);
let lastKey = 0, typingSpeed = 0, weight = 400;

let budget = 800;
const budgetDyn = new Dynamics(800);
let scrubbing: { x: number; value: number } | null = null, scrubVelocity = 0, lastScrubX = 0, lastScrubAt = 0;
let verdict: Verdict = { passed: [], failed: [], rate: 0 };
let scoreMix = 0;

let holding = false, hours = 0, growth = 0;
const contour = { x: 0, y: 0, z: 1, r: 0 };
let contourTarget = 0;

let candidate = 0, twinVisible = 0, gate: 'idle' | 'dragging' | 'resolving' | 'merged' | 'rejected' = 'idle';
const HOME = { x: -1.45, y: .75 };
const offset = { ...HOME }, dragOrigin = { x: 0, y: 0 };
let flareT = 0, shatterT = 0, settleT = 0;
const counter = new Odometer(counterHost, 4);
const unit = document.createElement('span'); unit.className = 'unit'; counterHost.append(unit);

// ---- helpers -----------------------------------------------------------------------------------------------------
function scramble(element: HTMLElement, text: string, duration = .5) {
  const from = element.textContent ?? '';
  const length = Math.max(from.length, text.length);
  const state = { t: 0 };
  gsap.killTweensOf(state);
  gsap.to(state, { t: 1, duration, ease: 'power2.out', onUpdate() {
    let out = '';
    for (let i = 0; i < length; i++) {
      const settled = state.t * length * 1.3 - i * .3 > 1;
      out += settled ? (text[i] ?? '') : text[i] === ' ' ? ' ' : GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
    }
    element.textContent = out.trimEnd();
  }, onComplete() { element.textContent = text; } });
}
const pct = (value: number) => `${Math.round(value * 100)} %`;
const hoursText = (h: number) => `${String(Math.floor(h)).padStart(2, '0')}h ${String(Math.floor((h % 1) * 60)).padStart(2, '0')}m · ${(8 + Math.min(1, h / 6) * 11.4).toFixed(1)} GB`;
function now() { return performance.now() / 1000; }

function planet() {
  const portrait = innerWidth / innerHeight < 1;
  return { nx: portrait ? .5 : .64, ny: portrait ? .3 : .5, scale: portrait ? .72 : .95 };
}

function writeHash() {
  const h = new URLSearchParams();
  if (taskInput.value) h.set('t', taskInput.value);
  if (budget !== 800) h.set('th', String(Math.round(budget)));
  if (hours > 0) h.set('h', hours.toFixed(2));
  history.replaceState(null, '', `${location.pathname}${location.search}${h.toString() ? `#${h}` : ''}`);
}

// ---- observe: typing + upload --------------------------------------------------------------------------------------
function addTrace(label: string, seed: number, msValue = latencyFor(seed)) {
  if (traces.length >= pool) return;
  const id = traces.length;
  traces.push({ id, ms: msValue, label });
  ms[id] = msValue; born[id] = Math.max(.001, now() - start);
  ms = ms.slice(); // new reference so the scene re-uploads
}
function setTraces(list: Trace[]) {
  traces.length = 0;
  for (const t of list) { if (traces.length >= pool) break; traces.push({ ...t, id: traces.length }); ms[traces.length - 1] = t.ms; born[traces.length - 1] = Math.max(.001, now() - start) + traces.length * .004; }
  ms = ms.slice();
}
function observeChanged() {
  observeMeter.textContent = `${traces.length} trace${traces.length === 1 ? '' : 's'}`;
  done[1] = traces.length >= 8;
  nextButton(1).disabled = !done[1];
  rescore();
  writeHash();
}
taskInput.addEventListener('input', event => {
  const e = event as InputEvent;
  const t = now();
  if (e.inputType?.startsWith('insert')) {
    const gap = lastKey ? Math.min(1.2, t - lastKey) : .6;
    typingSpeed = clamp01(1 - gap / .5);
    const text = taskInput.value;
    const seed = text.length * 7.13 + text.charCodeAt(text.length - 1) * .37;
    addTrace(text.slice(Math.max(0, text.length - 12)), seed);
  }
  lastKey = t;
  observeChanged();
});
taskInput.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); if (done[1]) advance(1); } });
upload.addEventListener('change', async () => {
  const file = upload.files?.[0];
  if (!file) return;
  try {
    const list = tracesFromJson(await file.text());
    if (!list.length) throw new Error('no traces');
    setTraces(list);
    taskInput.value = file.name.replace(/\.json$/i, '');
    observeMeter.textContent = `${traces.length} traces from ${file.name}`;
    done[1] = traces.length >= 8; nextButton(1).disabled = !done[1]; rescore(); writeHash();
  } catch {
    observeMeter.textContent = 'could not read that file · expected a JSON array of { ms }';
  }
});

// ---- evaluate: scrub the latency budget -----------------------------------------------------------------------------
async function rescore() {
  verdict = await scorer.score(traces, budget);
  const total = traces.length;
  evaluateMeter.textContent = total ? `${verdict.passed.length} of ${total} pass at ${Math.round(budget)} ms · ${pct(verdict.rate)}` : 'type a task first — nothing to score yet';
  threshold.textContent = String(Math.round(budget));
  threshold.setAttribute('aria-valuenow', String(Math.round(budget)));
  evalLines.forEach((line, i) => line.classList.toggle('on', total > 0 && stage >= 2 && i <= 4));
}
function setBudget(value: number, fromUser = true) {
  budget = clamp(Math.round(value), 150, 2000);
  if (fromUser) { done[2] = traces.length > 0; nextButton(2).disabled = !done[2]; }
  rescore(); writeHash();
}
threshold.addEventListener('pointerdown', event => {
  event.preventDefault();
  threshold.setPointerCapture(event.pointerId);
  scrubbing = { x: event.clientX, value: budget };
  lastScrubX = event.clientX; lastScrubAt = now();
  threshold.dataset.active = 'on';
});
threshold.addEventListener('pointermove', event => {
  if (!scrubbing) return;
  const t = now();
  scrubVelocity = (event.clientX - lastScrubX) / Math.max(.004, t - lastScrubAt);
  lastScrubX = event.clientX; lastScrubAt = t;
  setBudget(scrubbing.value + (event.clientX - scrubbing.x) * 3);
});
const endScrub = () => { scrubbing = null; delete threshold.dataset.active; };
threshold.addEventListener('pointerup', endScrub);
threshold.addEventListener('pointercancel', endScrub);
threshold.addEventListener('keydown', event => {
  const step = event.shiftKey ? 50 : 10;
  if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') { event.preventDefault(); setBudget(budget - step); }
  if (event.key === 'ArrowRight' || event.key === 'ArrowUp') { event.preventDefault(); setBudget(budget + step); }
  if (event.key === 'Home') setBudget(150); if (event.key === 'End') setBudget(2000);
});

// ---- refine: press and hold ------------------------------------------------------------------------------------------
function setHolding(on: boolean) {
  if (on && stage !== 3) return;
  holding = on;
  holdButton.dataset.held = on ? 'on' : '';
}
holdButton.addEventListener('pointerdown', e => { e.preventDefault(); holdButton.setPointerCapture(e.pointerId); setHolding(true); });
for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) holdButton.addEventListener(type, () => setHolding(false));
holdButton.addEventListener('keydown', e => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); setHolding(true); } });
holdButton.addEventListener('keyup', e => { if (e.key === ' ' || e.key === 'Enter') setHolding(false); });
addEventListener('pointerdown', event => {
  pointer.down = true;
  if (stage === 3 && event.button === 0 && !(event.target as Element).closest('.copy, .corners, .hud, button, a, input')) setHolding(true);
});
addEventListener('pointerup', () => { pointer.down = false; if (holding && holdButton.dataset.held !== 'on-key') setHolding(false); });

// ---- ascend: drag the candidate -----------------------------------------------------------------------------------------
function candidateChanged() {
  candidateRate.textContent = `candidate ${traces.length ? pct(candidate) : '—'}`;
  incumbentRate.textContent = `incumbent ${pct(incumbent)}`;
}
handle.addEventListener('pointerdown', event => {
  if (gate !== 'idle' && gate !== 'dragging') return;
  event.preventDefault();
  handle.setPointerCapture(event.pointerId);
  handle.dataset.drag = 'on';
  gate = 'dragging';
  dragOrigin.x = event.clientX; dragOrigin.y = event.clientY;
});
handle.addEventListener('pointermove', event => {
  if (gate !== 'dragging' || !scene) return;
  const k = scene.unitsPerPixel;
  offset.x += (event.clientX - dragOrigin.x) * k; offset.y -= (event.clientY - dragOrigin.y) * k;
  dragOrigin.x = event.clientX; dragOrigin.y = event.clientY;
});
const dropCandidate = () => {
  if (gate !== 'dragging' || !scene) return;
  delete handle.dataset.drag;
  const centre = scene.project(0, 0), here = scene.project(offset.x * planet().scale, offset.y * planet().scale);
  if (Math.hypot(here.x - centre.x, here.y - centre.y) < Math.max(90, innerHeight * .2)) resolveGate(); else gate = 'idle';
};
handle.addEventListener('pointerup', dropCandidate);
handle.addEventListener('pointercancel', dropCandidate);
handle.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); resolveGate(); } });
runGate.addEventListener('click', () => resolveGate());
function resolveGate() {
  if (gate === 'resolving' || gate === 'merged' || gate === 'rejected') return;
  gate = 'resolving';
  handle.disabled = true;
  const win = candidate > incumbent && traces.length > 0;
  gsap.to(offset, { x: 0, y: 0, duration: .7, ease: osmo, onComplete() {
    if (win) {
      gate = 'merged';
      gsap.fromTo({ t: 0 }, { t: 0 }, { t: 1, duration: 1.4, ease: 'power2.out', onUpdate() { flareT = (this.targets()[0] as { t: number }).t; } });
      gsap.to({ s: 0 }, { s: 1, duration: 2.2, ease: osmo, onUpdate() { settleT = (this.targets()[0] as { s: number }).s; } });
      verdictOut.textContent = `${pct(candidate)} > ${pct(incumbent)} · shipped. the candidate is the model now. then loop.`;
    } else {
      gate = 'rejected';
      gsap.fromTo({ t: 0 }, { t: 0 }, { t: 1, duration: 1.1, ease: 'power1.in', onUpdate() { shatterT = (this.targets()[0] as { t: number }).t; } });
      verdictOut.textContent = traces.length ? `${pct(candidate)} < ${pct(incumbent)} · discarded. the incumbent keeps flying. then loop.` : 'no traces, no candidate · go back and type a task.';
    }
    done[4] = true;
    release();
  } });
}
select('#loop-again').addEventListener('click', () => {
  gate = 'idle'; flareT = 0; shatterT = 0; settleT = 0; handle.disabled = false; offset.x = HOME.x; offset.y = HOME.y;
  hours = 0; growth = 0; done[2] = done[3] = done[4] = false;
  verdictOut.textContent = '';
  refineMeter.textContent = hoursText(0);
  nextButton(2).disabled = nextButton(3).disabled = true;
  for (const s of sections) s.classList.remove('on');
  goTo(1);
});

// ---- stages: pin until done -----------------------------------------------------------------------------------------------
const nextButton = (i: number) => select<HTMLButtonElement>('[data-next]', sections[i]);
function release() { locked = -1; lenis?.start(); }
function goTo(i: number) {
  const top = sections[i].getBoundingClientRect().top + scrollY;
  release();
  if (lenis) lenis.scrollTo(top, { duration: 1.1, easing: (t: number) => osmo(t) }); else scrollTo({ top, behavior: motion.matches ? 'auto' : 'smooth' });
}
function advance(i: number) { done[i] = true; if (i < 4) goTo(i + 1); }
sections.forEach((section, i) => {
  section.querySelector('[data-next]')?.addEventListener('click', event => { event.preventDefault(); if (i === 0 || done[i]) advance(i); });
  section.querySelector('[data-skip]')?.addEventListener('click', () => advance(i));
});
function enterStage(i: number) {
  if (i === stage) return;
  stage = i;
  if (i === 1) taskInput.focus({ preventScroll: true });
  if (i === 2) rescore();
  if (i === 3) refineMeter.textContent = hoursText(hours);
  if (i === 4) { candidate = traces.length ? Number(scorer.train(verdict, hours)) : 0; candidateChanged(); handle.hidden = false; done[3] = true; }
  handle.hidden = i !== 4 || gate === 'merged' || gate === 'rejected';
  if (CAPTIONS[i] !== lastCaption) { lastCaption = CAPTIONS[i]; scramble(tag, CAPTIONS[i], .7); }
}

// ---- scene -------------------------------------------------------------------------------------------------------------------
try {
  scene = new MarsScene(canvas, 'shard');
  pool = scene.traceCount;
  ms = new Float32Array(pool); born = new Float32Array(pool);
  document.body.dataset.renderer = 'ready';
} catch (error) {
  console.warn('MARS: WebGL unavailable, showing the outline only.', error);
  canvas.hidden = true;
  select('#fallback').hidden = false;
  document.body.dataset.renderer = 'fallback';
}
if (fine.matches && !motion.matches) blob = new BlobCursor(select<HTMLCanvasElement>('#blob'), () => pointer.hot);
document.body.dataset.intro = 'done';
document.body.dataset.ui = 'on';

function draw(time: number) {
  const dt = lastTick ? Math.min(.05, time - lastTick) : 0;
  lastTick = time;
  if (!start) start = time;
  const t = motion.matches ? 10 : time - start;

  sections.forEach((section, i) => {
    const rect = section.getBoundingClientRect();
    shown[i] = smooth((innerHeight * .78 - rect.top) / (innerHeight * .34));
    if (shown[i] > .12) section.classList.add('on');
    if (rect.top <= innerHeight * .5 && rect.bottom > innerHeight * .5) enterStage(i);
    if (lenis && !done[i] && i > 0 && rect.top <= 0 && rect.top > -innerHeight * .6 && locked !== i) {
      locked = i;
      lenis.scrollTo(rect.top + scrollY, { immediate: true, force: true });
      lenis.stop();
    }
  });
  if (locked >= 0 && done[locked]) release();

  // observe: the typing field's weight follows typing speed (Pangram's axis-driven specimens)
  typingSpeed *= Math.exp(-dt * 1.8);
  weight += ((320 + typingSpeed * 520) - weight) * Math.min(1, dt * 8);
  taskInput.style.setProperty('--wght', String(Math.round(weight)));
  taskInput.style.setProperty('--track', `${(typingSpeed * .03).toFixed(3)}em`);

  // evaluate: smoothed budget + scrub velocity → hairline split
  const budgetNow = budgetDyn.update(dt, budget);
  scrubVelocity *= Math.exp(-dt * 6);
  scoreMix += ((stage >= 2 ? 1 : 0) - scoreMix) * Math.min(1, dt * 3);

  // refine: hold = hours
  if (holding) {
    hours = Math.min(12, hours + dt * 1.2);
    growth = Math.min(1, hours / 6);
    refineMeter.textContent = hoursText(hours);
    holdButton.style.setProperty('--held', String(growth));
    if (hours >= .5 && !done[3]) { done[3] = true; nextButton(3).disabled = false; writeHash(); }
    const hit = scene?.pick(pointer.tx, pointer.ty) ?? null;
    if (hit) { contour.x = hit.x; contour.y = hit.y; contour.z = hit.z; }
    contourTarget = .25 + growth * .7;
  } else contourTarget = Math.max(0, contourTarget - dt * .6);
  contour.r += (contourTarget - contour.r) * Math.min(1, dt * 4);

  // ascend
  twinVisible += ((stage === 4 && gate !== 'merged' && gate !== 'rejected' ? 1 : (gate === 'merged' ? 1 - settleT : 1 - shatterT)) - twinVisible) * Math.min(1, dt * 4);
  if (stage !== 4) twinVisible = 0;
  handle.hidden = stage !== 4 || gate === 'merged' || gate === 'rejected';
  if (scene && !handle.hidden) {
    const p = scene.project(offset.x * planet().scale, offset.y * planet().scale);
    handle.style.left = `${p.x}px`; handle.style.top = `${p.y}px`;
  }

  // hud
  if (stage <= 1) { counter.set(traces.length); unit.textContent = 'traces'; }
  else if (stage === 2) { counter.set(verdict.passed.length); unit.textContent = `pass · ${Math.round(budgetNow)} ms`; }
  else if (stage === 3) { counter.set(Math.round(hours * 60)); unit.textContent = 'gpu minutes'; }
  else { counter.set(Math.round(candidate * 1000)); unit.textContent = '‰ candidate'; }
  counter.update(dt);
  rail.style.transform = `scaleY(${progress})`;

  pointer.x += (pointer.tx - pointer.x) * .06;
  pointer.y += (pointer.ty - pointer.y) * .06;
  spinVelocity *= .92;
  spin += spinVelocity * dt;
  blob?.draw(dt);
  if (!scene) return;
  const { nx, ny, scale } = planet();
  const units = scene.unitsPerHalfHeight;
  const centre = scene.project(0, 0);
  const state: FrameState = {
    time,
    outlineReveal: ease(t, .1, 1.1),
    outlineOpacity: (1 - growth * .6) * (1 - settleT * .5),
    wireReveal: 0,
    wireOpacity: 0,
    beautyFade: ease(t, .5, 1.2) * (.3 + .7 * growth),
    bodySpawn: 0,
    rimGhost: 0,
    settle: 0,
    pointer: { x: pointer.x, y: pointer.y },
    morph: 0,
    split: clamp(scrubVelocity * .000012 + spinVelocity * .0022, -.012, .012),
    spin,
    light: Math.min(1, t / 1.5) * (pointer.seen ? 1 : .35),
    horizon: settleT * .8,
    word: 0,
    panels: [],
    shift: { x: (nx - .5) * 2 * units * scene.camera.aspect, y: (.5 - ny) * 2 * units, scale },
    growth,
    traces: { fall: 1, score: scoreMix, sink: growth * (gate === 'merged' ? 1 : .6), count: traces.length, threshold: budgetNow, ms, born },
    twin: twinVisible,
    twinOffset: { x: offset.x * scale, y: offset.y * scale },
    shatter: shatterT,
    flare: gate === 'merged' ? { x: centre.x / innerWidth, y: 1 - centre.y / innerHeight, t: flareT } : undefined,
    contour: contour.r > .001 ? contour : undefined,
  };
  if (!document.hidden) scene.render(state);
}

function tick(time: number) { lenis?.raf(time * 1000); draw(time); }
function onScroll() {
  if (lenis) spinVelocity = clamp(lenis.velocity * .012, -1.6, 1.6);
  const max = document.documentElement.scrollHeight - innerHeight;
  progress = max > 0 ? clamp01(scrollY / max) : 0;
  if (motion.matches || !scene) draw(now());
}
function updateMotion() {
  lenis?.destroy(); lenis = undefined;
  gsap.ticker.remove(tick);
  if (!motion.matches && scene) {
    lenis = new Lenis({ lerp: .08, smoothWheel: true, syncTouch: false });
    lenis.on('scroll', onScroll);
    if (!document.hidden) gsap.ticker.add(tick);
  } else if (scene) gsap.ticker.add(tick);
  onScroll();
}
function visibility() {
  gsap.ticker.remove(tick);
  lastTick = 0;
  if (!document.hidden && scene) gsap.ticker.add(tick);
}
function contextLost(event: Event) {
  event.preventDefault();
  gsap.ticker.remove(tick);
  lenis?.destroy(); lenis = undefined;
  scene?.dispose(); scene = undefined;
  canvas.hidden = true;
  select('#fallback').hidden = false;
  document.body.dataset.renderer = 'fallback';
  for (const section of sections) section.classList.add('on');
}

motion.addEventListener('change', updateMotion);
document.addEventListener('visibilitychange', visibility);
addEventListener('resize', () => { scene?.resize(); blob?.resize(); onScroll(); });
addEventListener('scroll', onScroll, { passive: true });
addEventListener('pointermove', event => {
  pointer.seen = true;
  pointer.tx = (event.clientX / innerWidth) * 2 - 1;
  pointer.ty = 1 - (event.clientY / innerHeight) * 2;
  pointer.cx = event.clientX; pointer.cy = event.clientY;
  pointer.hot = !!(event.target as Element).closest('a, button, input, label, .scrub');
  for (const magnet of magnets) {
    const box = magnet.getBoundingClientRect();
    const dx = event.clientX - (box.left + box.width / 2), dy = event.clientY - (box.top + box.height / 2);
    magnet.style.transform = Math.hypot(dx, dy) < 70 ? `translate(${dx * .28}px, ${dy * .28}px)` : '';
  }
}, { passive: true });
canvas.addEventListener('webglcontextlost', contextLost);
addEventListener('pagehide', event => { if (!event.persisted) { gsap.ticker.remove(tick); lenis?.destroy(); scene?.dispose(); } });

// ---- restore from the hash, then start ---------------------------------------------------------------------------------------
const hash = new URLSearchParams(location.hash.replace(/^#/, ''));
if (params.get('demo')) { hash.set('t', hash.get('t') ?? 'triage inbound support tickets'); hash.set('th', hash.get('th') ?? '700'); hash.set('h', hash.get('h') ?? '4.5'); }
updateMotion();
if (hash.get('t')) {
  taskInput.value = hash.get('t')!.slice(0, 140);
  setTraces([...taskInput.value].map((_, i) => ({ id: i, ms: latencyFor((i + 1) * 7.13 + taskInput.value.charCodeAt(i) * .37), label: taskInput.value.slice(Math.max(0, i - 11), i + 1) })));
  for (let i = 0; i < traces.length; i++) born[i] = .001;
  observeChanged(); done[1] = traces.length >= 8;
}
if (hash.get("th")) { setBudget(Number(hash.get("th")), false); done[2] = traces.length > 0; nextButton(2).disabled = !done[2]; }
if (hash.get('h')) { hours = clamp(Number(hash.get('h')) || 0, 0, 12); growth = Math.min(1, hours / 6); done[3] = hours >= .5; nextButton(3).disabled = !done[3]; refineMeter.textContent = hoursText(hours); }
incumbentRate.textContent = `incumbent ${pct(incumbent)}`;
if (hash.toString()) writeHash();
await document.fonts.ready;
const target = STAGES.indexOf((frame ?? '') as typeof STAGES[number]);
if (target > 0) {
  for (let i = 1; i < target; i++) done[i] = true;
  const top = sections[target].getBoundingClientRect().top + scrollY;
  if (lenis) lenis.scrollTo(top, { immediate: true, force: true }); else scrollTo(0, top);
  onScroll();
  draw(now());
}
document.body.dataset.ready = 'true';
