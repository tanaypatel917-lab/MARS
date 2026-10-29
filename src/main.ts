import './style.css';
import gsap from 'gsap';
import { CustomEase } from 'gsap/CustomEase';
import Lenis from 'lenis';
import { MarsScene, type FrameState, type PanelView, type Pass } from './scene';
import { Ambient } from './audio';

gsap.registerPlugin(CustomEase);
const osmo = CustomEase.create('osmo', '0.625, 0.05, 0, 1');
const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const THREE_CLAMP = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const ease = (value: number, start: number, duration: number) => osmo(clamp01((value - start) / duration));

interface Panel { pass: Pass; label: string; x: number; y: number; w: number; h: number; open: number; element: HTMLElement }
const INTRO = 3.7;
const OPEN = .09;
const CLOSE_START = .78;
/** Panel rects in planet units: offsets from the planet centre and sizes as multiples of its on-screen radius, so the composition survives any viewport. */
const layout: Omit<Panel, 'open' | 'element'>[] = [
  { pass: 'wireframe', label: 'iter 000 · wireframe', x: -.85, y: -.81, w: 1.6, h: 1.375 },
  { pass: 'observe', label: 'iter 001 · observe', x: -.75, y: .31, w: .95, h: 1.0 },
  { pass: 'evaluate', label: 'iter 002 · evaluate', x: -.6, y: -1.5, w: 1.4, h: .81 },
  { pass: 'refine', label: 'iter 003 · refine', x: -1.4, y: -.78, w: 1.25, h: .81 },
  { pass: 'beauty', label: 'iter 004 · beauty', x: -.15, y: -.44, w: 1.1, h: .75 },
  { pass: 'beauty', label: 'iter 004 · beauty', x: .58, y: -.91, w: 1.8, h: 1.69 },
];
const planetRadius = () => innerWidth / innerHeight < 1 ? .39 * innerWidth : .32 * innerHeight;
const select = <T extends Element = HTMLElement>(selector: string) => {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing element: ${selector}`);
  return element;
};
const canvas = select<HTMLCanvasElement>('#scene');
const host = select('.panels');
const counter = select('#counter');
const end = select('#waitlist');
const form = select<HTMLFormElement>('#access-form');
const email = select<HTMLInputElement>('#email');
const soundButton = select<HTMLButtonElement>('#sound');
const motion = matchMedia('(prefers-reduced-motion: reduce)');
const query = new URLSearchParams(location.search);
const frame = query.get('frame');
const panels: Panel[] = layout.map(item => {
  const element = document.createElement('div');
  element.className = 'panel';
  element.innerHTML = `<div class="bar"><i></i><i></i><i></i><span>${item.label}</span></div>`;
  host.append(element);
  return { ...item, open: -1, element };
});
const ambient = new Ambient();
const cursor = select('#cursor');
const boot = select('#boot');
const fine = matchMedia('(pointer: fine)');
const pointer = { x: 0, y: 0, tx: 0, ty: 0, cx: innerWidth / 2, cy: innerHeight / 2, px: innerWidth / 2, py: innerHeight / 2, hot: false, seen: false };
let spin = 0, spinVelocity = 0;
const GLYPHS = '0123456789·abcdefghijklmnopqrstuvwxyz';
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
const rail = select('.rail i');
const magnets = [...document.querySelectorAll<HTMLElement>('.magnet')];
const endCopy = select('.end-copy');
endCopy.innerHTML = (endCopy.textContent ?? '').split(' ').map((word, i) => `<span class="word"><span style="transition-delay:${i * 45}ms">${word}</span></span>`).join(' ');
let scene: MarsScene | undefined;
let lenis: Lenis | undefined;
let progress = 0;
let introTime = 0;
let introFrozen = false;
let lastTick = 0;
let endShown = false;
let lastCounter = '';

try {
  scene = new MarsScene(canvas);
  document.body.dataset.renderer = 'ready';
} catch (error) {
  console.warn('MARS: WebGL unavailable, showing the outline only.', error);
  canvas.hidden = true;
  select('#fallback').hidden = false;
  document.body.dataset.renderer = 'fallback';
}

function panelViews(): PanelView[] {
  const radius = planetRadius(), cx = innerWidth / 2, cy = innerHeight / 2;
  const bar = Math.min(innerWidth, innerHeight) < 700 ? 20 : 24;
  const views: PanelView[] = [];
  panels.forEach((panel, i) => {
    const opening = ease(progress, .06 + i * .12, OPEN);
    const closing = ease(progress, CLOSE_START + (panels.length - 1 - i) * .012, .07);
    const open = opening * (1 - closing);
    const tear = opening > .02 && opening < .5 ? Math.round((Math.random() - .5) * 10 * (1 - opening * 2)) : 0;
    const left = Math.round(cx + panel.x * radius) + tear, top = Math.round(cy + panel.y * radius);
    const fullWidth = Math.round(panel.w * radius);
    const w = Math.round(fullWidth * open), h = Math.round(panel.h * radius * open);
    if (open !== panel.open || tear) {
      panel.open = open;
      const style = panel.element.style;
      style.left = `${left}px`;
      style.top = `${top}px`;
      style.width = `${w}px`;
      style.height = `${h}px`;
      style.display = w > 48 && h > bar + 10 ? '' : 'none';
      style.zIndex = String(i);
      (panel.element.firstElementChild as HTMLElement).style.width = `${fullWidth}px`;
    }
    if (h > bar + 10 && w > 48) views.push({ pass: panel.pass, x: left + 1, y: top + bar + 1, w: w - 2, h: h - bar - 2 });
  });
  return views;
}

function draw(now: number) {
  const dt = lastTick ? Math.min(.05, now - lastTick) : 0;
  lastTick = now;
  if (!introFrozen && introTime < INTRO) {
    introTime = Math.min(INTRO, introTime + dt);
    if (introTime >= INTRO) finishIntro();
  }
  const t = introTime;
  const views = panelViews();
  const open = panels.filter(p => p.open > .5).length;
  const beautyFade = ease(progress, .80, .12);
  const label = beautyFade > .5 ? 'iter 004 · beauty' : `iter ${String(Math.min(4, Math.max(0, open - 1))).padStart(3, '0')}`;
  if (label !== lastCounter) { lastCounter = label; scramble(counter, label); }
  const showEnd = progress > .9;
  if (showEnd !== endShown) { endShown = showEnd; end.classList.toggle('on', showEnd); }
  document.body.dataset.scrolled = String(progress > .015);
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
  if (t < INTRO && !introFrozen || frame === 'intro') boot.textContent = `tracing · ${String(Math.round(ease(t, .3, 1.5) * 100)).padStart(3, '0')}`;
  const state: FrameState = {
    time: now,
    outlineReveal: ease(t, .3, 1.5),
    outlineOpacity: 1 - beautyFade * .82,
    wireReveal: ease(t, 1.4, 1.4),
    wireOpacity: 1 - ease(t, 3.0, .6),
    beautyFade,
    settle: ease(progress, .86, .12),
    pointer: { x: pointer.x, y: pointer.y },
    spin,
    light: Math.min(1, t / 2.2) * (pointer.seen ? 1 : .35),
    horizon: ease(progress, .84, .14),
    word: ease(progress, .88, .12),
    panels: views,
  };
  if (!document.hidden) scene?.render(state);
}

function finishIntro() {
  if (document.body.dataset.intro !== 'running') return;
  document.body.dataset.intro = 'done';
  document.body.dataset.ui = 'on';
  lenis?.start();
}
function skipIntro() {
  if (introFrozen || introTime >= INTRO) return;
  gsap.to({ value: introTime }, { value: INTRO, duration: .7, ease: 'osmo', onUpdate() { introTime = this.targets()[0].value; } });
}
function tick(time: number) {
  lenis?.raf(time * 1000);
  draw(time);
}
function onScroll() {
  if (lenis) spinVelocity = THREE_CLAMP(lenis.velocity * .012, -1.6, 1.6);
  const max = document.documentElement.scrollHeight - innerHeight;
  progress = max > 0 ? clamp01(scrollY / max) : 0;
  if (motion.matches || !scene) draw(performance.now() / 1000);
}
function updateMotion() {
  lenis?.destroy(); lenis = undefined;
  gsap.ticker.remove(tick);
  if (motion.matches) { introTime = INTRO; finishIntro(); }
  if (!motion.matches && scene) {
    lenis = new Lenis({ lerp: .08, smoothWheel: true, syncTouch: false });
    lenis.on('scroll', onScroll);
    if (document.body.dataset.intro === 'running') lenis.stop();
    if (!document.hidden) gsap.ticker.add(tick);
  }
  onScroll();
}
function visibility() {
  gsap.ticker.remove(tick);
  lastTick = 0;
  if (!document.hidden && !motion.matches && scene) gsap.ticker.add(tick);
}
function resize() { scene?.resize(); for (const panel of panels) panel.open = -1; onScroll(); }
function jump(value: number) {
  const top = value * (document.documentElement.scrollHeight - innerHeight);
  if (lenis) lenis.scrollTo(top, { immediate: true, force: true }); else scrollTo(0, top);
  progress = value;
  draw(performance.now() / 1000);
}
function click(event: MouseEvent) {
  const target = (event.target as Element).closest<HTMLAnchorElement>('a[href^="#"]');
  if (!target) return;
  event.preventDefault();
  skipIntro();
  jump(target.hash === '#waitlist' ? 1 : 0);
  if (target.hash === '#waitlist') email.focus({ preventScroll: true });
}
function submit(event: SubmitEvent) {
  event.preventDefault();
  if (!form.reportValidity()) return;
  // TODO: post to the waitlist endpoint once one is chosen; nothing is stored yet.
  select('#form-message').textContent = 'received · demo only, your address was not stored';
  select<HTMLButtonElement>('#access-form button').textContent = 'on approach ✓';
  email.value = '';
}
async function toggleSound() {
  const on = soundButton.getAttribute('aria-pressed') === 'true';
  if (on) ambient.stop(); else await ambient.start();
  soundButton.setAttribute('aria-pressed', String(!on));
  soundButton.setAttribute('aria-label', on ? 'Ambient sound off' : 'Ambient sound on');
}
function contextLost(event: Event) {
  event.preventDefault();
  gsap.ticker.remove(tick);
  lenis?.destroy(); lenis = undefined;
  scene?.dispose(); scene = undefined;
  canvas.hidden = true;
  select('#fallback').hidden = false;
  document.body.dataset.renderer = 'fallback';
  finishIntro();
}

document.body.dataset.intro = frame && frame !== 'intro' ? 'done' : 'running';
if (document.body.dataset.intro === 'done') { introTime = INTRO; document.body.dataset.ui = 'on'; }
motion.addEventListener('change', updateMotion);
document.addEventListener('visibilitychange', visibility);
addEventListener('resize', resize);
addEventListener('scroll', onScroll, { passive: true });
addEventListener('wheel', skipIntro, { passive: true });
addEventListener('touchstart', skipIntro, { passive: true });
addEventListener('keydown', skipIntro);
document.addEventListener('click', click);
addEventListener('pointermove', event => {
  pointer.seen = true;
  pointer.tx = (event.clientX / innerWidth) * 2 - 1;
  pointer.ty = 1 - (event.clientY / innerHeight) * 2;
  pointer.cx = event.clientX; pointer.cy = event.clientY;
  pointer.hot = !!(event.target as Element).closest('a, button, input, label');
  for (const magnet of magnets) {
    const box = magnet.getBoundingClientRect();
    const dx = event.clientX - (box.left + box.width / 2), dy = event.clientY - (box.top + box.height / 2);
    const near = Math.hypot(dx, dy) < 70;
    magnet.style.transform = near ? `translate(${dx * .28}px, ${dy * .28}px)` : '';
  }
  document.body.dataset.cursor = pointer.hot ? 'hot' : 'idle';
}, { passive: true });
document.addEventListener('pointerleave', () => { document.body.dataset.cursor = 'away'; });
form.addEventListener('submit', submit);
soundButton.addEventListener('click', () => { void toggleSound(); });
canvas.addEventListener('webglcontextlost', contextLost);
addEventListener('pagehide', event => { if (!event.persisted) { gsap.ticker.remove(tick); lenis?.destroy(); scene?.dispose(); ambient.dispose(); } });
updateMotion();
await document.fonts.ready;
await document.fonts.load('500 380px Switzer').catch(() => undefined);
scene?.setWordmark('MARS', "500 380px Switzer, 'General Sans', sans-serif");
const frames: Record<string, number> = { rest: 0, mid: .48, full: .72, close: .845, beauty: .97 };
if (frame === 'intro' && !motion.matches) { introTime = 1.9; introFrozen = true; }
else if (frame && Object.hasOwn(frames, frame)) jump(frames[frame]);
else if (location.hash === '#waitlist') jump(1);
if (document.body.dataset.intro === 'running' && !introFrozen) setTimeout(() => { introTime = INTRO; finishIntro(); }, INTRO * 1000 + 600);
document.body.dataset.ready = 'true';
