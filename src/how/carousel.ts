/**
 * The bottom display-type carousel (Guillaume's home): one giant uppercase title per move, the centre one solid ivory, the
 * neighbours outlined and curved away as if printed on a drum. `position` is the smoothed fractional index the lead feeds to
 * the camera/fog; `update(dt)` advances it (Lusion's SecondOrderDynamics, or an exact Lusion-eased tween under reduced motion)
 * and writes the DOM transforms. Input (wheel / swipe / keys / side-title click) is attached with `bind`.
 */
export interface CarouselOptions { reducedMotion: boolean }

const F = 1.5, ZETA = .8;
const WHEEL_LOCK = 650, WHEEL_GAP = 180, WHEEL_PAUSE = 450, WHEEL_MIN = 4;
const SWIPE = 40;
const TWEEN = 1100;
const SPACING = 56, SPACING_MOBILE = 70;
const DEPTH = 260, TILT = -32;
const RUBBER = .9;
const EPS = 1e-4;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const smooth = (edge0: number, edge1: number, x: number) => { const t = clamp((x - edge0) / (edge1 - edge0), 0, 1); return t * t * (3 - 2 * t); };

/** cubic-bezier(.35,0,0,1) solved for y at a given x (Newton, then bisection fallback). */
const lusion = (() => {
  const p1x = .35, p1y = 0, p2x = 0, p2y = 1;
  const ax = 1 - 3 * p2x + 3 * p1x, bx = 3 * p2x - 6 * p1x, cx = 3 * p1x;
  const ay = 1 - 3 * p2y + 3 * p1y, by = 3 * p2y - 6 * p1y, cy = 3 * p1y;
  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t;
  const slopeX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  return (x: number) => {
    if (x <= 0) return 0; if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) { const dx = sampleX(t) - x; if (Math.abs(dx) < 1e-6) return sampleY(t); const d = slopeX(t); if (Math.abs(d) < 1e-6) break; t -= dx / d; }
    let lo = 0, hi = 1; t = x;
    while (hi - lo > 1e-6) { if (sampleX(t) < x) lo = t; else hi = t; t = (lo + hi) / 2; }
    return sampleY(t);
  };
})();

export class Carousel {
  private readonly titles: HTMLElement[] = [];
  private readonly glyphs: HTMLElement[] = [];
  private readonly listeners: (() => void)[] = [];
  private readonly callbacks: ((index: number) => void)[] = [];
  private readonly mobile: MediaQueryList | null;
  private target = 0;
  private y = 0; private yd = 0;
  private readonly k1 = ZETA / (Math.PI * F); private readonly k2 = 1 / ((2 * Math.PI * F) ** 2);
  private tween: { from: number; to: number; t: number } | null = null;
  private wheelLockUntil = 0; private lastWheel = -Infinity; private wheelArmed = true; private lastWheelSize = 0;
  private touch: { x: number; y: number; done: boolean } | null = null;
  private dirty = true;
  private destroyed = false;

  constructor(private readonly root: HTMLElement, titles: string[], private readonly options: CarouselOptions) {
    if (!titles.length) throw new Error('Carousel needs at least one title');
    root.classList.add('carousel');
    root.replaceChildren();
    titles.forEach((text, i) => {
      const title = document.createElement('h2');
      title.className = 'title';
      const glyph = document.createElement('span');
      text.split('\n').forEach((line, j) => { if (j) glyph.append(document.createElement('br')); glyph.append(line); });
      title.append(glyph);
      title.dataset.index = String(i);
      root.append(title);
      this.titles.push(title); this.glyphs.push(glyph);
    });
    this.mobile = typeof matchMedia === 'function' ? matchMedia('(max-width:700px)') : null;
    if (this.mobile) {
      const onChange = () => { this.dirty = true; };
      this.mobile.addEventListener('change', onChange);
      this.listeners.push(() => this.mobile?.removeEventListener('change', onChange));
    }
    this.mark();
  }

  get index() { return this.target; }
  get position() { return this.y; }
  get length() { return this.titles.length; }
  /** Smoothed velocity in titles per second (what the lift/skew read). */
  get velocity() { return this.yd; }

  set(i: number) {
    const next = clamp(Math.round(i), 0, this.titles.length - 1);
    if (next === this.target) return;
    this.target = next;
    if (this.options.reducedMotion) this.tween = { from: this.y, to: next, t: 0 };
    this.dirty = true;
    this.mark();
    for (const cb of this.callbacks) cb(next);
  }
  next() { this.step(1); }
  prev() { this.step(-1); }
  onChange(cb: (index: number) => void) { this.callbacks.push(cb); }

  update(dt: number) {
    if (this.destroyed) return;
    dt = clamp(dt, 0, 1 / 20);
    const now = performance.now();
    if (!this.wheelArmed && now - this.lastWheel > WHEEL_PAUSE) this.wheelArmed = true;
    const x = this.target;
    if (this.options.reducedMotion) {
      if (this.tween) {
        const tw = this.tween; tw.t = Math.min(1, tw.t + dt * 1000 / TWEEN);
        const prev = this.y;
        this.y = tw.from + (tw.to - tw.from) * lusion(tw.t);
        this.yd = dt > 0 ? (this.y - prev) / dt : 0;
        if (tw.t >= 1) { this.tween = null; this.y = x; this.yd = 0; }
        this.dirty = true;
      }
    } else if (dt > 0 && (Math.abs(this.y - x) > EPS || Math.abs(this.yd) > EPS)) {
      const k2 = Math.max(this.k2, dt * dt / 2 + dt * this.k1 / 2, dt * this.k1);
      this.y += dt * this.yd;
      this.yd += dt * (x - this.y - this.k1 * this.yd) / k2;
      if (Math.abs(this.y - x) < EPS && Math.abs(this.yd) < EPS) { this.y = x; this.yd = 0; }
      this.dirty = true;
    }
    if (this.dirty) this.write();
  }

  bind(target: EventTarget) {
    const on = <K extends keyof GlobalEventHandlersEventMap>(el: EventTarget, type: K, handler: (event: GlobalEventHandlersEventMap[K]) => void, options?: AddEventListenerOptions) => {
      const fn = handler as EventListener;
      el.addEventListener(type, fn, options);
      this.listeners.push(() => el.removeEventListener(type, fn, options));
    };
    on(target, 'wheel', (event) => {
      if (event.cancelable) event.preventDefault();
      const now = performance.now();
      const delta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
      const gap = now - this.lastWheel, size = Math.abs(delta), grew = size > this.lastWheelSize * 1.25;
      this.lastWheel = now; this.lastWheelSize = size;
      // a new gesture is a real pause, or a quiet gap followed by a *growing* delta (an inertia tail only decays — and slow frames stretch its gaps)
      if (gap > WHEEL_PAUSE || (gap > WHEEL_GAP && grew)) this.wheelArmed = true;
      if (!this.wheelArmed || now < this.wheelLockUntil || Math.abs(delta) < WHEEL_MIN) return;
      this.wheelArmed = false;
      this.wheelLockUntil = now + WHEEL_LOCK;
      this.step(delta > 0 ? 1 : -1);
    }, { passive: false });
    on(target, 'touchstart', (event) => {
      const t = event.touches[0];
      this.touch = t ? { x: t.clientX, y: t.clientY, done: false } : null;
    }, { passive: true });
    on(target, 'touchmove', (event) => {
      const t = event.touches[0];
      if (!this.touch || this.touch.done || !t) return;
      const dx = t.clientX - this.touch.x, dy = t.clientY - this.touch.y;
      if (Math.abs(dx) < SWIPE || Math.abs(dx) < Math.abs(dy) * 1.2) return;
      this.touch.done = true;
      this.step(dx < 0 ? 1 : -1);
    }, { passive: true });
    on(target, 'touchend', () => { this.touch = null; }, { passive: true });
    on(target, 'keydown', (event) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      const el = event.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      switch (event.key) {
        case 'ArrowRight': case 'ArrowDown': case 'PageDown': this.step(1); break;
        case 'ArrowLeft': case 'ArrowUp': case 'PageUp': this.step(-1); break;
        case 'Home': this.set(0); break;
        case 'End': this.set(this.titles.length - 1); break;
        default: return;
      }
      event.preventDefault();
    });
    this.titles.forEach((title, i) => on(title, 'click', (event) => {
      if (i === this.target) return;
      event.preventDefault();
      this.set(i);
    }));
  }

  destroy() {
    this.destroyed = true;
    for (const off of this.listeners.splice(0)) off();
    this.callbacks.length = 0;
    this.root.replaceChildren();
    this.root.classList.remove('carousel', 'moving');
  }

  /** One step, with a velocity kick against the end stops that the spring pulls back (the rubber-band). */
  private step(dir: 1 | -1) {
    const next = this.target + dir;
    if (next < 0 || next >= this.titles.length) {
      if (!this.options.reducedMotion) { this.yd += dir * RUBBER; this.dirty = true; }
      return;
    }
    this.set(next);
  }

  private mark() {
    this.titles.forEach((title, i) => {
      if (i === this.target) { title.setAttribute('aria-current', 'true'); title.dataset.active = ''; }
      else { title.removeAttribute('aria-current'); delete title.dataset.active; }
    });
  }

  private write() {
    this.dirty = false;
    const pos = this.y, v = this.yd;
    const spacing = this.mobile?.matches ? SPACING_MOBILE : SPACING;
    const speed = Math.abs(v);
    const lift = clamp(speed * 9, 0, 12).toFixed(2);
    const skew = clamp(-v * 2.4, -4.5, 4.5).toFixed(2);
    const moving = speed > .02;
    this.root.classList.toggle('moving', moving);
    this.root.style.setProperty('--velocity', v.toFixed(4));
    this.titles.forEach((title, i) => {
      const d = i - pos, a = Math.abs(d);
      if (a > 2.6) { if (title.style.visibility !== 'hidden') title.style.visibility = 'hidden'; return; }
      if (title.style.visibility) title.style.visibility = '';
      const solid = smooth(.5, .12, a);
      const opacity = clamp(1 - .36 * a, 0, 1) * (1 - solid) + solid;
      title.style.transform = `translate3d(${(d * spacing).toFixed(3)}vw,0,${(-a * DEPTH).toFixed(1)}px) rotateY(${(d * TILT).toFixed(2)}deg)`;
      title.style.opacity = opacity.toFixed(3);
      title.style.setProperty('--solid', solid.toFixed(3));
      title.style.setProperty('--stroke', (.55 * (1 - solid)).toFixed(3));
      this.glyphs[i].style.transform = moving ? `translateY(${-lift}px) skewX(${skew}deg)` : '';
    });
  }
}
