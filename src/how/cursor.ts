/**
 * unbelievablycrap's work cursor: a lagging blob with a wobbling multi-lobe edge, and trace marks dropped along the path that stay
 * where they were placed and age out (not a tail). Numbers are theirs: size .075 vh, lag .05, wobble .10, lobes 2.4, shape .85,
 * 23 marks, .4 s life, step .28, min interval 30 ms, shrink .55, ease 2.2, mark size .6.
 */
export class BlobCursor {
  private readonly ctx: CanvasRenderingContext2D;
  private x = innerWidth / 2; private y = innerHeight / 2; private tx = this.x; private ty = this.y;
  private readonly marks: { x: number; y: number; born: number }[] = [];
  private lastMark = 0; private lastX = 0; private lastY = 0;
  private seen = false; private hot = 0; private time = 0;
  constructor(private readonly canvas: HTMLCanvasElement, private readonly hotCheck: () => boolean) {
    this.ctx = canvas.getContext('2d')!;
    this.resize();
    addEventListener('resize', () => this.resize());
    addEventListener('pointermove', e => {
      this.seen = true; this.tx = e.clientX; this.ty = e.clientY;
      const now = performance.now(), size = innerHeight * .075;
      if (now - this.lastMark > 30 && Math.hypot(e.clientX - this.lastX, e.clientY - this.lastY) > size * .28) {
        this.marks.push({ x: e.clientX, y: e.clientY, born: now });
        if (this.marks.length > 23) this.marks.shift();
        this.lastMark = now; this.lastX = e.clientX; this.lastY = e.clientY;
      }
    }, { passive: true });
  }
  resize() {
    const r = Math.min(devicePixelRatio || 1, 2);
    this.canvas.width = innerWidth * r; this.canvas.height = innerHeight * r;
    this.ctx.setTransform(r, 0, 0, r, 0, 0);
  }
  draw(dt: number) {
    const c = this.ctx, now = performance.now();
    c.clearRect(0, 0, innerWidth, innerHeight);
    if (!this.seen) return;
    this.time += dt;
    this.x += (this.tx - this.x) * Math.min(1, dt * 60 * .05 * 2.4);
    this.y += (this.ty - this.y) * Math.min(1, dt * 60 * .05 * 2.4);
    this.hot += ((this.hotCheck() ? 1 : 0) - this.hot) * Math.min(1, dt * 10);
    const size = innerHeight * .075 * (1 - this.hot * .55);
    c.fillStyle = 'rgba(236,230,220,.9)';
    for (const m of this.marks) {
      const age = (now - m.born) / 400;
      if (age >= 1) continue;
      const life = 1 - Math.pow(age, 2.2);
      const r = size * .6 * .5 * (1 - .55 * (1 - life)) * .5;
      c.globalAlpha = life * .5;
      c.beginPath(); c.arc(m.x, m.y, Math.max(.5, r), 0, 6.2832); c.fill();
    }
    while (this.marks.length && now - this.marks[0].born > 400) this.marks.shift();
    c.globalAlpha = .85 * (1 - this.hot * .3) + this.hot * .15;
    c.beginPath();
    const R = size * .5 * .85, steps = 48;
    for (let i = 0; i <= steps; i++) {
      const a = (i / steps) * 6.2832;
      const w = 1 + .10 * Math.sin(a * 2.4 + this.time * 2.1) + .05 * Math.sin(a * 5.3 - this.time * 1.4);
      const px = this.x + Math.cos(a) * R * w * .2, py = this.y + Math.sin(a) * R * w * .2;
      i ? c.lineTo(px, py) : c.moveTo(px, py);
    }
    c.closePath(); c.fill();
    c.globalAlpha = 1;
  }
}
