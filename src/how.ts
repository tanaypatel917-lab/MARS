import './style.css';
import gsap from 'gsap';
import { CustomEase } from 'gsap/CustomEase';
import Lenis from 'lenis';
import { MarsScene, type FrameState, type PanelView, type Pass } from './scene';

gsap.registerPlugin(CustomEase);
const osmo = CustomEase.create('osmo', '0.625, 0.05, 0, 1');
const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const smooth = (value: number) => { const t = clamp01(value); return t * t * (3 - 2 * t); };
const ease = (value: number, start: number, duration: number) => osmo(clamp01((value - start) / duration));
const select = <T extends Element = HTMLElement>(selector: string) => {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing element: ${selector}`);
  return element;
};

/** One chapter per pass; window rects are in planet units like the home page. */
interface Chapter { id: string; pass: Pass | null; label: string; caption: string; x: number; y: number; w: number; h: number; section: HTMLElement; panel: HTMLElement | null; open: number; shown: number }
const spec: Omit<Chapter, 'section' | 'panel' | 'open' | 'shown'>[] = [
  { id: 'loop', pass: null, label: 'iter 000', caption: 'the loop · observe, evaluate, refine, ascend', x: 0, y: 0, w: 0, h: 0 },
  { id: 'observe', pass: 'observe', label: 'iter 001 · observe', caption: 'observe · capture real traces from your workflow, not benchmarks', x: -.95, y: -.6, w: 1.15, h: 1.05 },
  { id: 'evaluate', pass: 'evaluate', label: 'iter 002 · evaluate', caption: 'evaluate · score every output against evals you write as code', x: -.4, y: -1.3, w: 1.5, h: .85 },
  { id: 'refine', pass: 'refine', label: 'iter 003 · refine', caption: 'refine · fine-tune on what passed, on hardware you own', x: -1.3, y: .2, w: 1.25, h: .8 },
  { id: 'ascend', pass: null, label: 'iter 004 · ascend', caption: 'ascend · ship the new weights only if they beat the old ones. then loop', x: 0, y: 0, w: 0, h: 0 },
];
const host = select('.panels');
const chapters: Chapter[] = spec.map(item => {
  const section = select(`#${item.id}`);
  let panel: HTMLElement | null = null;
  if (item.pass) {
    panel = document.createElement('div');
    panel.className = 'panel';
    panel.innerHTML = `<div class="bar"><i></i><i></i><i></i><span>${item.label}</span></div>`;
    panel.style.display = 'none';
    host.append(panel);
  }
  section.querySelectorAll<HTMLElement>('h1, h2, p:not(.label)').forEach(block => {
    let i = 0;
    block.innerHTML = block.innerHTML.split(/(<[^>]+>)/).map(part => part.startsWith('<') ? part : part.split(' ').map(word => word ? `<span class="word"><span style="transition-delay:${Math.min(i++, 40) * 18}ms">${word}</span></span>` : '').join(' ')).join('');
  });
  return { ...item, section, panel, open: -1, shown: 0 };
});
const canvas = select<HTMLCanvasElement>('#scene');
const counter = select('#counter');
const tag = select('.tag');
const rail = select('.rail i');
const cursor = select('#cursor');
const magnets = [...document.querySelectorAll<HTMLElement>('.magnet')];
const motion = matchMedia('(prefers-reduced-motion: reduce)');
const fine = matchMedia('(pointer: fine)');
const frame = new URLSearchParams(location.search).get('frame');
const GLYPHS = '0123456789·abcdefghijklmnopqrstuvwxyz';
const pointer = { x: 0, y: 0, tx: 0, ty: 0, cx: innerWidth / 2, cy: innerHeight / 2, px: innerWidth / 2, py: innerHeight / 2, hot: false, seen: false };
let scene: MarsScene | undefined;
let lenis: Lenis | undefined;
let start = 0, lastTick = 0, spin = 0, spinVelocity = 0, progress = 0;
let lastCounter = '', lastCaption = '';

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

try {
  scene = new MarsScene(canvas);
  document.body.dataset.renderer = 'ready';
} catch (error) {
  console.warn('MARS: WebGL unavailable, showing the outline only.', error);
  canvas.hidden = true;
  select('#fallback').hidden = false;
  document.body.dataset.renderer = 'fallback';
}
document.body.dataset.intro = 'done';
document.body.dataset.ui = 'on';

/** The planet sits right of the text column on wide screens and above it on phones. */
function planet() {
  const portrait = innerWidth / innerHeight < 1;
  const cx = portrait ? .5 : .68, cy = portrait ? .3 : .5, scale = portrait ? .7 : .8;
  const radius = (portrait ? .39 * innerWidth : .32 * innerHeight) * scale;
  return { cx: cx * innerWidth, cy: cy * innerHeight, radius, scale, nx: cx, ny: cy };
}

function chapterProgress(chapter: Chapter) {
  const rect = chapter.section.getBoundingClientRect();
  return smooth((innerHeight * .78 - rect.top) / (innerHeight * .34));
}

function views(closing: number): PanelView[] {
  const { cx, cy, radius } = planet();
  const bar = Math.min(innerWidth, innerHeight) < 700 ? 20 : 24;
  const out: PanelView[] = [];
  chapters.forEach((chapter, i) => {
    if (!chapter.panel || !chapter.pass) return;
    const open = chapter.shown * (1 - closing);
    const left = Math.round(cx + chapter.x * radius), top = Math.round(cy + chapter.y * radius);
    const fullWidth = Math.round(chapter.w * radius);
    const w = Math.round(fullWidth * smooth(open / .62)), h = Math.round(chapter.h * radius * smooth((open - .38) / .62));
    if (open !== chapter.open) {
      chapter.open = open;
      const style = chapter.panel.style;
      style.left = `${left}px`; style.top = `${top}px`; style.width = `${w}px`; style.height = `${h}px`;
      style.display = w > 48 && h > bar + 10 ? '' : 'none';
      style.zIndex = String(i);
      (chapter.panel.firstElementChild as HTMLElement).style.width = `${fullWidth}px`;
    }
    if (h > bar + 10 && w > 48) out.push({ pass: chapter.pass, x: left + 1, y: top + bar + 1, w: w - 2, h: h - bar - 2 });
  });
  return out;
}

function draw(now: number) {
  const dt = lastTick ? Math.min(.05, now - lastTick) : 0;
  lastTick = now;
  if (!start) start = now;
  // Reduced motion has no ticker: draw the finished intro so the planet is there before any scroll.
  const t = motion.matches ? 10 : now - start;
  let stage = 0;
  chapters.forEach((chapter, i) => {
    chapter.shown = chapterProgress(chapter);
    if (chapter.shown > .12) chapter.section.classList.add('on');
    if (chapter.shown > .5) stage = i;
  });
  const ascend = chapters[4].shown;
  const label = chapters[stage].label;
  if (label !== lastCounter) { lastCounter = label; scramble(counter, label); }
  const caption = chapters[stage].caption;
  if (caption !== lastCaption) { lastCaption = caption; scramble(tag, caption, .7); }
  rail.style.transform = `scaleY(${progress})`;
  pointer.x += (pointer.tx - pointer.x) * .06;
  pointer.y += (pointer.ty - pointer.y) * .06;
  spinVelocity *= .92;
  spin += spinVelocity * dt;
  if (fine.matches && pointer.seen) {
    pointer.px += (pointer.cx - pointer.px) * .22;
    pointer.py += (pointer.cy - pointer.py) * .22;
    cursor.style.transform = `translate(${pointer.px}px, ${pointer.py}px) translate(-50%, -50%) scale(${pointer.hot ? 2.6 : 1})`;
  }
  if (!scene) return;
  const { nx, ny, scale } = planet();
  const units = scene.unitsPerHalfHeight;
  const state: FrameState = {
    time: now,
    outlineReveal: ease(t, .1, 1.1),
    outlineOpacity: 1 - ascend * .82,
    wireReveal: 0,
    wireOpacity: 0,
    beautyFade: ascend,
    rimGhost: (1 - ascend) * ease(t, .6, 1.0) * .3,
    settle: 0,
    pointer: { x: pointer.x, y: pointer.y },
    spin,
    light: Math.min(1, t / 1.5) * (pointer.seen ? 1 : .35),
    horizon: ascend * .8,
    word: 0,
    panels: views(ascend),
    shift: { x: (nx - .5) * 2 * units * scene.camera.aspect, y: (.5 - ny) * 2 * units, scale },
  };
  if (!document.hidden) scene.render(state);
}

function tick(time: number) { lenis?.raf(time * 1000); draw(time); }
function onScroll() {
  if (lenis) spinVelocity = Math.min(1.6, Math.max(-1.6, lenis.velocity * .012));
  const max = document.documentElement.scrollHeight - innerHeight;
  progress = max > 0 ? clamp01(scrollY / max) : 0;
  if (motion.matches || !scene) draw(performance.now() / 1000);
}
function updateMotion() {
  lenis?.destroy(); lenis = undefined;
  gsap.ticker.remove(tick);
  if (!motion.matches && scene) {
    lenis = new Lenis({ lerp: .08, smoothWheel: true, syncTouch: false });
    lenis.on('scroll', onScroll);
    if (!document.hidden) gsap.ticker.add(tick);
  }
  onScroll();
}
function visibility() {
  gsap.ticker.remove(tick);
  lastTick = 0;
  if (!document.hidden && !motion.matches && scene) gsap.ticker.add(tick);
}
function resize() { scene?.resize(); for (const chapter of chapters) chapter.open = -1; onScroll(); }
function contextLost(event: Event) {
  event.preventDefault();
  gsap.ticker.remove(tick);
  lenis?.destroy(); lenis = undefined;
  scene?.dispose(); scene = undefined;
  canvas.hidden = true;
  select('#fallback').hidden = false;
  document.body.dataset.renderer = 'fallback';
  for (const chapter of chapters) chapter.section.classList.add('on');
}

motion.addEventListener('change', updateMotion);
document.addEventListener('visibilitychange', visibility);
addEventListener('resize', resize);
addEventListener('scroll', onScroll, { passive: true });
addEventListener('pointermove', event => {
  pointer.seen = true;
  pointer.tx = (event.clientX / innerWidth) * 2 - 1;
  pointer.ty = 1 - (event.clientY / innerHeight) * 2;
  pointer.cx = event.clientX; pointer.cy = event.clientY;
  pointer.hot = !!(event.target as Element).closest('a, button, input, label');
  for (const magnet of magnets) {
    const box = magnet.getBoundingClientRect();
    const dx = event.clientX - (box.left + box.width / 2), dy = event.clientY - (box.top + box.height / 2);
    magnet.style.transform = Math.hypot(dx, dy) < 70 ? `translate(${dx * .28}px, ${dy * .28}px)` : '';
  }
  document.body.dataset.cursor = pointer.hot ? 'hot' : 'idle';
}, { passive: true });
document.addEventListener('pointerleave', () => { document.body.dataset.cursor = 'away'; });
canvas.addEventListener('webglcontextlost', contextLost);
addEventListener('pagehide', event => { if (!event.persisted) { gsap.ticker.remove(tick); lenis?.destroy(); scene?.dispose(); } });
updateMotion();
await document.fonts.ready;
const target = chapters.find(chapter => chapter.id === frame || `#${chapter.id}` === location.hash);
if (target) {
  const top = target.section.getBoundingClientRect().top + scrollY - innerHeight * .12;
  if (lenis) lenis.scrollTo(top, { immediate: true, force: true }); else scrollTo(0, top);
  onScroll();
  draw(performance.now() / 1000);
}
document.body.dataset.ready = 'true';
