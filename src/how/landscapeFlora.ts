import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { fbm } from '../geometry';
import { noise } from '../shaders';
import { heightAt, normalAt, seeded, FOG, POOL, BASE, FOG_K, FOG_SCALE_HEIGHT, HORIZON } from './landscapeTerrain';
import { skyChunk } from './landscapeShaders';
import { CRATERS } from './landscapeGroundRelief';

/**
 * Life and weather on the plain under the /how stele — the one cool accent in a black / rust / basalt frame:
 *
 *   bioluminescent flora  smooth tessellated plants (tapered tube stalks with lantern pods, bulbous ground lanterns, glow-moss
 *                         mats, antler trees by the colony from stage 2) in clusters on the pool shores, the crater floors and
 *                         the dune feet, 20 … 140 u out all around. One indexed mesh with its own beauty-pass shader: dark
 *                         translucent body with subsurface wrap light, emissive veins and pod skins from fbm noise that pulse
 *                         slowly on each plant's own phase, lit by the key, tinted by the fog and hazed into the sky like the
 *                         terrain. The glow is barren at stage 0 and lush at 4; plants grow up out of the ground as uStage
 *                         passes their aBirth. GPU sway: two superposed sines, bend ∝ height², ≤ .08 rad.
 *   halos + ground glow   additive gaussian points at every pod (size attenuating with distance) and a ground-hugging additive
 *                         disc under each cluster so the plants bloom in the dark and tint the ground.
 *   spores                from stage 3, motes lazily rising from the moss mats.
 *   dust motes            ~1500 additive points drifting in the 20 … 90 u band, catching the key light, denser near the pools.
 *   dust devils           two slender translucent columns (lathe funnels) spinning with a scrolling noise alpha, wandering
 *                         along seeded paths, dissolving at the top.
 *   meteors               one streak at a time every ~6 … 12 s, GPU-timed from uTime, high in the sky over the fog band.
 *   pool mist             faint fog sheets drifting over the wider pools.
 *
 * Everything is deterministic (seeded()), all motion is in the shaders via uTime; `update` only copies uniforms (and walks the
 * two dust devils along their paths, two heightAt calls).
 */
export function buildFlora(calm = false): {
  objects: THREE.Object3D[];
  update(time: number, camera: THREE.Camera, key: THREE.Vector3, fog: THREE.Color, stage: number): void;
  dispose(): void;
  stats: { triangles: number; points: number; lineVertices: number };
} {
  const rand = seeded(4471);
  const plants = new Plants(), halos = new Halos(), discs = new Discs(), spores = new Spores();
  const clusters = sites(rand);
  for (const c of clusters) cluster(c, plants, halos, discs, spores, rand);
  trees(plants, halos, rand);

  const materials: THREE.ShaderMaterial[] = [];
  const objects: THREE.Object3D[] = [];
  const geometries: THREE.BufferGeometry[] = [];
  let triangles = 0, points = 0, lineVertices = 0;
  const add = (o: THREE.Object3D, g: THREE.BufferGeometry, m: THREE.ShaderMaterial) => { o.frustumCulled = false; objects.push(o); geometries.push(g); materials.push(m); };

  { const g = plants.geometry(), m = material(floraVertex, floraFragment, {}); add(new THREE.Mesh(g, m), g, m); triangles += g.index!.count / 3; }
  { const g = halos.geometry(), m = material(haloVertex, haloFragment, { uSize: { value: 1 } }, THREE.AdditiveBlending); add(new THREE.Points(g, m), g, m); points += g.attributes.position.count; }
  { const g = discs.geometry(), m = material(discVertex, discFragment, {}, THREE.AdditiveBlending); add(new THREE.Mesh(g, m), g, m); triangles += g.index!.count / 3; }
  { const g = spores.geometry(), m = material(sporeVertex, haloFragment, { uSize: { value: 1 } }, THREE.AdditiveBlending); add(new THREE.Points(g, m), g, m); points += g.attributes.position.count; }
  if (!calm) { const g = motes(rand), m = material(moteVertex, moteFragment, { uSize: { value: 1 } }, THREE.AdditiveBlending); add(new THREE.Points(g, m), g, m); points += g.attributes.position.count; }
  const devils = (calm ? [] : DEVILS).map(d => { const g = funnel(d.height), m = material(devilVertex, devilFragment, { uPos: { value: new THREE.Vector3() }, uSeed: { value: d.seed }, uHeight: { value: d.height } }, THREE.NormalBlending, THREE.DoubleSide); add(new THREE.Mesh(g, m), g, m); triangles += g.index!.count / 3; return { ...d, m }; });
  if (!calm) { const g = mist(clusters, rand), m = material(mistVertex, mistFragment, {}, THREE.NormalBlending, THREE.DoubleSide); add(new THREE.Mesh(g, m), g, m); triangles += g.index!.count / 3; }
  if (!calm) { const g = meteor(), m = material(meteorVertex, meteorFragment, {}, THREE.AdditiveBlending); add(new THREE.Line(g, m), g, m); lineVertices += g.attributes.position.count; }

  const ratio = Math.min((typeof devicePixelRatio === 'number' ? devicePixelRatio : 1) || 1, 2);
  for (const m of materials) if (m.uniforms.uSize) m.uniforms.uSize.value = ratio;

  return {
    objects,
    stats: { triangles, points, lineVertices },
    update(time, camera, key, fog, stage) {
      for (const m of materials) {
        const u = m.uniforms;
        u.uTime.value = time; u.uStage.value = stage; u.uCamera.value.copy(camera.position); u.uKey.value.copy(key).normalize(); u.uFog.value.copy(fog);
      }
      for (const d of devils) {
        const t = time * d.speed + d.seed;
        const x = d.x + Math.sin(t) * d.wander + Math.sin(t * 2.3 + 1.) * d.wander * .3, z = d.z + Math.cos(t * .8) * d.wander;
        d.m.uniforms.uPos.value.set(x, heightAt(x, z).y - .3, z);
      }
    },
    dispose() { for (const g of geometries) g.dispose(); for (const m of materials) m.dispose(); },
  };
}

// ─── placement ────────────────────────────────────────────────────────────────────────────────────────────────────────

const TAU = Math.PI * 2, UP = new THREE.Vector3(0, 1, 0);
const ground = (x: number, z: number) => heightAt(x, z).y;
type Cluster = { x: number; z: number; kind: 'shore' | 'crater' | 'dune'; birth: number; tint: number; r: number };
/** Colony anchors (habitat / pad sites of the sibling modules) — the amber variant and the antler trees gather here. */
const COLONY: readonly (readonly [number, number])[] = [[-38, -52], [52, -40], [20, -70], [-60, 20], [-24, 28], [6, 40], [-30, -26], [34, 18]];
const nearColony = (x: number, z: number, d = 16) => COLONY.some(c => Math.hypot(x - c[0], z - c[1]) < d);

/** A pool shore: dry ground just above the water with open water within 3.5 u. */
function isShore(x: number, z: number) {
  const h = heightAt(x, z).relief;
  if (h < POOL + .22 || h > POOL + 1.1) return false;
  for (let k = 0; k < 8; k++) { const a = k / 8 * TAU; if (heightAt(x + Math.cos(a) * 3.5, z + Math.sin(a) * 3.5).relief <= POOL + .01) return true; }
  return false;
}

/** Cluster sites: ~26 pool shores, the crater floors in reach, ~12 dune-foot hollows; 20 … 140 u out, all around. */
function sites(rand: () => number): Cluster[] {
  const out: Cluster[] = [];
  const apart = (x: number, z: number, d: number) => out.every(c => Math.hypot(c.x - x, c.z - z) > d);
  const birthFor = (r: number) => { const u = rand(); return (u < .2 ? 0 : u < .45 ? 1 : u < .8 ? 2 : 3) + rand() * .5 + (r > 100 ? .4 : 0); };
  for (let tries = 0; tries < 9000 && out.length < 28; tries++) {
    const a = rand() * TAU, r = 22 + Math.pow(rand(), .8) * 110, x = Math.cos(a) * r, z = Math.sin(a) * r;
    if (!isShore(x, z) || !apart(x, z, 11)) continue;
    out.push({ x, z, kind: 'shore', birth: birthFor(r), tint: nearColony(x, z) ? 2 : rand() < .6 ? 0 : 1, r: 2.6 });
  }
  for (const c of CRATERS) {
    const r = Math.hypot(c[0], c[1]); if (r > 135) continue;
    const a = rand() * TAU, d = rand() * c[2] * .4, x = c[0] + Math.cos(a) * d, z = c[1] + Math.sin(a) * d;
    out.push({ x, z, kind: 'crater', birth: (r < 60 ? 0 : r < 90 ? 1 : 2) + rand() * .5, tint: rand() < .5 ? 1 : 0, r: c[2] * .35 });
  }
  for (let tries = 0; tries < 6000 && out.length < 54; tries++) {
    const a = rand() * TAU, r = 24 + Math.pow(rand(), .8) * 100, x = Math.cos(a) * r, z = Math.sin(a) * r;
    const h = heightAt(x, z).relief;
    if (h < POOL + .5 || h > POOL + 2.2 || !apart(x, z, 12) || CRATERS.some(c => Math.hypot(c[0] - x, c[1] - z) < c[2] * 1.9)) continue;
    out.push({ x, z, kind: 'dune', birth: birthFor(r), tint: nearColony(x, z) ? 2 : rand() < .5 ? 0 : 1, r: 2.2 });
  }
  return out;
}

/** One cluster: 1 … 2 stalks, 2 … 3 lanterns, a moss mat, a glow disc under it all; spores from the moss at stage 3+. */
function cluster(c: Cluster, plants: Plants, halos: Halos, discs: Discs, spores: Spores, rand: () => number) {
  const spot = (r: number) => { for (let k = 0; k < 12; k++) { const a = rand() * TAU, d = Math.sqrt(rand()) * r, x = c.x + Math.cos(a) * d, z = c.z + Math.sin(a) * d; if (heightAt(x, z).relief > POOL + .12) return [x, z] as const; } return null; };
  const far = Math.hypot(c.x, c.z), lod = far > 95 ? 0 : 1;
  const stalks = 1 + (rand() < .5 ? 1 : 0), lanterns = 2;
  for (let i = 0; i < stalks; i++) { const p = spot(c.r); if (p) stalk(plants, halos, p[0], p[1], 1 + rand() * 2, c.birth + rand() * .3, c.tint, lod, rand); }
  for (let i = 0; i < lanterns; i++) { const p = spot(c.r * 1.1); if (p) lantern(plants, halos, p[0], p[1], .3 + rand() * .5, c.birth + rand() * .4, c.tint, lod, rand); }
  const lobes = far < 100 ? 2 : 1;
  for (let i = 0; i < lobes; i++) {
    const m = spot(c.r * .9);
    if (!m) continue;
    moss(plants, m[0], m[1], .7 + rand() * .9, c.birth + rand() * .2, c.tint, rand);
    if (i === 0 && far < 110) spores.add(m[0], ground(m[0], m[1]), m[1], 8 + Math.floor(rand() * 6), rand);
  }
  discs.add(c.x, c.z, c.r * 1.5 + .8, c.birth + .2, c.tint, rand);
}

/** Antler trees, 4 … 6 u, by the colony from stage 2 (one per anchor that has land). */
function trees(plants: Plants, halos: Halos, rand: () => number) {
  for (const [ax, az] of COLONY) {
    for (let k = 0; k < 10; k++) {
      const a = rand() * TAU, d = 9 + rand() * 5, x = ax + Math.cos(a) * d, z = az + Math.sin(a) * d;
      if (heightAt(x, z).relief <= POOL + .4) continue;
      antler(plants, halos, x, z, 4 + rand() * 2, 2 + rand() * 1.2, rand);
      break;
    }
  }
}

// ─── plant geometry ───────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * All plants in one indexed geometry. Per vertex: position (world), normal, aLocal (offset from the plant's base in world units —
 * the vertex shader grows and sways around that base), aInfo (seed, phase, birth, plant height), aGlow (0 … 1 emissive mask:
 * pods 1, moss .55, stalks brightening toward the tip), aTint (0 teal, 1 violet, 2 amber).
 */
class Plants {
  private readonly pos: number[] = []; private readonly nor: number[] = []; private readonly loc: number[] = []; private readonly info: number[] = [];
  private readonly glow: number[] = []; private readonly tint: number[] = []; private readonly index: number[] = [];
  /** Bake a local geometry (indexed, with normals and an `aGlow` attribute) at `m`, rooted at `base`. */
  add(g: THREE.BufferGeometry, m: THREE.Matrix4, base: THREE.Vector3, height: number, birth: number, tint: number, seed: number, phase: number) {
    const nm = new THREE.Matrix3().getNormalMatrix(m), p = g.attributes.position, n = g.attributes.normal, gl = g.attributes.aGlow, idx = g.index!;
    const start = this.pos.length / 3, v = new THREE.Vector3(), w = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).applyMatrix4(m); this.pos.push(v.x, v.y, v.z);
      this.loc.push(v.x - base.x, v.y - base.y, v.z - base.z);
      w.fromBufferAttribute(n, i).applyMatrix3(nm).normalize(); this.nor.push(w.x, w.y, w.z);
      this.info.push(seed, phase, birth, height); this.glow.push(gl.getX(i)); this.tint.push(tint);
    }
    for (let i = 0; i < idx.count; i++) this.index.push(idx.getX(i) + start);
    g.dispose();
  }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('aLocal', new THREE.Float32BufferAttribute(this.loc, 3));
    g.setAttribute('aInfo', new THREE.Float32BufferAttribute(this.info, 4));
    g.setAttribute('aGlow', new THREE.Float32BufferAttribute(this.glow, 1));
    g.setAttribute('aTint', new THREE.Float32BufferAttribute(this.tint, 1));
    g.setIndex(this.index);
    return g;
  }
}

/** Additive pod halos: position, aSize (world radius of the glow), aPhase, aBirth, aTint. */
class Halos {
  private readonly pos: number[] = []; private readonly size: number[] = []; private readonly phase: number[] = []; private readonly birth: number[] = []; private readonly tint: number[] = [];
  add(p: THREE.Vector3, size: number, phase: number, birth: number, tint: number) { this.pos.push(p.x, p.y, p.z); this.size.push(size); this.phase.push(phase); this.birth.push(birth); this.tint.push(tint); }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('aSize', new THREE.Float32BufferAttribute(this.size, 1));
    g.setAttribute('aPhase', new THREE.Float32BufferAttribute(this.phase, 1));
    g.setAttribute('aBirth', new THREE.Float32BufferAttribute(this.birth, 1));
    g.setAttribute('aTint', new THREE.Float32BufferAttribute(this.tint, 1));
    return g;
  }
}

/** Ground glow discs hugging the terrain: a polar mesh (2 rings × 12) with aUv (unit radius), aInfo (phase, birth, tint). */
class Discs {
  private readonly pos: number[] = []; private readonly uv: number[] = []; private readonly info: number[] = []; private readonly index: number[] = [];
  add(x: number, z: number, R: number, birth: number, tint: number, rand: () => number) {
    const start = this.pos.length / 3, phase = rand(), rings = 2, segs = 12;
    this.pos.push(x, ground(x, z) + .12, z); this.uv.push(0, 0); this.info.push(phase, birth, tint);
    for (let r = 1; r <= rings; r++) for (let s = 0; s < segs; s++) {
      const a = s / segs * TAU, d = R * r / rings, px = x + Math.cos(a) * d, pz = z + Math.sin(a) * d;
      this.pos.push(px, ground(px, pz) + .12, pz); this.uv.push(r / rings, a); this.info.push(phase, birth, tint);
    }
    for (let s = 0; s < segs; s++) this.index.push(start, start + 1 + s, start + 1 + (s + 1) % segs);
    for (let r = 1; r < rings; r++) for (let s = 0; s < segs; s++) {
      const a = start + 1 + (r - 1) * segs + s, b = start + 1 + (r - 1) * segs + (s + 1) % segs, c = a + segs, d = b + segs;
      this.index.push(a, c, b, b, c, d);
    }
  }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('aUv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('aInfo', new THREE.Float32BufferAttribute(this.info, 3));
    g.setIndex(this.index);
    return g;
  }
}

/** Spores: points rising from a moss mat (base position, aPhase, aBirth = 3, aTint teal, aSize). */
class Spores {
  private readonly h = new Halos();
  private readonly v = new THREE.Vector3();
  add(x: number, y: number, z: number, n: number, rand: () => number) { for (let i = 0; i < n; i++) this.h.add(this.v.set(x + (rand() - .5) * 2, y, z + (rand() - .5) * 2), .5 + rand() * .5, rand(), 3 + rand() * .3, 0); }
  geometry() { return this.h.geometry(); }
}

/** Tags an `aGlow` attribute onto a geometry from a per-vertex function. */
function glowAttr(g: THREE.BufferGeometry, f: (p: THREE.Vector3, i: number) => number) {
  const p = g.attributes.position, v = new THREE.Vector3(), out = new Float32Array(p.count);
  for (let i = 0; i < p.count; i++) out[i] = f(v.fromBufferAttribute(p, i), i);
  g.setAttribute('aGlow', new THREE.BufferAttribute(out, 1));
  return g;
}

/**
 * A tapered tube along a curve: parallel-transported ring frames, radius from `radius(t)`, smooth analytic normals, capped by
 * pinching the last ring to the tip. `t` runs 0 (root) → 1 (tip).
 */
function tube(curve: THREE.Curve<THREE.Vector3>, radius: (t: number) => number, along: number, around: number) {
  const pos: number[] = [], nor: number[] = [], idx: number[] = [];
  const pts = curve.getPoints(along), tan = new THREE.Vector3(), nrm = new THREE.Vector3(1, 0, 0), bin = new THREE.Vector3(), v = new THREE.Vector3();
  for (let i = 0; i <= along; i++) {
    const t = i / along;
    tan.subVectors(pts[Math.min(along, i + 1)], pts[Math.max(0, i - 1)]).normalize();
    nrm.sub(tan.clone().multiplyScalar(nrm.dot(tan))).normalize(); if (nrm.lengthSq() < .5) nrm.set(0, 0, 1).cross(tan).normalize();
    bin.crossVectors(tan, nrm);
    const r = radius(t);
    for (let j = 0; j < around; j++) {
      const a = j / around * TAU, cx = Math.cos(a), sx = Math.sin(a);
      v.copy(nrm).multiplyScalar(cx).addScaledVector(bin, sx);
      pos.push(pts[i].x + v.x * r, pts[i].y + v.y * r, pts[i].z + v.z * r);
      // taper tilts the normal toward the tangent
      const slope = (radius(Math.min(1, t + .02)) - radius(Math.max(0, t - .02))) / (.04 * (curve.getLength() || 1));
      v.addScaledVector(tan, -slope).normalize(); nor.push(v.x, v.y, v.z);
    }
  }
  for (let i = 0; i < along; i++) for (let j = 0; j < around; j++) {
    const a = i * around + j, b = i * around + (j + 1) % around, c = a + around, d = b + around;
    idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setIndex(idx);
  return g;
}

/** A pod: a tessellated icosphere (detail 1 … 3), fbm-displaced, elongated and pinched toward the top into a lantern drop. */
function pod(detail: number, salt: number, stretch = 1.35, pinch = .3) {
  const g = mergeVertices(new THREE.IcosahedronGeometry(1, detail), 1e-5), p = g.attributes.position, d = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    d.fromBufferAttribute(p, i).normalize();
    const r = 1 + fbm(d.x * 2.4 + salt, d.y * 2.4, d.z * 2.4, 3) * .14 + fbm(d.x * 6 + salt, d.y * 6, d.z * 6, 2) * .035;
    const y = d.y * r, k = 1 - pinch * Math.max(0, d.y) ** 2;
    p.setXYZ(i, d.x * r * k, y * stretch, d.z * r * k);
  }
  g.computeVertexNormals();
  return g;
}

/** Appends a geometry into a collection of parts to be merged (positions + normals + aGlow). */
function merge(parts: THREE.BufferGeometry[]) {
  const pos: number[] = [], nor: number[] = [], glow: number[] = [], idx: number[] = [];
  for (const g of parts) {
    const start = pos.length / 3, p = g.attributes.position, n = g.attributes.normal, gl = g.attributes.aGlow, ix = g.index!;
    for (let i = 0; i < p.count; i++) { pos.push(p.getX(i), p.getY(i), p.getZ(i)); nor.push(n.getX(i), n.getY(i), n.getZ(i)); glow.push(gl.getX(i)); }
    for (let i = 0; i < ix.count; i++) idx.push(ix.getX(i) + start);
    g.dispose();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('aGlow', new THREE.Float32BufferAttribute(glow, 1));
  g.setIndex(idx);
  return g;
}

/** Seats a local geometry (y up from 0) on the ground at (x, z), tilted with the terrain and turned at random. */
function seat(x: number, z: number, rand: () => number, tilt = 1, sink = .08) {
  const base = new THREE.Vector3(x, ground(x, z) - sink, z);
  const q = new THREE.Quaternion().setFromUnitVectors(UP, normalAt(x, z).lerp(UP, 1 - tilt).normalize()).multiply(new THREE.Quaternion().setFromAxisAngle(UP, rand() * TAU));
  return { base, m: new THREE.Matrix4().compose(base, q, new THREE.Vector3(1, 1, 1)) };
}

/** Tall glowing stalk: a bent tapered tube (height H) with a lantern pod at the tip and 0 … 2 smaller pods along it. */
function stalk(plants: Plants, halos: Halos, x: number, z: number, H: number, birth: number, tint: number, lod: number, rand: () => number) {
  const salt = rand() * 50, phase = rand(), bend = .12 + rand() * .2, dir = rand() * TAU;
  const ctrl: THREE.Vector3[] = [];
  for (let i = 0; i <= 4; i++) { const t = i / 4; ctrl.push(new THREE.Vector3(Math.cos(dir) * bend * t * t * H, t * H, Math.sin(dir) * bend * t * t * H)); }
  const curve = new THREE.CatmullRomCurve3(ctrl);
  const r0 = .035 + H * .02;
  const stem = glowAttr(tube(curve, t => r0 * (1 - .72 * t) * (1 + .25 * Math.sin(t * 13 + salt)), 7 + lod * 2, 5), p => .06 + .3 * (p.y / H) ** 3);
  const parts = [stem];
  const tip = curve.getPoint(1), pr = .09 + H * .055;
  const podAt = (at: THREE.Vector3, r: number, i: number) => {
    const g = glowAttr(pod(1, salt + i * 3.1, 1.3, .35), () => 1);
    g.applyMatrix4(new THREE.Matrix4().compose(at, new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), (rand() - .5) * .6), new THREE.Vector3(r, r, r)));
    parts.push(g);
    return at;
  };
  const anchors = [podAt(tip.clone().addScaledVector(curve.getTangent(1), pr * .8), pr, 0)];
  const extra = rand() < .55 ? 1 : 0;
  for (let i = 0; i < extra; i++) { const t = .45 + rand() * .3, p = curve.getPoint(t), n = curve.getTangent(t); const side = new THREE.Vector3(Math.cos(dir + 1.9 + i), 0, Math.sin(dir + 1.9 + i)); anchors.push(podAt(p.clone().addScaledVector(side, pr * .5), pr * .55, i + 1)); n.x; }
  const { base, m } = seat(x, z, rand, .5);
  const g = merge(parts);
  plants.add(g, m, base, H, birth, tint, salt, phase);
  for (const a of anchors) halos.add(a.applyMatrix4(m), 1.6 + a.distanceTo(base) * .2 + pr * 4, phase, birth, tint);
}

/** Low bulbous lantern-pod on a short stem, .3 … .8 u. */
function lantern(plants: Plants, halos: Halos, x: number, z: number, S: number, birth: number, tint: number, lod: number, rand: () => number) {
  const salt = rand() * 50, phase = rand();
  const bulb = glowAttr(pod(1, salt, 1.15, .45), () => 1);
  const R = S * .42;
  bulb.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(0, S * .5, 0), new THREE.Quaternion(), new THREE.Vector3(R, R, R)));
  const lean = new THREE.Vector3((rand() - .5) * .2, 0, (rand() - .5) * .2);
  const stem = glowAttr(tube(new THREE.LineCurve3(new THREE.Vector3(0, -.05, 0), new THREE.Vector3(lean.x * S, S * .3, lean.z * S)), t => S * .06 * (1 - .4 * t), 2 + lod, 5), () => .08);
  const { base, m } = seat(x, z, rand, .7);
  plants.add(merge([bulb, stem]), m, base, S, birth, tint, salt, phase);
  halos.add(new THREE.Vector3(0, S * .5, 0).applyMatrix4(m), 1.2 + R * 6, phase, birth, tint);
}

/**
 * Glow-moss cushion (4 rings × 12): a low fbm-lumped dome whose rim is pushed .05 under the terrain so it hugs the ground even on
 * a slope; the shader draws the emissive veins. R is .7 … 1.6 u.
 */
function moss(plants: Plants, x: number, z: number, R: number, birth: number, tint: number, rand: () => number) {
  const salt = rand() * 50, phase = rand(), rings = 4, segs = 12, pos: number[] = [], idx: number[] = [], y0 = ground(x, z), US = [.35, .7, .92, 1];
  const h = (px: number, pz: number, u: number) => {
    const dome = Math.pow(Math.max(0, 1 - u * u), .6);
    return ground(px, pz) - y0 - .04 - (u >= 1 ? .3 + .25 * R : 0) + dome * (.12 * R + .05 + fbm(px * 2.1 + salt, pz * 2.1, 0, 3) * .07 * R);
  };
  pos.push(0, h(x, z, 0), 0);
  for (let r = 1; r <= rings; r++) for (let s = 0; s < segs; s++) {
    const a = s / segs * TAU + (r % 2) * .26, u = US[r - 1], d = R * u * (1 + fbm(a * 1.3 + salt, u, 2, 2) * .45);
    const px = x + Math.cos(a) * d, pz = z + Math.sin(a) * d;
    pos.push(Math.cos(a) * d, h(px, pz, u), Math.sin(a) * d);
  }
  for (let s = 0; s < segs; s++) idx.push(0, 1 + (s + 1) % segs, 1 + s);
  for (let r = 1; r < rings; r++) for (let s = 0; s < segs; s++) {
    const a = 1 + (r - 1) * segs + s, b = 1 + (r - 1) * segs + (s + 1) % segs, c = a + segs, d = b + segs;
    idx.push(a, b, c, b, d, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
  glowAttr(g, p => .22 * (1 - (Math.hypot(p.x, p.z) / R) ** 2) + .06);
  const base = new THREE.Vector3(x, y0, z);
  plants.add(g, new THREE.Matrix4().makeTranslation(x, y0, z), base, .3, birth, tint, salt, phase);
}

/** Antler tree, 4 … 6 u: a tapered trunk forking into 5 … 7 curved branches, each tipped with a pod (and its halo). Amber near the colony. */
function antler(plants: Plants, halos: Halos, x: number, z: number, H: number, birth: number, rand: () => number) {
  const salt = rand() * 50, phase = rand(), parts: THREE.BufferGeometry[] = [], tips: THREE.Vector3[] = [];
  const trunkTop = new THREE.Vector3((rand() - .5) * .4, H * .45, (rand() - .5) * .4);
  const trunk = new THREE.CatmullRomCurve3([new THREE.Vector3(0, -.1, 0), new THREE.Vector3(trunkTop.x * .3, H * .2, trunkTop.z * .3), trunkTop]);
  parts.push(glowAttr(tube(trunk, t => .09 + H * .022 * (1 - .5 * t), 6, 7), p => .05 + .1 * p.y / H));
  const n = 5 + Math.floor(rand() * 2);
  for (let i = 0; i < n; i++) {
    const a = i / n * TAU + rand() * .5, spread = .35 + rand() * .3, len = H * (.4 + rand() * .25), tilt = .25 + rand() * .3;
    const end = trunkTop.clone().add(new THREE.Vector3(Math.cos(a) * spread * len, len * (1 - tilt), Math.sin(a) * spread * len));
    const mid = trunkTop.clone().lerp(end, .5).add(new THREE.Vector3(Math.cos(a + 1.3) * .3, .25 * len, Math.sin(a + 1.3) * .3));
    const curve = new THREE.CatmullRomCurve3([trunkTop, mid, end]);
    parts.push(glowAttr(tube(curve, t => .045 + H * .009 * (1 - .75 * t), 6, 5), p => .1 + .4 * ((p.y - trunkTop.y) / (H - trunkTop.y)) ** 2));
    if (rand() < .5) {
      const t = .55 + rand() * .2, p = curve.getPoint(t), tip2 = p.clone().add(new THREE.Vector3(Math.cos(a - 1.2) * len * .25, len * .3, Math.sin(a - 1.2) * len * .25));
      parts.push(glowAttr(tube(new THREE.CatmullRomCurve3([p, p.clone().lerp(tip2, .5).add(new THREE.Vector3(0, .1, 0)), tip2]), t => .03 * (1 - .6 * t), 4, 4), () => .45));
    }
    tips.push(end);
  }
  for (const [i, t] of tips.entries()) {
    const r = .13 + rand() * .07, g = glowAttr(pod(1, salt + i * 2.7, 1.25, .35), () => 1);
    g.applyMatrix4(new THREE.Matrix4().compose(t.clone().add(new THREE.Vector3(0, r * .7, 0)), new THREE.Quaternion(), new THREE.Vector3(r, r, r)));
    parts.push(g);
  }
  const { base, m } = seat(x, z, rand, .3, .15);
  plants.add(merge(parts), m, base, H, birth, 2, salt, phase);
  for (const t of tips) halos.add(t.clone().add(new THREE.Vector3(0, .1, 0)).applyMatrix4(m), 2.4, phase, birth, 2);
}

// ─── atmosphere geometry ──────────────────────────────────────────────────────────────────────────────────────────────

/** ~1500 motes in the 20 … 90 u band, .2 … 6 u above ground, denser by the pools; aPhase, aSize (brightness × size). */
function motes(rand: () => number) {
  const pos: number[] = [], phase: number[] = [], size: number[] = [];
  while (pos.length < 1500 * 3) {
    const a = rand() * TAU, r = 20 + Math.sqrt(rand()) * 70, x = Math.cos(a) * r, z = Math.sin(a) * r;
    const h = heightAt(x, z);
    const nearPool = h.relief < POOL + 1.5;
    if (!nearPool && rand() < .45) continue;
    pos.push(x, h.y + .2 + Math.pow(rand(), 1.6) * 5.8, z); phase.push(rand()); size.push(.5 + rand() * (nearPool ? 1 : .7));
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aPhase', new THREE.Float32BufferAttribute(phase, 1));
  g.setAttribute('aSize', new THREE.Float32BufferAttribute(size, 1));
  return g;
}

/** The dust devils: where they wander, how far and how fast. */
const DEVILS = [
  { x: 46, z: 58, height: 11, wander: 9, speed: .055, seed: 2.1 },
  { x: -64, z: -30, height: 13.5, wander: 12, speed: .04, seed: 5.7 },
];
/** A dust-devil funnel: a lathe profile — flared skirt at the ground, slender waist, widening cone; uv.y = 0 … 1 up the column. */
function funnel(H: number) {
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i <= 14; i++) { const t = i / 14; pts.push(new THREE.Vector2(.32 + 1.15 * Math.pow(t, 1.6) + .9 * Math.exp(-t * 9), t * H)); }
  const g = new THREE.LatheGeometry(pts, 14);
  return g;
}

/** Mist sheets over the wider pools: 12 u quads at pool level + .35, up to 8 of them, 30 … 110 u out. */
function mist(clusters: Cluster[], rand: () => number) {
  const pos: number[] = [], uv: number[] = [], info: number[] = [], idx: number[] = [];
  const spots: [number, number][] = [];
  for (let tries = 0; tries < 5000 && spots.length < 8; tries++) {
    const a = rand() * TAU, r = 30 + Math.sqrt(rand()) * 80, x = Math.cos(a) * r, z = Math.sin(a) * r;
    if (heightAt(x, z).relief > POOL + .01) continue;
    let open = true;
    for (let k = 0; k < 8 && open; k++) { const b = k / 8 * TAU; if (heightAt(x + Math.cos(b) * 5, z + Math.sin(b) * 5).relief > POOL + .01) open = false; }
    if (!open || spots.some(s => Math.hypot(s[0] - x, s[1] - z) < 24) || clusters.some(c => Math.hypot(c.x - x, c.z - z) < 4)) continue;
    spots.push([x, z]);
    const y = heightAt(x, z).y + .35, start = pos.length / 3, S = 7, phase = rand();
    for (const [u, v] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { pos.push(x + u * S, y, z + v * S); uv.push(u, v); info.push(phase); }
    idx.push(start, start + 1, start + 2, start, start + 2, start + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aUv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aPhase', new THREE.Float32BufferAttribute(info, 1));
  g.setIndex(idx);
  return g;
}

/** One meteor streak as a 24-vertex line; aT runs 0 (head) → 1 (tail end). The shader places it from uTime. */
function meteor() {
  const n = 24, pos = new Float32Array(n * 3), t = new Float32Array(n);
  for (let i = 0; i < n; i++) t[i] = i / (n - 1);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aT', new THREE.BufferAttribute(t, 1));
  return g;
}

// ─── shaders ──────────────────────────────────────────────────────────────────────────────────────────────────────────

function material(vertexShader: string, fragmentShader: string, extra: Record<string, THREE.IUniform>, blending: THREE.Blending = THREE.NormalBlending, side: THREE.Side = THREE.FrontSide) {
  const transparent = blending !== THREE.NormalBlending || side === THREE.DoubleSide;
  return new THREE.ShaderMaterial({ vertexShader, fragmentShader, uniforms: {
    uKey: { value: new THREE.Vector3(-.62, .5, .6).normalize() }, uCamera: { value: new THREE.Vector3(0, .6, 5.6) }, uFog: { value: new THREE.Color(FOG[0]) },
    uTime: { value: 0 }, uStage: { value: 0 }, uFogK: { value: FOG_K }, uFogH: { value: FOG_SCALE_HEIGHT }, uBase: { value: BASE }, uHorizon: { value: HORIZON },
    uTeal: { value: new THREE.Color('#5fe3d0') }, uViolet: { value: new THREE.Color('#9a7cff') }, uAmber: { value: new THREE.Color('#ffb27a') }, ...extra },
    transparent, depthWrite: !transparent, blending, side });
}

/** Shared uniforms + helpers: glow colour by tint, the stage's glow strength, the terrain's haze toward the sky behind a fragment. */
const common = /* glsl */`
uniform vec3 uKey;uniform vec3 uCamera;uniform vec3 uFog;uniform float uTime;uniform float uStage;uniform float uFogK;uniform float uFogH;uniform float uBase;uniform float uHorizon;
uniform vec3 uTeal;uniform vec3 uViolet;uniform vec3 uAmber;
vec3 glowColor(float t){return t<.5?uTeal:t<1.5?uViolet:uAmber;}
/* barren at 0, faint sprouts to 1, flourishing from 2, lush at 4 */
float glowStrength(float s){return .05+.95*pow(clamp(s/4.,0.,1.),.8);}
float hazeAt(vec3 w,float dist){float thin=exp(-max(0.,w.y-uBase)/uFogH);return 1.-exp(-dist*dist*uFogK*thin);}
`;

const floraVertex = /* glsl */`
attribute vec3 aLocal;attribute vec4 aInfo;attribute float aGlow;attribute float aTint;
uniform float uTime;uniform float uStage;
varying vec3 vWorld;varying vec3 vNormal;varying vec3 vLocal;varying float vSeed;varying float vPhase;varying float vGlow;varying float vTint;varying float vGrow;
void main(){
 float grow=smoothstep(aInfo.z-.4,aInfo.z,uStage);grow=grow*grow*(3.-2.*grow);
 float H=max(aInfo.w,.05);float h=clamp(aLocal.y/H,0.,1.);
 float ph=aInfo.y*6.2832;
 vec2 sw=vec2(sin(uTime*.55+ph)+.5*sin(uTime*1.31+ph*1.7),cos(uTime*.47+ph*.8)+.5*sin(uTime*1.07+ph*2.3));
 vec3 base=position-aLocal;
 vec3 p=base+aLocal*grow+vec3(sw.x,0.,sw.y)*(.05*H*h*h*grow);
 p.y+=.02*h*sin(uTime*.9+ph)*grow;
 vec4 w=modelMatrix*vec4(p,1.);vWorld=w.xyz;vNormal=normalize(mat3(modelMatrix)*normal);
 vLocal=mix(aLocal/max(H,1.),aLocal*6.,step(.9,aGlow));vSeed=aInfo.x;vPhase=aInfo.y;vGlow=aGlow;vTint=aTint;vGrow=grow;
 gl_Position=projectionMatrix*viewMatrix*w;}
`;
/**
 * Plant beauty pass: dark translucent body (basalt-green / violet albedo broken up by fbm) with a subsurface wrap, the key
 * with a soft terminator, the fog's sky light on the tops, a wet specular, a glow-coloured Fresnel rim; emissive veins (ridged
 * noise) and mottled pod skins pulsing slowly on the plant's phase, scaled by the stage's glow strength; hazed like the terrain
 * (the emissive punches through the haze a little longer than the body).
 */
const floraFragment = /* glsl */`
precision highp float;
${common}
varying vec3 vWorld;varying vec3 vNormal;varying vec3 vLocal;varying float vSeed;varying float vPhase;varying float vGlow;varying float vTint;varying float vGrow;
${noise}
${skyChunk}
void main(){
 if(vGrow<.01)discard;
 vec3 n=normalize(vNormal);if(!gl_FrontFacing)n=-n;
 vec3 toEye=uCamera-vWorld;float dist=length(toEye);vec3 eye=toEye/dist;vec3 key=normalize(uKey);
 float far=smoothstep(14.,60.,dist);
 vec3 s=vLocal*vec3(2.2,1.6,2.2)+vec3(vSeed*7.3,vSeed*2.1,vSeed*5.7);
 float rg=ridged(s*vec3(3.,5.,3.));float lines=mix(smoothstep(.6,.82,rg),.22,far);
 float mottle=mix(fbm(s*4.+7.),.5,far);
 vec3 glow=glowColor(vTint);float strength=glowStrength(uStage);
 float pulse=.72+.28*sin(uTime*.8+vPhase*6.2832+vLocal.y*1.5)*(.7+.3*sin(uTime*.23+vPhase*9.));
 float skin=smoothstep(.38,.74,mottle);
 float em=vGlow*vGlow*(.16+.6*skin)+lines*(.75-.45*vGlow)*(.3+vGlow)*(.6+.4*skin);
 vec3 albedo=mix(vec3(.03,.05,.04),vec3(.045,.03,.065),step(.5,vTint))*(.7+.6*mottle);
 float diffuse=max(0.,dot(n,key));float terminator=smoothstep(-.1,.35,dot(n,key));
 float wrap=pow(max(0.,dot(n,key)*.5+.5),2.);
 vec3 c=albedo*(diffuse*terminator*.9*vec3(1.,.93,.84)+wrap*.25*vec3(1.,.9,.8)+.004);
 c+=albedo*uFog*(.35+.65*max(n.y,0.))*.9;
 c+=pow(max(0.,dot(reflect(-key,n),eye)),36.)*.1*vec3(1.,.93,.84);
 /* translucency: light through the thin skin toward the eye, plus the glow bleeding through the body */
 c+=glow*pow(max(0.,dot(-eye,key)),3.)*.05*strength*(.3+vGlow);
 c+=glow*pow(1.-max(0.,dot(n,eye)),3.)*.1*strength*(.2+vGlow)*pulse;
 c+=glow*(.02+.08*vGlow*vGlow)*strength*wrap;
 /* the moss skirt below grade (coarse terrain may expose it) stays in shadow */
 float under=vGlow>.9?1.:smoothstep(-.35,-.02,vLocal.y);c*=mix(.12,1.,under);
 c=c/(1.+c*.25);
 float haze=hazeAt(vWorld,dist);
 vec3 skyc=sky(-eye,uFog,uHorizon,uTime,key,uStage);
 c=mix(c,skyc,haze);
 vec3 e=glow*em*strength*pulse*(.9+.3*vGrow)*under;
 c+=e*(1.-haze*.85)*(1.-smoothstep(60.,150.,dist)*.5);
 float grain=(hash(vec3(gl_FragCoord.xy,floor(uTime*6.)))-.5)*.012;
 gl_FragColor=vec4(pow(max(c,0.),vec3(1./2.2))+grain,1.);}
`;

/** Pod halos: a gaussian sprite pulled toward the eye so the pod doesn't cut it, sized ∝ aSize / distance, pulsing with its plant. */
const haloVertex = /* glsl */`
attribute float aSize;attribute float aPhase;attribute float aBirth;attribute float aTint;
uniform float uTime;uniform float uStage;uniform vec3 uCamera;uniform float uSize;
varying vec3 vWorld;varying float vFade;varying float vPhase;varying float vTint;varying float vDist;
void main(){
 float grow=smoothstep(aBirth-.3,aBirth+.1,uStage);
 vec4 w=modelMatrix*vec4(position,1.);vec3 toEye=uCamera-w.xyz;float dist=length(toEye);
 w.xyz+=toEye/dist*.6;vWorld=w.xyz;vDist=dist;
 vFade=grow;vPhase=aPhase;vTint=aTint;
 gl_Position=projectionMatrix*viewMatrix*w;
 gl_PointSize=clamp(uSize*aSize*420./dist,2.,110.)*grow;}
`;
const haloFragment = /* glsl */`
precision highp float;
${common}
varying vec3 vWorld;varying float vFade;varying float vPhase;varying float vTint;varying float vDist;
${noise}
${skyChunk}
void main(){
 if(vFade<.002)discard;
 float r=length(gl_PointCoord-.5)*2.;if(r>1.)discard;
 float m=exp(-r*r*7.)*.5+exp(-r*r*2.2)*.12+exp(-r*r*40.)*.5;
 float pulse=.72+.28*sin(uTime*.8+vPhase*6.2832)*(.7+.3*sin(uTime*.23+vPhase*9.));
 float strength=glowStrength(uStage);
 float haze=hazeAt(vWorld,vDist);
 vec3 c=glowColor(vTint)*strength*pulse*m*(1.-haze*.9)*vFade;
 gl_FragColor=vec4(pow(c,vec3(1./2.2))*.9,1.);}
`;

/** Ground glow: additive disc under a cluster, gaussian in radius, broken by fbm, pulsing with the cluster. */
const discVertex = /* glsl */`
attribute vec2 aUv;attribute vec3 aInfo;uniform float uStage;
varying vec3 vWorld;varying vec2 vUv;varying vec3 vInfo;varying float vGrow;
void main(){vec4 w=modelMatrix*vec4(position,1.);vWorld=w.xyz;vUv=aUv;vInfo=aInfo;vGrow=smoothstep(aInfo.y-.3,aInfo.y+.2,uStage);gl_Position=projectionMatrix*viewMatrix*w;}
`;
const discFragment = /* glsl */`
precision highp float;
${common}
varying vec3 vWorld;varying vec2 vUv;varying vec3 vInfo;varying float vGrow;
${noise}
${skyChunk}
void main(){
 if(vGrow<.002)discard;
 float r=vUv.x;float m=exp(-r*r*4.)*(1.-r*r);
 float n=fbm(vWorld*vec3(.9,.4,.9)+vInfo.x*9.);m*=.55+.9*n;
 float pulse=.75+.25*sin(uTime*.8+vInfo.x*6.2832);
 vec3 toEye=uCamera-vWorld;float dist=length(toEye);float haze=hazeAt(vWorld,dist);
 vec3 c=glowColor(vInfo.z)*glowStrength(uStage)*pulse*m*.09*(1.-haze*.9)*vGrow;
 gl_FragColor=vec4(pow(c,vec3(1./2.2)),1.);}
`;

/** Spores: rise 2.5 … 4 u from the moss on a slow loop, drifting sideways, fading in and out; only from stage 3. */
const sporeVertex = /* glsl */`
attribute float aSize;attribute float aPhase;attribute float aBirth;attribute float aTint;
uniform float uTime;uniform float uStage;uniform vec3 uCamera;uniform float uSize;
varying vec3 vWorld;varying float vFade;varying float vPhase;varying float vTint;varying float vDist;
void main(){
 float grow=smoothstep(aBirth-.4,aBirth,uStage);
 float life=fract(uTime*.045*(.7+aSize*.4)+aPhase);
 vec3 p=position;float ph=aPhase*6.2832;
 p.y+=life*(2.5+aSize*1.5);p.x+=sin(uTime*.3+ph)*.5*life+sin(life*9.+ph)*.15;p.z+=cos(uTime*.26+ph*1.3)*.5*life;
 vec4 w=modelMatrix*vec4(p,1.);vec3 toEye=uCamera-w.xyz;float dist=length(toEye);vWorld=w.xyz;vDist=dist;
 vFade=grow*smoothstep(0.,.15,life)*(1.-smoothstep(.6,1.,life))*.35;vPhase=aPhase;vTint=aTint;
 gl_Position=projectionMatrix*viewMatrix*w;
 gl_PointSize=clamp(uSize*aSize*70./dist,1.,8.)*grow;}
`;

/** Dust motes: curl-ish sine drift with a slow rise/fall, lit by the key through forward scatter, fog-tinted, hazed. */
const moteVertex = /* glsl */`
attribute float aPhase;attribute float aSize;
uniform float uTime;uniform vec3 uCamera;uniform float uSize;
varying vec3 vWorld;varying float vDist;varying float vSize;
void main(){
 float t=uTime*.1,ph=aPhase*6.2832;
 vec3 p=position;
 p.x+=sin(t*.7+ph)*1.4+sin(t*1.9+position.z*.3+ph)*.35;
 p.z+=cos(t*.6+ph*1.3)*1.4+cos(t*1.7+position.x*.3)*.35;
 p.y+=sin(t*.45+ph*1.7)*.7;
 vec4 w=modelMatrix*vec4(p,1.);vWorld=w.xyz;vDist=length(uCamera-w.xyz);vSize=aSize;
 gl_Position=projectionMatrix*viewMatrix*w;
 gl_PointSize=clamp(uSize*aSize*110./vDist,1.5,6.);}
`;
const moteFragment = /* glsl */`
precision highp float;
${common}
varying vec3 vWorld;varying float vDist;varying float vSize;
${noise}
${skyChunk}
void main(){
 float r=length(gl_PointCoord-.5)*2.;if(r>1.)discard;
 float m=exp(-r*r*5.);
 vec3 eye=(uCamera-vWorld)/vDist;vec3 key=normalize(uKey);
 float scatter=.35+.65*pow(max(0.,dot(-eye,key))*.5+.5,4.);
 float haze=hazeAt(vWorld,vDist);
 float tw=.8+.2*sin(uTime*1.7+vWorld.x*3.+vWorld.z*2.);
 vec3 c=(uFog*2.6+vec3(.12,.08,.05))*scatter*m*tw*vSize*.7*(1.-haze*.95);
 gl_FragColor=vec4(pow(c,vec3(1./2.2)),1.);}
`;

/** Dust devil: the funnel spins and leans along its path; the column carries a scrolling ridged-noise alpha that dissolves at the top. */
const devilVertex = /* glsl */`
uniform float uTime;uniform vec3 uPos;uniform float uSeed;uniform float uHeight;
varying vec3 vWorld;varying vec3 vNormal;varying vec2 vUv;varying float vH;
void main(){
 float h=position.y/uHeight;
 float spin=uTime*2.4+uSeed-h*2.5;float cs=cos(spin),sn=sin(spin);
 vec3 p=vec3(position.x*cs-position.z*sn,position.y,position.x*sn+position.z*cs);
 vec3 nn=vec3(normal.x*cs-normal.z*sn,normal.y,normal.x*sn+normal.z*cs);
 p.x+=sin(uTime*.5+uSeed+h*2.)*h*h*1.6;p.z+=cos(uTime*.42+uSeed*1.7+h*1.5)*h*h*1.6;
 p+=uPos;
 vec4 w=modelMatrix*vec4(p,1.);vWorld=w.xyz;vNormal=normalize(mat3(modelMatrix)*nn);vUv=vec2(uv.x,h);vH=h;
 gl_Position=projectionMatrix*viewMatrix*w;}
`;
const devilFragment = /* glsl */`
precision highp float;
${common}
uniform float uSeed;
varying vec3 vWorld;varying vec3 vNormal;varying vec2 vUv;varying float vH;
${noise}
${skyChunk}
void main(){
 vec3 n=normalize(vNormal);if(!gl_FrontFacing)n=-n;
 vec3 toEye=uCamera-vWorld;float dist=length(toEye);vec3 eye=toEye/dist;vec3 key=normalize(uKey);
 vec3 q=vec3(vUv.x*6.2832,vH*9.-uTime*1.6,uSeed);
 float d=fbm(vec3(cos(q.x)*1.4,q.y,sin(q.x)*1.4)+vec3(0.,0.,uTime*.3));
 float a=smoothstep(.36,.7,d)*(1.-smoothstep(.55,1.,vH))*smoothstep(0.,.08,vH);
 float edge=1.-abs(dot(n,eye));a*=.45+.75*edge;
 float diffuse=max(0.,dot(n,key))*.6+.4;
 vec3 dust=vec3(.3,.17,.11)*.5;
 vec3 c=dust*diffuse*vec3(1.,.93,.84)+dust*uFog*1.2+uFog*pow(max(0.,dot(-eye,key)),3.)*.4;
 c=c/(1.+c*.25);
 float haze=hazeAt(vWorld,dist);
 c=mix(c,sky(-eye,uFog,uHorizon,uTime,key,uStage),haze);
 gl_FragColor=vec4(pow(max(c,0.),vec3(1./2.2)),a*.26*(1.-haze*.92));}
`;

/** Pool mist: a faint fog sheet with drifting fbm density, edges feathered, fog-tinted and lit a touch by the key. */
const mistVertex = /* glsl */`
attribute vec2 aUv;attribute float aPhase;
varying vec3 vWorld;varying vec2 vUv;varying float vPhase;
void main(){vec4 w=modelMatrix*vec4(position,1.);vWorld=w.xyz;vUv=aUv;vPhase=aPhase;gl_Position=projectionMatrix*viewMatrix*w;}
`;
const mistFragment = /* glsl */`
precision highp float;
${common}
varying vec3 vWorld;varying vec2 vUv;varying float vPhase;
${noise}
${skyChunk}
void main(){
 vec3 toEye=uCamera-vWorld;float dist=length(toEye);vec3 eye=toEye/dist;vec3 key=normalize(uKey);
 float d=fbm(vec3(vWorld.x*.18+uTime*.05+vPhase*7.,vWorld.z*.18-uTime*.03,uTime*.04));
 float fe=(1.-smoothstep(.45,1.,length(vUv)));
 float a=smoothstep(.36,.72,d)*fe*.24;
 vec3 c=uFog*1.5+vec3(.04,.025,.015)+uFog*pow(max(0.,dot(-eye,key)),2.)*.5;
 float haze=hazeAt(vWorld,dist);
 c=mix(c,sky(-eye,uFog,uHorizon,uTime,key,uStage),haze*.6);
 gl_FragColor=vec4(pow(max(c,0.),vec3(1./2.2)),a*(1.-haze*.9));}
`;

/**
 * Meteor: a deterministic schedule from uTime — cycle k every ~9 s (6 … 12 by hash), the streak lives for the first 1.1 s of
 * its cycle, from a hashed start high in the sky (elevation .25 … .5, radius 120) along a hashed downward direction; aT 0 is
 * the head, 1 the tail end.
 */
const meteorVertex = /* glsl */`
attribute float aT;
uniform float uTime;
varying float vT;varying float vLife;varying vec3 vWorld;
float h1(float k){return fract(sin(k*127.1+3.7)*43758.5453);}
void main(){
 float k=floor(uTime/9.);float jitter=h1(k)*3.-1.5;float local=uTime-k*9.;
 float start=1.5+jitter+1.5;float life=(local-start)/1.1;
 float az=h1(k+11.)*6.2832,el=.2+.09*h1(k+23.);
 vec3 s=vec3(cos(az)*cos(el),sin(el),sin(az)*cos(el))*120.;
 vec3 dir=normalize(vec3(h1(k+37.)-.5,-.5-.6*h1(k+41.),h1(k+43.)-.5))*(14.+10.*h1(k+51.));
 float prog=clamp(life,0.,1.);
 vec3 p=s+dir*(prog-aT*.3);
 vT=aT;vLife=(life>0.&&life<1.)?1.:0.;vWorld=p;
 gl_Position=projectionMatrix*viewMatrix*vec4(p,1.);}
`;
const meteorFragment = /* glsl */`
precision highp float;
${common}
varying float vT;varying float vLife;varying vec3 vWorld;
void main(){
 if(vLife<.5)discard;
 float head=exp(-vT*14.)*1.2+(1.-vT)*(1.-vT)*.35;
 float dist=length(uCamera-vWorld);float haze=hazeAt(vWorld,dist);
 vec3 c=vec3(1.,.9,.75)*head*(1.-haze*.8);
 gl_FragColor=vec4(pow(c,vec3(1./2.2)),1.);}
`;
