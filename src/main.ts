import './style.css';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import Lenis from 'lenis';
import 'lenis/dist/lenis.css';
import { MarsScene } from './scene';

gsap.registerPlugin(ScrollTrigger);
const chapters = ['orbit', 'launch', 'loop', 'approach', 'arrival'] as const;
const phases = [
  ['Observe', 'Capture real traces from your workflow. Not benchmarks.'],
  ['Evaluate', 'Score every output against evals you write as code.'],
  ['Refine', 'Fine-tune an open model on what passed.'],
  ['Ascend', 'Ship the new weights only if they beat the old ones. Then loop.'],
];
const select = <T extends Element = HTMLElement>(selector: string) => {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing element: ${selector}`);
  return element;
};
const canvas = select<HTMLCanvasElement>('#scene');
const panels = [...document.querySelectorAll<HTMLElement>('.chapter')];
const motion = matchMedia('(prefers-reduced-motion: reduce)');
const form = select<HTMLFormElement>('#access-form');
const email = select<HTMLInputElement>('#email');
const indicator = select('#chapter-indicator');
const line = select('.progress-line i');
const loopTitle = select('#loop-title');
const loopDescription = select('#loop-description');
const loopIndex = select('.loop-index');
const phaseTicks = [...document.querySelectorAll('.phase-track i')];
let progress = 0;
let currentChapter = -1;
let currentPhase = -1;
let scene: MarsScene | undefined;
let lenis: Lenis | undefined;
let disposed = false;

try {
  scene = new MarsScene(canvas);
  document.body.dataset.renderer = 'ready';
} catch (error) {
  console.warn('MARS: WebGL unavailable. Showing the static composition.', error);
  canvas.hidden = true;
  select('#fallback').hidden = false;
  document.body.dataset.renderer = 'fallback';
}

function draw(time = 0) {
  const index = Math.min(4, Math.floor(progress * 5));
  const local = progress * 5 - index;
  const phase = Math.min(3, Math.floor(local * 4));
  if (index !== currentChapter) {
    panels.forEach((panel, i) => { panel.hidden = i !== index; panel.inert = i !== index; });
    currentChapter = index;
    document.body.dataset.chapter = chapters[index];
    indicator.textContent = `${String(index + 1).padStart(2, '0')} — ${chapters[index]}`;
  }
  const opacity = motion.matches ? 1 : Math.min(1, local * 14 + (index === 0 ? 1 : 0), (1 - local) * 14 + (index === 4 ? 1 : 0));
  panels[index].style.opacity = String(opacity);
  line.style.transform = `scaleX(${progress})`;
  if (index === 2 && phase !== currentPhase) {
    currentPhase = phase;
    loopTitle.textContent = phases[phase][0];
    loopDescription.textContent = phases[phase][1];
    loopIndex.innerHTML = `${String(phase + 1).padStart(2, '0')}<span>/04</span>`;
    phaseTicks.forEach((tick, i) => tick.classList.toggle('active', i === phase));
    document.body.dataset.phase = String(phase);
  }
  select('#launch-copy').textContent = local < .5 ? 'General models know a little about everything.' : 'Yours will know everything about one thing.';
  const approach = ['Open weights. Yours.', 'Small enough to run anywhere.', 'Day 100 beats day 1.'];
  select('#approach-copy').textContent = approach[Math.min(2, Math.floor(local * 3))];
  if (!document.hidden) scene?.render(motion.matches ? (index + .5) / 5 : progress, motion.matches ? 0 : time);
}

const trigger = ScrollTrigger.create({
  trigger: '#journey', start: 'top top', end: 'bottom bottom',
  onUpdate: self => { progress = self.progress; if (motion.matches || !scene) draw(); },
});
function tick(time: number) {
  lenis?.raf(time * 1000);
  if (!document.hidden) draw(time);
}
function updateMotion() {
  lenis?.destroy(); lenis = undefined;
  gsap.ticker.remove(tick);
  if (!motion.matches && scene) {
    lenis = new Lenis({ lerp: .085, smoothWheel: true, syncTouch: false });
    lenis.on('scroll', ScrollTrigger.update);
    if (!document.hidden) gsap.ticker.add(tick);
  }
  draw();
}
function visibility() {
  gsap.ticker.remove(tick);
  if (!document.hidden && !motion.matches && scene) gsap.ticker.add(tick);
}
function resize() { scene?.resize(); ScrollTrigger.refresh(); draw(); }
function jump(value: number) {
  const top = value * (document.documentElement.scrollHeight - innerHeight);
  if (lenis) lenis.scrollTo(top, { immediate: true }); else window.scrollTo(0, top);
  ScrollTrigger.update(); progress = value; draw();
}
function hashJump(event: MouseEvent) {
  const target = (event.target as Element).closest<HTMLAnchorElement>('a[href^="#"]');
  if (!target) return;
  event.preventDefault();
  jump(target.hash === '#orbit' ? 0 : .92);
  if (target.hash === '#waitlist') email.focus({ preventScroll: true });
}
function submit(event: SubmitEvent) {
  event.preventDefault();
  if (!form.reportValidity()) return;
  // TODO: connect the approved waitlist endpoint; no address is stored or sent yet.
  select('#form-message').textContent = 'TRANSMISSION RECEIVED — DEMO ONLY. YOUR ADDRESS HAS NOT BEEN STORED.';
  select<HTMLButtonElement>('#access-form button').textContent = 'You’re on approach ✓';
  email.value = '';
}
function contextLost(event: Event) {
  event.preventDefault();
  gsap.ticker.remove(tick);
  lenis?.destroy(); lenis = undefined;
  scene?.dispose(); scene = undefined;
  canvas.hidden = true; select('#fallback').hidden = false;
  document.body.dataset.renderer = 'fallback';
}
function dispose() {
  if (disposed) return;
  disposed = true;
  gsap.ticker.remove(tick); trigger.kill(); lenis?.destroy(); scene?.dispose();
  motion.removeEventListener('change', updateMotion);
  document.removeEventListener('visibilitychange', visibility);
  window.removeEventListener('resize', resize);
  document.removeEventListener('click', hashJump);
  form.removeEventListener('submit', submit);
  canvas.removeEventListener('webglcontextlost', contextLost);
}
motion.addEventListener('change', updateMotion);
document.addEventListener('visibilitychange', visibility);
window.addEventListener('resize', resize);
document.addEventListener('click', hashJump);
form.addEventListener('submit', submit);
canvas.addEventListener('webglcontextlost', contextLost);
window.addEventListener('pagehide', event => { if (!event.persisted) dispose(); });
updateMotion();
await document.fonts.ready;
ScrollTrigger.refresh();
const frame = new URLSearchParams(location.search).get('frame');
const frames: Record<string, number> = { orbit: .035, loop: .425, arrival: .94 };
if (frame && Object.hasOwn(frames, frame)) jump(frames[frame]);
else if (location.hash === '#waitlist') jump(.92);
document.body.dataset.ready = 'true';
