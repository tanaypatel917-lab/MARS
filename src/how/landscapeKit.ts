import * as THREE from 'three';

/**
 * Builders for the landscape's hairline and light geometry. Every vertex carries the attributes the landscape shaders read:
 *   aBirth — the colonisation stage (0 … 4, fractional allowed) at which the element appears; `Landscape.stage` tweens 0→4 and
 *            elements draw on as the stage passes their birth,
 *   aT     — 0 … 1 along a stroke, so lines draw from their start to their end,
 *   aRise  — 0 for static elements; > 0 makes the element an ascending ship (it loops up out of the frame, speed ∝ aRise),
 *   aPhase — 0 … 1 per element, offsetting flicker / rise loops so nothing moves in unison,
 *   aSize  — points only: size multiplier.
 */
export type Vec3 = readonly [number, number, number];

export class Strokes {
  private readonly pos: number[] = []; private readonly birth: number[] = []; private readonly t: number[] = [];
  private readonly rise: number[] = []; private readonly phase: number[] = [];
  get count() { return this.pos.length / 6; }

  /** One straight hairline segment. */
  seg(a: Vec3, b: Vec3, birth: number, t0 = 0, t1 = 1, rise = 0, phase = 0) {
    this.pos.push(a[0], a[1], a[2], b[0], b[1], b[2]); this.birth.push(birth, birth); this.t.push(t0, t1); this.rise.push(rise, rise); this.phase.push(phase, phase);
    return this;
  }
  /** A polyline through `points`; aT runs 0 → 1 along its length. */
  poly(points: readonly Vec3[], birth: number, rise = 0, phase = 0) {
    let total = 0; const cum = [0];
    for (let i = 1; i < points.length; i++) { total += dist(points[i - 1], points[i]); cum.push(total); }
    for (let i = 1; i < points.length; i++) this.seg(points[i - 1], points[i], birth, cum[i - 1] / (total || 1), cum[i] / (total || 1), rise, phase);
    return this;
  }
  /** A closed circle (axis 'y' = flat on the ground, 'x'/'z' = standing). */
  circle(c: Vec3, r: number, birth: number, axis: 'x' | 'y' | 'z' = 'y', n = 40, rise = 0, phase = 0) { return this.arc(c, r, birth, 0, Math.PI * 2, axis, n, rise, phase); }
  /** An arc from angle a0 to a1. */
  arc(c: Vec3, r: number, birth: number, a0: number, a1: number, axis: 'x' | 'y' | 'z' = 'y', n = 24, rise = 0, phase = 0) {
    const pts: Vec3[] = [];
    for (let i = 0; i <= n; i++) { const a = a0 + (a1 - a0) * i / n, u = Math.cos(a) * r, v = Math.sin(a) * r; pts.push(axis === 'y' ? [c[0] + u, c[1], c[2] + v] : axis === 'z' ? [c[0] + u, c[1] + v, c[2]] : [c[0], c[1] + v, c[2] + u]); }
    return this.poly(pts, birth, rise, phase);
  }
  /** Append another builder's strokes. */
  merge(o: Strokes) { this.pos.push(...o.pos); this.birth.push(...o.birth); this.t.push(...o.t); this.rise.push(...o.rise); this.phase.push(...o.phase); return this; }

  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('aBirth', new THREE.Float32BufferAttribute(this.birth, 1));
    g.setAttribute('aT', new THREE.Float32BufferAttribute(this.t, 1));
    g.setAttribute('aRise', new THREE.Float32BufferAttribute(this.rise, 1));
    g.setAttribute('aPhase', new THREE.Float32BufferAttribute(this.phase, 1));
    return g;
  }
}

export class Sparks {
  private readonly pos: number[] = []; private readonly birth: number[] = []; private readonly size: number[] = [];
  private readonly rise: number[] = []; private readonly phase: number[] = [];
  get count() { return this.pos.length / 3; }
  /** One light. `size` multiplies the material's point size; `phase` defaults to a hash of the position. */
  add(p: Vec3, birth: number, size = 1, rise = 0, phase = hash(p)) {
    this.pos.push(p[0], p[1], p[2]); this.birth.push(birth); this.size.push(size); this.rise.push(rise); this.phase.push(phase);
    return this;
  }
  merge(o: Sparks) { this.pos.push(...o.pos); this.birth.push(...o.birth); this.size.push(...o.size); this.rise.push(...o.rise); this.phase.push(...o.phase); return this; }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('aBirth', new THREE.Float32BufferAttribute(this.birth, 1));
    g.setAttribute('aT', new THREE.Float32BufferAttribute(new Array(this.count).fill(0), 1));
    g.setAttribute('aSize', new THREE.Float32BufferAttribute(this.size, 1));
    g.setAttribute('aRise', new THREE.Float32BufferAttribute(this.rise, 1));
    g.setAttribute('aPhase', new THREE.Float32BufferAttribute(this.phase, 1));
    return g;
  }
}

/**
 * Low-poly solid geometry (boulders, moons, hull plates, crater rims …) for `Landscape.addSolid`: non-indexed triangles with
 * `aRelief` (drives the basalt→rust albedo like the terrain: ≤ POOL reads as pool, 1 … 8 basalt → rust) and `aBirth`.
 */
export class Solids {
  private readonly pos: number[] = []; private readonly relief: number[] = []; private readonly birth: number[] = [];
  tri(a: Vec3, b: Vec3, c: Vec3, relief: number, birth = 0) {
    this.pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]); this.relief.push(relief, relief, relief); this.birth.push(birth, birth, birth);
    return this;
  }
  /** Bake any three geometry (indexed or not) at a position/scale/rotation into the pile. */
  mesh(geometry: THREE.BufferGeometry, matrix: THREE.Matrix4, relief: number, birth = 0) {
    const g = geometry.index ? geometry.toNonIndexed() : geometry; const p = g.getAttribute('position'); const v = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) { v.fromBufferAttribute(p, i).applyMatrix4(matrix); this.pos.push(v.x, v.y, v.z); this.relief.push(relief); this.birth.push(birth); }
    if (g !== geometry) g.dispose();
    return this;
  }
  merge(o: Solids) { this.pos.push(...o.pos); this.relief.push(...o.relief); this.birth.push(...o.birth); return this; }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('aRelief', new THREE.Float32BufferAttribute(this.relief, 1));
    g.setAttribute('aBirth', new THREE.Float32BufferAttribute(this.birth, 1));
    return g;
  }
}

export const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
export const lerp3 = (a: Vec3, b: Vec3, t: number): Vec3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
export const hash = (p: Vec3) => { const h = Math.sin(p[0] * 127.1 + p[1] * 311.7 + p[2] * 74.7) * 43758.5453; return h - Math.floor(h); };
