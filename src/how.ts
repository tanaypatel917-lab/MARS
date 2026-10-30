import './style.css';
import gsap from 'gsap';
import { CustomEase } from 'gsap/CustomEase';
import Lenis from 'lenis';
import * as THREE from 'three';
import { HowWorld, type Hit, type WorldState } from './how/world';
import { Simulation, type Trace, type Verdict } from './how/scorer';
import { Odometer } from './how/odometer';

gsap.registerPlugin(CustomEase);
/** Lusion's section ease (ease.lusion = cubicBezier(.35, 0, 0, 1)); osmo for window pops. */
const lusion = CustomEase.create('lusion', '0.35, 0, 0, 1');
const osmo = CustomEase.create('osmo', '0.625, 0.05, 0, 1');
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const clamp01 = (value: number) => clamp(value, 0, 1);
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

const MOVES = ['observe', 'evaluate', 'refine', 'ascend'];
const MOVE_LINES = ['traces from where the work already happens', 'checks you write as code, run on every output', 'a low-rank adapter trained on what passed', 'ship only if the candidate beats the incumbent'];
const TASKS = ['triage inbound tickets', 'draft the weekly report', 'reconcile invoices', 'label support chats', 'route the on-call page', 'summarise the standup', 'fill the CRM', 'review a pull request'];
const THRESHOLD = 800;

const motion = matchMedia('(prefers-reduced-motion: reduce)');
const fine = matchMedia('(pointer: fine)');
const mobile = innerWidth < 700;
const canvas = select<HTMLCanvasElement>('#scene');
const panels = select('.panels');
const stages = [...document.querySelectorAll<HTMLElement>('.stage')];
const reveals = stages.map(s => select('[data-reveal]', s));
const counter = select('#counter');
const tag = select('.tag');
const railFill = select('.rail i');
const cursor = select('#cursor');
const odometer = new Odometer(counter, 4);
const unit = document.createElement('span'); unit.className = 'unit'; counter.appendChild(unit);

let world: HowWorld | null = null;
try { world = new HowWorld(canvas, mobile); } catch { select('#fallback').hidden = false; canvas.remove(); }

const sim = new Simulation();
const traces: Trace[] = world ? Array.from({ length: world.traceCount }, (_, i) => ({ id: i, ms: world!.traceMs(i), label: TASKS[i % TASKS.length] })) : [];
let verdict: Verdict = sim.score(traces, THRESHOLD) as Verdict;

// --- state the world renders
const state: WorldState = { time: 0, progress: 0, pointer: { x: 0, y: 0 }, fieldSpin: 0, threshold: THRESHOLD, growth: 0, contour: null, candidateOrbit: 0, candidateOffset: null, shatter: 0, flare: 0, engrave: 0, facet: -1, crack: 0, fade: 0 };
const spin = new Dynamics(0, 1.2, .9, 1.5);
const engrave = new Dynamics(0, 2, 1, 0);
let spinTarget = 0, hours = 0, candidate = 0, gate: 'idle' | 'running' | 'merged' | 'rejected' = 'idle', cracked = false;
const pointer = { x: 0, y: 0, nx: 0, ny: 0, down: false, dragging: false, lastX: 0 };

// --- scroll → progress (Lusion: each section's object is bound to its DOM range; the camera yaws 90° per section)
const lenis = motion.matches ? null : new Lenis({ lerp: .08, wheelMultiplier: .9 });
const progressNow = () => {
  let p = 0;
  for (let i = 1; i < stages.length; i++) { const top = stages[i].getBoundingClientRect().top; p += lusion(clamp01((innerHeight * .9 - top) / (innerHeight * .8))); }
  return p;
};

// --- one window, Guillaume chrome, anchored to whatever is under the pointer
const panel = document.createElement('div'); panel.className = 'panel how-panel'; panel.hidden = true;
panel.innerHTML = '<div class="bar"><i></i><i></i><i></i><span></span></div><div class="pane"></div>';
panels.appendChild(panel);
const panelLabel = select('.bar span', panel), pane = select('.pane', panel);
let panelShown = false, holdUntil = 0;
const showPanel = (x: number, y: number, label: string, html: string) => {
  panelLabel.textContent = label; pane.innerHTML = html;
  panel.style.transform = `translate(${Math.round(clamp(x + 22, 12, innerWidth - 260))}px, ${Math.round(clamp(y - 18, 12, innerHeight - 140))}px)`;
  if (!panelShown) { panelShown = true; panel.hidden = false; gsap.fromTo(panel, { scale: .72, opacity: 0 }, { scale: 1, opacity: 1, duration: .55, ease: 'back.out(1.7)', overwrite: true }); }
};
const hidePanel = () => { if (!panelShown) return; panelShown = false; gsap.to(panel, { opacity: 0, scale: .9, duration: .25, ease: osmo, overwrite: true, onComplete: () => { panel.hidden = true; } }); };
// the four move windows that the crack reveals
const crackPanels = MOVES.map((move, i) => { const el = document.createElement('div'); el.className = 'panel how-panel crack'; el.hidden = true; el.innerHTML = `<div class="bar"><i></i><i></i><i></i><span>iter 00${i + 1} · ${move}</span></div><div class="pane">${MOVE_LINES[i]}</div>`; panels.appendChild(el); return el; });
const CRACK_ANCHORS = [new THREE.Vector3(-.95, .55, .7), new THREE.Vector3(.9, .7, .5), new THREE.Vector3(-.8, -.75, .6), new THREE.Vector3(.95, -.6, .6)];

const fmt = { ms: (v: number) => `${Math.round(v)} ms`, pct: (v: number) => `${Math.round(v * 100)} %`, hours: (h: number) => `${String(Math.floor(h)).padStart(2, '0')}h ${String(Math.round((h % 1) * 60)).padStart(2, '0')}m` };
const setReveal = (i: number, text: string) => { if (reveals[i].textContent !== text) { reveals[i].textContent = text; gsap.fromTo(reveals[i], { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: .6, ease: osmo, overwrite: true }); } };

// --- interactions per scene
let hit: Hit | null = null;
const section = () => { const r = Math.round(state.progress); return Math.abs(state.progress - r) < .4 ? r : -1; };
const handleHover = (dt: number) => {
  const s = section();
  hit = world && s >= 0 && !pointer.dragging ? world.pick(s, pointer.nx, pointer.ny) : null;
  state.facet = -1; state.contour = null;
  document.body.classList.toggle('over', !!hit);
  if (!hit) { if (s !== 3 || !pointer.down) engrave.update(dt, s === 2 && state.engrave > .5 ? 1 : 0); if (performance.now() > holdUntil) hidePanel(); state.engrave = engrave.value; return; }
  const at = world!.project(hit.point);
  if (s === 0) {
    state.facet = hit.facet;
    const move = hit.facet % 4;
    showPanel(at.x, at.y, `facet ${String(hit.facet).padStart(2, '0')} · ${MOVES[move]}`, `${MOVE_LINES[move]}<br><i>${cracked ? 'click to seal it' : 'click to crack it open'}</i>`);
  } else if (s === 1) {
    const t = traces[hit.index], pass = t.ms < THRESHOLD;
    showPanel(at.x, at.y, `trace ${String(t.id).padStart(4, '0')}`, `${t.label}<br>${fmt.ms(t.ms)} · ${pass ? 'within budget' : 'over budget'}<br><i>drag to turn the field</i>`);
    setReveal(1, `${traces.length} traces. this one: "${t.label}", ${fmt.ms(t.ms)}.`);
  } else if (s === 2) {
    state.engrave = engrave.update(dt, 1);
    if (performance.now() > holdUntil) showPanel(at.x, at.y, 'evals/triage.ts', `${verdict.passed.length} of ${traces.length} pass at ${fmt.ms(THRESHOLD)} · ${fmt.pct(verdict.rate)}<br><i>click to score a trace as it passes</i>`);
  } else if (s === 3) {
    const l = hit.local.clone().normalize();
    state.contour = { x: l.x, y: l.y, z: l.z, r: .55 };
    hours = Math.min(12, hours + dt * 1.2); state.growth = Math.min(1, hours / 6);
    showPanel(at.x, at.y, 'iter 003 · training', `${fmt.hours(hours)} · ${(12.8 + state.growth * 9.4).toFixed(1)} GB<br><i>keep the pointer here to train</i>`);
    setReveal(3, `${fmt.hours(hours)} on one GPU so far. terrain grows where the training lands.`);
  } else if (s === 4) {
    candidate = sim.train(verdict, hours) as number;
    const isCandidate = hit.index === 0;
    showPanel(at.x, at.y, isCandidate ? 'candidate · wireframe' : 'incumbent · shipped', isCandidate ? `pass rate ${fmt.pct(candidate)} on held-out evals<br><i>${gate === 'idle' ? 'click to run the gate' : 'gate ' + gate}</i>` : `pass rate ${fmt.pct(sim.incumbent)}<br>${gate === 'merged' ? 'the candidate is the model now' : 'the model your team runs today'}`);
  }
  if (s !== 2) state.engrave = engrave.update(dt, 0);
};
const crack = () => {
  cracked = !cracked;
  gsap.to(state, { crack: cracked ? 1 : 0, duration: .9, ease: cracked ? 'back.out(1.4)' : osmo, overwrite: true });
  crackPanels.forEach((el, i) => { if (cracked) { el.hidden = false; gsap.fromTo(el, { opacity: 0, scale: .7 }, { opacity: 1, scale: 1, duration: .6, delay: .08 + i * .07, ease: 'back.out(1.7)', overwrite: true }); } else gsap.to(el, { opacity: 0, scale: .85, duration: .3, delay: (3 - i) * .04, ease: osmo, overwrite: true, onComplete: () => { el.hidden = true; } }); });
  setReveal(0, cracked ? 'four moves inside one body. scroll to walk through them.' : '');
};
const scoreOne = (at: { x: number; y: number }) => {
  const t = traces[Math.floor(Math.random() * traces.length)], pass = t.ms < THRESHOLD;
  holdUntil = performance.now() + 2600;
  showPanel(at.x, at.y, `trace ${String(t.id).padStart(4, '0')} · ${pass ? 'pass' : 'fail'}`, `${t.label}<br>${fmt.ms(t.ms)} ${pass ? '<' : '≥'} ${fmt.ms(THRESHOLD)} · ${pass ? 'kept for training' : 'falls away'}`);
  setReveal(2, `${verdict.passed.length} of ${traces.length} pass at ${fmt.ms(THRESHOLD)}. last scored: "${t.label}", ${fmt.ms(t.ms)} · ${pass ? 'pass' : 'fail'}.`);
};
const runGate = () => {
  if (gate !== 'idle') return;
  gate = 'running'; candidate = sim.train(verdict, hours) as number;
  const win = candidate > sim.incumbent;
  const offset = { x: Math.cos(state.candidateOrbit) * 2.0, y: Math.sin(state.candidateOrbit * .7) * .5 };
  state.candidateOffset = offset;
  gsap.to(offset, { x: 0, y: 0, duration: 1.1, ease: lusion, onComplete: () => {
    gate = win ? 'merged' : 'rejected';
    setReveal(4, win ? `${fmt.pct(candidate)} > ${fmt.pct(sim.incumbent)} · shipped. the candidate is the model now. then loop.` : `${fmt.pct(candidate)} < ${fmt.pct(sim.incumbent)} · discarded. the incumbent keeps flying. then loop.`);
    if (win) { state.flare = 1; gsap.to(state, { flare: 0, duration: 1.6, ease: 'power2.out' }); }
    else gsap.to(state, { shatter: 1, duration: 1.1, ease: osmo });
    gsap.delayedCall(3.2, () => { state.shatter = 0; state.flare = 0; state.candidateOffset = null; gate = 'idle'; hours = Math.max(0, hours - 2); state.growth = Math.min(1, hours / 6); });
  } });
};
addEventListener('pointerdown', e => {
  if ((e.target as Element | null)?.closest('a, button, .copy, .ui')) return;
  pointer.down = true; pointer.lastX = e.clientX; pointer.dragging = false;
  pointer.x = e.clientX; pointer.y = e.clientY; pointer.nx = (e.clientX / innerWidth) * 2 - 1; pointer.ny = 1 - (e.clientY / innerHeight) * 2;
  const s = section();
  hit = world && s >= 0 ? world.pick(s, pointer.nx, pointer.ny) : null;
  if (!hit) return;
  if (s === 0) crack();
  else if (s === 2) scoreOne(world!.project(hit.point));
  else if (s === 4 && hit.index === 0) runGate();
});
addEventListener('pointermove', e => {
  pointer.x = e.clientX; pointer.y = e.clientY; pointer.nx = (e.clientX / innerWidth) * 2 - 1; pointer.ny = 1 - (e.clientY / innerHeight) * 2;
  state.pointer.x = pointer.nx; state.pointer.y = pointer.ny;
  if (pointer.down && section() === 1) { const dx = e.clientX - pointer.lastX; if (Math.abs(dx) > 2) pointer.dragging = true; spinTarget += dx * .006; }
  pointer.lastX = e.clientX;
});
addEventListener('pointerup', () => { pointer.down = false; pointer.dragging = false; });
addEventListener('keydown', e => {
  const s = section();
  if (e.key === 'Enter' || e.key === ' ') { if (s === 0) crack(); else if (s === 2) scoreOne({ x: innerWidth * .66, y: innerHeight * .5 }); else if (s === 4) runGate(); else if (s === 3) { hours = Math.min(12, hours + .5); state.growth = Math.min(1, hours / 6); setReveal(3, `${fmt.hours(hours)} on one GPU so far.`); } else return; e.preventDefault(); }
  if (s === 1 && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) { spinTarget += e.key === 'ArrowLeft' ? -.4 : .4; e.preventDefault(); }
});
stages.forEach((stage, i) => stage.setAttribute('aria-label', `${stage.dataset.hint ?? ''}${i === 3 ? ' · press Enter to train' : i === 4 ? ' · press Enter to run the gate' : i === 0 ? ' · press Enter to crack it open' : ''}`));

// --- frame
const UNITS = ['', 'traces', 'pass', 'minutes', 'candidate %'];
let last = performance.now(), start = last;
const frame = (now: number) => {
  const dt = Math.min(.05, (now - last) / 1000); last = now;
  state.time = (now - start) / 1000;
  state.fade = Math.min(1, state.fade + dt * .6);
  state.progress = progressNow();
  if (cracked && state.progress > .6) crack();
  state.fieldSpin = spin.update(dt, spinTarget);
  state.candidateOrbit += dt * .35;
  handleHover(dt); odometer.update(dt);
  const s = Math.round(state.progress);
  stages.forEach((stage, i) => stage.classList.toggle('on', Math.abs(state.progress - i) < .6));
  odometer.set([0, traces.length, verdict.passed.length, Math.round(hours * 60), Math.round((candidate || sim.train(verdict, hours) as number) * 100)][s] ?? 0);
  unit.textContent = UNITS[s] ?? '';
  tag.textContent = stages[s]?.dataset.hint ?? '';
  railFill.style.transform = `scaleY(${state.progress / 4})`;
  if (world) {
    crackPanels.forEach((el, i) => { if (!el.hidden) { const p = world!.project(world!.groups[0].localToWorld(CRACK_ANCHORS[i].clone().multiplyScalar((mobile ? .875 : 1.25) * (1 + state.crack * .35)).add(new THREE.Vector3(mobile ? .15 : 1.15, mobile ? .8 : 0, 0)))); el.style.transform = `translate(${Math.round(clamp(p.x - 90, 12, innerWidth - 192))}px, ${Math.round(clamp(p.y - 24, 12, innerHeight - 130))}px)`; } });
    world.render(state);
  }
  if (fine.matches) cursor.style.transform = `translate(${pointer.x - 3.5}px, ${pointer.y - 3.5}px) scale(${hit ? 2.2 : 1})`;
  requestAnimationFrame(frame);
};
cursor.style.opacity = fine.matches ? '1' : '0';
document.body.dataset.renderer = world ? 'ready' : 'fallback'; document.body.dataset.intro = 'done'; document.body.dataset.ui = 'on';
if (lenis) gsap.ticker.add(t => lenis.raf(t * 1000));
addEventListener('resize', () => world?.resize());
if (location.search.includes('frame=')) { const i = ['loop', 'observe', 'evaluate', 'refine', 'ascend'].indexOf(new URLSearchParams(location.search).get('frame') ?? ''); if (i >= 0) { if (lenis) lenis.scrollTo(stages[i], { immediate: true, force: true }); else stages[i].scrollIntoView(); if (new URLSearchParams(location.search).get('demo')) { hours = 4.5; state.growth = .75; } } }
requestAnimationFrame(frame);
document.body.dataset.ready = 'true';
