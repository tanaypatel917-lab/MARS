/**
 * The bottom display-type carousel (Guillaume's home): one giant uppercase title per move, the centre one solid ivory, the
 * neighbours outlined and curved away as if printed on a drum. `position` is the smoothed fractional index the lead feeds to
 * the camera/fog; `update(dt)` advances it and writes the DOM transforms.
 *
 * Motion: a step glides the spring's input along cubic-bezier(.35,0,0,1) for ~1.1 s (the heavy Guillaume turn) and Lusion's
 * SecondOrderDynamics (f 1.5, ζ .8) follow it, so the titles settle with a hint of overshoot. Dragging scrubs the input
 * directly (mouse or touch) and snaps to the nearest title on release, with a fling. Under reduced motion the position is the
 * exact tween, no spring, no lift/skew.
 */
export interface CarouselOptions {
  reducedMotion: boolean;
  /** Start with the titles below the fold; `reveal()` brings them up (staggered from the centre). */
  enter?: boolean;
}

const F = 1.5, ZETA = .8;
const TURN = 1.1, TURN_EXTRA = .18;
const WHEEL_LOCK = 650, WHEEL_GAP = 90, WHEEL_MIN = 4;
const DRAG_START = 8, SWIPE = 40, FLING = .55, OVERDRAG = .22;
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

interface Glide { from: number; to: number; t: number; duration: number }
interface Drag { id: number; x0: number; y0: number; pos0: number; x: number; t: number; vx: number; active: boolean }

export class Carousel {
  private readonly titles: HTMLElement[] = [];
  private readonly glyphs: HTMLElement[] = [];
  private readonly listeners: (() => void)[] = [];
  private readonly callbacks: ((index: number) => void)[] = [];
  private readonly mobile: MediaQueryList | null;
  private target = 0;
  /** What the spring follows: the glide's value, or the pointer while dragging. */
  private input = 0;
  private glide: Glide | null = null;
  private y = 0; private yd = 0;
  private readonly k1 = ZETA / (Math.PI * F); private readonly k2 = 1 / ((2 * Math.PI * F) ** 2);
  private wheelLockUntil = 0; private lastWheel = -Infinity; private wheelArmed = true;
  private drag: Drag | null = null;
  private touchActionTarget: HTMLElement | null = null; private touchActionWas = '';
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
    if (options.enter) root.dataset.enter = '';
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
  /** True while the pointer is scrubbing the carousel — the page should ignore the click that ends it. */
  get dragging() { return !!this.drag?.active; }

  set(i: number) {
    const next = clamp(Math.round(i), 0, this.titles.length - 1);
    if (next === this.target && !this.drag) return;
    const changed = next !== this.target;
    this.target = next;
    const distance = Math.abs(next - this.input);
    this.glide = { from: this.input, to: next, t: 0, duration: distance < .02 ? 0 : TURN + TURN_EXTRA * Math.max(0, distance - 1) };
    this.dirty = true;
    this.mark();
    if (changed) for (const cb of this.callbacks) cb(next);
  }
  next() { this.step(1); }
  prev() { this.step(-1); }
  onChange(cb: (index: number) => void) { this.callbacks.push(cb); }
  /** Bring the titles up from below the fold (needs `enter: true`). */
  reveal() {
    if (!('enter' in this.root.dataset)) return;
    this.root.dataset.revealing = '';
    delete this.root.dataset.enter;
    const settle = 1200 + 90 * Math.max(this.target, this.titles.length - 1 - this.target) + 100;
    const timer = setTimeout(() => { delete this.root.dataset.revealing; }, settle);
    this.listeners.push(() => clearTimeout(timer));
  }

  update(dt: number) {
    if (this.destroyed) return;
    dt = clamp(dt, 0, 1 / 20);
    const now = performance.now();
    if (!this.wheelArmed && now - this.lastWheel > WHEEL_GAP) this.wheelArmed = true;
    if (this.glide && dt > 0) {
      const g = this.glide;
      g.t = g.duration > 0 ? Math.min(1, g.t + dt / g.duration) : 1;
      this.input = g.from + (g.to - g.from) * lusion(g.t);
      if (g.t >= 1) { this.input = g.to; this.glide = null; }
      this.dirty = true;
    }
    const x = this.input;
    if (this.options.reducedMotion) {
      if (this.y !== x) { this.yd = dt > 0 ? (x - this.y) / dt : 0; this.y = x; this.dirty = true; }
      else this.yd = 0;
    } else if (dt > 0 && (Math.abs(this.y - x) > EPS || Math.abs(this.yd) > EPS)) {
      const k2 = Math.max(this.k2, dt * dt / 2 + dt * this.k1 / 2, dt * this.k1);
      this.y += dt * this.yd;
      this.yd += dt * (x - this.y - this.k1 * this.yd) / k2;
      if (!this.glide && !this.drag && Math.abs(this.y - x) < EPS && Math.abs(this.yd) < EPS) { this.y = x; this.yd = 0; }
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
      const gap = now - this.lastWheel;
      this.lastWheel = now;
      if (gap > WHEEL_GAP) this.wheelArmed = true;
      if (!this.wheelArmed || now < this.wheelLockUntil || Math.abs(delta) < WHEEL_MIN || this.drag) return;
      this.wheelArmed = false;
      this.wheelLockUntil = now + WHEEL_LOCK;
      this.step(delta > 0 ? 1 : -1);
    }, { passive: false });

    // Horizontal pans must reach us as pointer moves instead of becoming native scroll.
    const host = target instanceof HTMLElement ? target : document.documentElement;
    this.touchActionTarget = host; this.touchActionWas = host.style.touchAction; host.style.touchAction = 'pan-y';
    on(target, 'pointerdown', (event) => {
      if (!event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) return;
      const el = event.target as HTMLElement | null;
      if (el?.closest('a,button,input,textarea,select,[data-no-drag]')) return;
      this.drag = { id: event.pointerId, x0: event.clientX, y0: event.clientY, pos0: this.y, x: event.clientX, t: performance.now(), vx: 0, active: false };
    });
    on(target, 'pointermove', (event) => {
      const d = this.drag;
      if (!d || event.pointerId !== d.id) return;
      const dx = event.clientX - d.x0, dy = event.clientY - d.y0;
      if (!d.active) {
        if (Math.abs(dx) < DRAG_START) return;
        if (Math.abs(dy) > Math.abs(dx) * 1.3) { this.drag = null; return; }
        d.active = true; d.pos0 = this.y; d.x0 = event.clientX; d.x = event.clientX;
        this.glide = null;
        this.root.classList.add('dragging');
      }
      const now = performance.now(), dtMs = now - d.t;
      if (dtMs > 0) { const v = (event.clientX - d.x) / dtMs; d.vx = d.vx * .6 + v * .4; }
      d.x = event.clientX; d.t = now;
      const raw = d.pos0 - (event.clientX - d.x0) / this.spacingPx();
      const last = this.titles.length - 1;
      this.input = raw < 0 ? raw * OVERDRAG : raw > last ? last + (raw - last) * OVERDRAG : raw;
      this.dirty = true;
      if (event.cancelable) event.preventDefault();
    }, { passive: false });
    const release = (event: PointerEvent) => {
      const d = this.drag;
      if (!d || event.pointerId !== d.id) return;
      this.drag = null;
      if (!d.active) return;
      this.root.classList.remove('dragging');
      const dx = event.clientX - d.x0;
      const fling = -d.vx * 1000 / this.spacingPx() * FLING;
      let next = Math.round(this.input + fling);
      const dir = Math.sign(-dx);
      if (Math.abs(dx) >= SWIPE && next === Math.round(d.pos0) && dir) next = Math.round(d.pos0) + dir;
      next = clamp(next, 0, this.titles.length - 1);
      const window_ = target instanceof Window ? target : window;
      const swallow = (e: Event) => { e.stopPropagation(); e.preventDefault(); };
      window_.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => window_.removeEventListener('click', swallow, { capture: true }), 120);
      this.set(next);
    };
    on(target, 'pointerup', release);
    on(target, 'pointercancel', release);

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
    if (this.touchActionTarget) this.touchActionTarget.style.touchAction = this.touchActionWas;
    this.callbacks.length = 0;
    this.root.replaceChildren();
    this.root.classList.remove('carousel', 'moving', 'dragging');
    delete this.root.dataset.enter; delete this.root.dataset.revealing;
  }

  private spacingPx() { return (this.mobile?.matches ? SPACING_MOBILE : SPACING) / 100 * Math.max(320, window.innerWidth); }

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
      title.style.setProperty('--k', String(Math.abs(i - this.target)));
    });
  }

  private write() {
    this.dirty = false;
    const pos = this.y, v = this.yd;
    const spacing = this.mobile?.matches ? SPACING_MOBILE : SPACING;
    const speed = Math.abs(v);
    const lift = clamp(speed * 9, 0, 12);
    const skew = clamp(-v * 2.4, -4.5, 4.5);
    const moving = !this.options.reducedMotion && (speed > .02 || !!this.drag?.active);
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
      // The centre carries the full lift; the drum's far titles trail it a little, like letters on a turning wheel.
      const trail = 1 - .18 * Math.min(a, 2);
      this.glyphs[i].style.transform = moving ? `translateY(${(-lift * trail).toFixed(2)}px) skewX(${(skew * trail).toFixed(2)}deg)` : '';
    });
  }
}
