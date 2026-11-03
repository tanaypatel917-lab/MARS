import * as THREE from 'three';
import { BASE, POOL, heightAt, normalAt, seeded, siteOnLand } from './landscapeTerrain';
import { Strokes, Sparks, Solids, type Vec3 } from './landscapeKit';

/**
 * The colony itself, stage by stage: a settlement plan for the landscape under the /how stele, drawn as hairline
 * elevation drawings (Strokes), warm window / track lights and rare cold navigation lights (Sparks) and a few low-poly
 * pad and hull plates (Solids). Every element carries its birth stage; the five stages of the MARS loop grow it from one
 * lander to a launching civilisation.
 *
 * Districts (the camera orbits 360°, yaw s·90° per move looks toward −z, −x, +z, +x, −z):
 *   PAD   (−z, 30 … 62)  the arrival plain at the pool's edge and the saddle between two crests behind it — the lander,
 *                        then landing rings, then the launch gantry: the arrival site becomes the spaceport.
 *   OBS   (−x, 45 … 75)  a long ridge crest: the habitat cluster and the dishes of the observatory, a solar strip behind.
 *   SCI   (−x−z, ~100)   a science outpost on the far crest, mostly dissolved in the fog.
 *   FARM  (+z, 48 … 66)  the west shore of the long south lake, under a crest: greenhouse sheds in the valley.
 *   IND   (+z, 42 … 56)  the east shore of the same lake: drill derricks, pipelines, tanks, the pipeline bridge to the farm.
 *   CITY  (+x, 68 … 92)  the far shore of the east pool: towers mirrored in the pool, tethers between the crests.
 *   RELAY (−z, ~100)     a comms relay on the far northern crest.
 */
export function buildColony(): { lines: THREE.BufferGeometry; lights: THREE.BufferGeometry; cold: THREE.BufferGeometry; solids: THREE.BufferGeometry } {
  const c = new Colony();
  pad(c); observatory(c); science(c); farm(c); industry(c); city(c); relay(c); network(c);
  return { lines: c.lines.geometry(), lights: c.lights.geometry(), cold: c.cold.geometry(), solids: c.solids.geometry() };
}

const TAU = Math.PI * 2;
const Y = new THREE.Vector3(0, 1, 0);
/** Dark glossy plate relief (reads as a scorched / glass pad) and rust hull relief. */
const GLOSS = POOL - .3, RUST = 6;

/** Detail factor by distance from the stele: full in the camera band, half-ish where the fog eats detail. */
const lod = (x: number, z: number) => THREE.MathUtils.clamp((135 - Math.hypot(x, z)) / 75, .4, 1);
const seg = (n: number, l: number, min = 6) => Math.max(min, Math.round(n * l));
const ground = (x: number, z: number, lift = 0): Vec3 => [x, heightAt(x, z).y + lift, z];

/** Local frame on the terrain: origin on the ground, `u` up (blended between the terrain normal and plumb by `lean`), `f` toward azimuth `az`. */
class Frame {
  constructor(readonly o: THREE.Vector3, readonly r: THREE.Vector3, readonly u: THREE.Vector3, readonly f: THREE.Vector3) {}
  p(x: number, y: number, z: number): Vec3 {
    const { o, r, u, f } = this;
    return [o.x + r.x * x + u.x * y + f.x * z, o.y + r.y * x + u.y * y + f.y * z, o.z + r.z * x + u.z * y + f.z * z];
  }
  static at(x: number, z: number, az = 0, lean = .4, lift = 0) {
    const up = Y.clone().lerp(normalAt(x, z), lean).normalize();
    return Frame.from([x, heightAt(x, z).y + lift, z], up, az);
  }
  static from(o: Vec3, up: THREE.Vector3, az = 0) {
    const fwd0 = new THREE.Vector3(Math.sin(az), 0, Math.cos(az));
    if (Math.abs(fwd0.dot(up)) > .98) fwd0.set(1, 0, 0);
    const r = new THREE.Vector3().crossVectors(fwd0, up).normalize(), f = new THREE.Vector3().crossVectors(up, r).normalize();
    return new Frame(new THREE.Vector3(...o), r, up.clone().normalize(), f);
  }
}

class Colony {
  readonly lines = new Strokes(); readonly lights = new Sparks(); readonly cold = new Sparks(); readonly solids = new Solids();
  readonly rand = seeded(2027);

  // ---- primitives in a frame --------------------------------------------------------------------------------------------
  /** Arc in a frame plane: axis 'y' lies flat (local xz), 'z' stands in local xy, 'x' stands in local zy. */
  arc(F: Frame, c: Vec3, r: number, n: number, birth: number, axis: 'x' | 'y' | 'z' = 'y', a0 = 0, a1 = TAU, rise = 0, phase = 0) {
    const pts: Vec3[] = [];
    for (let i = 0; i <= n; i++) {
      const a = a0 + (a1 - a0) * i / n, u = Math.cos(a) * r, v = Math.sin(a) * r;
      pts.push(axis === 'y' ? F.p(c[0] + u, c[1], c[2] + v) : axis === 'z' ? F.p(c[0] + u, c[1] + v, c[2]) : F.p(c[0], c[1] + v, c[2] + u));
    }
    this.lines.poly(pts, birth, rise, phase);
  }
  ring(F: Frame, c: Vec3, r: number, n: number, birth: number, axis: 'x' | 'y' | 'z' = 'y') { this.arc(F, c, r, n, birth, axis); }
  seg(F: Frame, a: Vec3, b: Vec3, birth: number) { this.lines.seg(F.p(...a), F.p(...b), birth); }
  poly(F: Frame, pts: Vec3[], birth: number, rise = 0, phase = 0) { this.lines.poly(pts.map(p => F.p(...p)), birth, rise, phase); }
  /** Square (or rectangle) outline lying flat at local height y. */
  square(F: Frame, cx: number, y: number, cz: number, hw: number, hd: number, birth: number) {
    this.poly(F, [[cx - hw, y, cz - hd], [cx + hw, y, cz - hd], [cx + hw, y, cz + hd], [cx - hw, y, cz + hd], [cx - hw, y, cz - hd]], birth);
  }
  /** Hairline cuboid: 12 edges. */
  box(F: Frame, cx: number, y0: number, cz: number, hw: number, h: number, hd: number, birth: number) {
    this.square(F, cx, y0, cz, hw, hd, birth); this.square(F, cx, y0 + h, cz, hw, hd, birth);
    for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) this.seg(F, [cx + sx * hw, y0, cz + sz * hd], [cx + sx * hw, y0 + h, cz + sz * hd], birth);
  }
  /** Solid low-poly cuboid. */
  solidBox(F: Frame, cx: number, y0: number, cz: number, hw: number, h: number, hd: number, relief: number, birth: number) {
    const P = (sx: number, sy: number, sz: number) => F.p(cx + sx * hw, y0 + sy * h, cz + sz * hd);
    const q = (a: Vec3, b: Vec3, c: Vec3, d: Vec3) => { this.solids.tri(a, b, c, relief, birth); this.solids.tri(a, c, d, relief, birth); };
    q(P(-1, 1, -1), P(1, 1, -1), P(1, 1, 1), P(-1, 1, 1));
    q(P(-1, 0, -1), P(-1, 1, -1), P(-1, 1, 1), P(-1, 0, 1)); q(P(1, 0, 1), P(1, 1, 1), P(1, 1, -1), P(1, 0, -1));
    q(P(-1, 0, 1), P(-1, 1, 1), P(1, 1, 1), P(1, 0, 1)); q(P(1, 0, -1), P(1, 1, -1), P(-1, 1, -1), P(-1, 0, -1));
  }
  /** Solid disc draped over the terrain (each rim point on its own ground height), slightly lifted. */
  plate(x: number, z: number, r: number, n: number, relief: number, birth: number, lift = .08) {
    const c = ground(x, z, lift);
    const rim: Vec3[] = []; for (let i = 0; i < n; i++) { const a = i / n * TAU; rim.push(ground(x + Math.cos(a) * r, z + Math.sin(a) * r, lift)); }
    for (let i = 0; i < n; i++) this.solids.tri(c, rim[(i + 1) % n], rim[i], relief, birth);
  }
  /** Solid low-poly cylinder standing in a frame. */
  cylinder(F: Frame, cx: number, y0: number, cz: number, r: number, h: number, n: number, relief: number, birth: number) {
    const ring = (y: number) => Array.from({ length: n }, (_, i) => F.p(cx + Math.cos(i / n * TAU) * r, y, cz + Math.sin(i / n * TAU) * r));
    const lo = ring(y0), hi = ring(y0 + h), top = F.p(cx, y0 + h, cz);
    // Frame (r, u, f) is left-handed, so the sides wind lo→hi[j]→hi[i] to face outward (the cap's winding is already up)
    for (let i = 0; i < n; i++) { const j = (i + 1) % n; this.solids.tri(lo[i], hi[j], hi[i], relief, birth); this.solids.tri(lo[i], lo[j], hi[j], relief, birth); this.solids.tri(top, hi[i], hi[j], relief, birth); }
  }
  warm(p: Vec3, birth: number, size = .4, rise = 0, phase?: number) { this.lights.add(p, birth, size, rise, phase); }
  nav(p: Vec3, birth: number, size = .6) { this.cold.add(p, birth, size); }

  // ---- structures ----------------------------------------------------------------------------------------------------------
  /** Habitat dome: three latitude rings + meridians, an airlock stub facing `az`, a glossy foundation plate, lights inside. */
  dome(x: number, z: number, r: number, birth: number, az = this.rand() * TAU) {
    [x, , z] = siteOnLand(x, z, .4);
    const F = Frame.at(x, z, az, .3), l = lod(x, z), n = seg(30, l, 10);
    this.plate(x, z, r * 1.12, seg(12, l, 8), GLOSS, birth);
    for (const k of [0, .45, .78]) this.ring(F, [0, r * k, 0], r * Math.sqrt(1 - k * k), n, birth + .05);
    this.arc(F, [0, 0, 0], r, seg(16, l, 8), birth + .1, 'z', 0, Math.PI);
    if (l > .7) this.arc(F, [0, 0, 0], r, seg(16, l, 8), birth + .15, 'x', 0, Math.PI);
    // airlock: two hoops and three lines running out from the dome
    const ar = Math.max(.35, r * .22), z0 = r * .86, z1 = r + ar * 2.2, m = seg(10, l, 6);
    this.arc(F, [0, 0, z0], ar, m, birth + .2, 'z', 0, Math.PI); this.arc(F, [0, 0, z1], ar, m, birth + .2, 'z', 0, Math.PI);
    for (const [ox, oy] of [[-ar, 0], [ar, 0], [0, ar]]) this.seg(F, [ox, oy, z0], [ox, oy, z1], birth + .25);
    this.warm(F.p(0, ar * .5, z1 - .2), birth + .4, .3);
    // rooftop: a railing ring at the second tier and a short antenna mast with a cold tip on the bigger domes
    if (r >= 2.4 && l > .55) { this.ring(F, [0, r * .45 + .3, 0], r * Math.sqrt(1 - .45 * .45) * 1.03, n, birth + .2); for (let i = 0; i < 6; i++) { const a = i / 6 * TAU, rr = r * Math.sqrt(1 - .45 * .45); this.seg(F, [Math.cos(a) * rr, r * .45, Math.sin(a) * rr], [Math.cos(a) * rr * 1.03, r * .45 + .3, Math.sin(a) * rr * 1.03], birth + .2); } }
    if (r >= 2.4) { this.seg(F, [0, r, 0], [0, r + Math.min(2, r * .5), 0], birth + .25); this.nav(F.p(0, r + Math.min(2, r * .5) + .05, 0), birth + .35, .35); }
    const w = seg(8 + r * 2, l, 4);
    for (let i = 0; i < w; i++) { const a = this.rand() * TAU, k = .25 + this.rand() * .3; this.warm(F.p(Math.cos(a) * r * .9 * Math.sqrt(1 - k * k), r * k, Math.sin(a) * r * .9 * Math.sqrt(1 - k * k)), birth + .3 + this.rand() * .2, .35 + this.rand() * .15); }
    // the city lights up (stage 3): more windows on every dome that already stands
    if (birth < 3) for (let i = 0; i < seg(10 + r * 2, l, 4); i++) { const a = this.rand() * TAU, k = .12 + this.rand() * .55; this.warm(F.p(Math.cos(a) * r * .92 * Math.sqrt(1 - k * k), r * k, Math.sin(a) * r * .92 * Math.sqrt(1 - k * k)), 3 + this.rand() * .6, .3 + this.rand() * .15); }
    return F;
  }
  /** Low tunnel linking two domes: standing hoops along the line, a ridge and two sills. */
  tunnel(a: Vec3, b: Vec3, birth: number, r = .7) {
    const dx = b[0] - a[0], dz = b[2] - a[2], len = Math.hypot(dx, dz), az = Math.atan2(dx, dz), n = Math.max(3, Math.round(len / 2.2));
    const tops: Vec3[] = [], left: Vec3[] = [], right: Vec3[] = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n, x = a[0] + dx * t, z = a[2] + dz * t, F = Frame.from(ground(x, z), Y, az);
      this.arc(F, [0, 0, 0], r, 8, birth + t * .2, 'z', 0, Math.PI);
      tops.push(F.p(0, r, 0)); left.push(F.p(-r, 0, 0)); right.push(F.p(r, 0, 0));
    }
    this.lines.poly(tops, birth + .1); this.lines.poly(left, birth + .15); this.lines.poly(right, birth + .15);
    this.warm(tops[Math.floor(n / 2)].map((v, i) => i === 1 ? v - r * .4 : v) as unknown as Vec3, birth + .4, .3);
  }
  /** Mast: pole, optional guy-wires (anchored on their own ground), optional cross-arms, a light on top. */
  mast(x: number, z: number, h: number, birth: number, guys = 0, arms = 0, cold = true) {
    [x, , z] = siteOnLand(x, z, .3);
    const F = Frame.at(x, z, this.rand() * TAU, .1);
    this.seg(F, [0, 0, 0], [0, h, 0], birth);
    for (let i = 0; i < guys; i++) { const a = i / guys * TAU + .4; const foot = ground(x + Math.cos(a) * h * .45, z + Math.sin(a) * h * .45); this.lines.seg(F.p(0, h * .88, 0), foot, birth + .15); this.lines.seg(foot, [foot[0], foot[1] + .25, foot[2]], birth + .15); }
    for (let i = 0; i < arms; i++) { const y = h * (.55 + .3 * i / Math.max(1, arms - 1)), w = .35 + .25 * (arms - i); this.seg(F, [-w, y, 0], [w, y, 0], birth + .1); this.seg(F, [0, y, -w * .6], [0, y, w * .6], birth + .1); }
    if (cold) this.nav(F.p(0, h + .05, 0), birth + .2, .55); else this.warm(F.p(0, h + .05, 0), birth + .2, .45);
    return F;
  }
  /** Beacon: a short pole on a tripod, cold light on top. */
  beacon(x: number, z: number, h: number, birth: number) {
    [x, , z] = siteOnLand(x, z, .3);
    const F = Frame.at(x, z, 0, .2);
    this.seg(F, [0, 0, 0], [0, h, 0], birth);
    for (let i = 0; i < 3; i++) { const a = i / 3 * TAU; this.seg(F, [Math.cos(a) * .5, 0, Math.sin(a) * .5], [0, h * .3, 0], birth); }
    this.nav(F.p(0, h + .05, 0), birth + .15, .7);
  }
  /** Dish antenna: pedestal, a ring tilted toward the sky at (az, elevation), feed strut and rim struts, a tiny feed light. */
  dish(x: number, z: number, r: number, birth: number, az = this.rand() * TAU, elev = .9) {
    [x, , z] = siteOnLand(x, z, .3);
    const l = lod(x, z), B = Frame.at(x, z, az, .2), h = r * 1.1;
    this.seg(B, [0, 0, 0], [0, h, 0], birth);
    this.square(B, 0, 0, 0, r * .35, r * .35, birth);
    this.dishHead(B.p(0, h, 0), r, az, elev, birth, l);
  }
  /** The reflector itself, hung from `top`: rim ring, back ring, cross struts, feed strut with three stays, a feed light. */
  dishHead(top: Vec3, r: number, az: number, elev: number, birth: number, l: number) {
    const look = new THREE.Vector3(Math.sin(az) * Math.cos(elev), Math.sin(elev), Math.cos(az) * Math.cos(elev)).normalize();
    const D = Frame.from([top[0] + look.x * r * .15, top[1] + look.y * r * .15, top[2] + look.z * r * .15], look, az + Math.PI / 2);
    this.lines.seg(top, D.p(0, 0, 0), birth + .1);
    this.ring(D, [0, 0, 0], r, seg(24, l, 10), birth + .15);
    this.ring(D, [0, -r * .18, 0], r * .45, seg(12, l, 6), birth + .15);
    if (l > .6 && r > 1.8) this.ring(D, [0, -r * .06, 0], r * .75, seg(18, l, 8), birth + .18);
    this.seg(D, [-r, 0, 0], [r, 0, 0], birth + .2); this.seg(D, [0, 0, -r], [0, 0, r], birth + .2);
    this.seg(D, [0, -r * .18, 0], [0, r * .75, 0], birth + .25);
    if (l > .6) for (let i = 0; i < 3; i++) { const a = i / 3 * TAU + .5; this.seg(D, [Math.cos(a) * r, 0, Math.sin(a) * r], [0, r * .75, 0], birth + .3); }
    this.warm(D.p(0, r * .72, 0), birth + .4, .3);
  }
  /** Solar strip: a tilted panel plane of parallel hairlines on four legs over a dark glossy plate. */
  solar(x: number, z: number, w: number, len: number, birth: number, az = 0) {
    [x, , z] = siteOnLand(x, z, .3);
    const F = Frame.at(x, z, az, .8), l = lod(x, z), rows = seg(len / .7, l, 5), y0 = .45, y1 = 1.25;
    const P = (sx: number, t: number): Vec3 => [sx * w / 2, y0 + (y1 - y0) * t, (t - .5) * len];
    this.poly(F, [P(-1, 0), P(1, 0), P(1, 1), P(-1, 1), P(-1, 0)], birth);
    for (let i = 1; i < rows; i++) this.seg(F, P(-1, i / rows), P(1, i / rows), birth + .05 + i / rows * .3);
    for (const [sx, t] of [[-1, .1], [1, .1], [-1, .9], [1, .9]]) { const p = P(sx * .9, t); this.seg(F, [p[0], 0, p[2]], p, birth); }
    const a = F.p(...P(-1, 0)), b = F.p(...P(1, 0)), c = F.p(...P(1, 1)), d = F.p(...P(-1, 1));
    const lift = (p: Vec3): Vec3 => [p[0] - F.u.x * .04, p[1] - F.u.y * .04, p[2] - F.u.z * .04];
    this.solids.tri(lift(a), lift(b), lift(c), GLOSS, birth); this.solids.tri(lift(a), lift(c), lift(d), GLOSS, birth);
  }
  /** Greenhouse shed from a to b (ground points): standing ribs, ridge, sills, a dark floor, a row of grow-lights under the ridge. */
  shed(ax: number, az_: number, bx: number, bz: number, w: number, birth: number) {
    const dx = bx - ax, dz = bz - az_, len = Math.hypot(dx, dz), az = Math.atan2(dx, dz), l = lod((ax + bx) / 2, (az_ + bz) / 2);
    const n = Math.max(5, Math.round(len / 1.9)), r = w / 2, m = seg(12, l, 7);
    const tops: Vec3[] = [], left: Vec3[] = [], right: Vec3[] = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n, F = Frame.from(ground(ax + dx * t, az_ + dz * t, .05), Y, az);
      this.arc(F, [0, 0, 0], r, m, birth + t * .25, 'z', 0, Math.PI);
      tops.push(F.p(0, r, 0)); left.push(F.p(-r, 0, 0)); right.push(F.p(r, 0, 0));
      if (i % 2 === 1) this.warm(F.p(0, r * .55, 0), birth + .35 + t * .2, .45);
      if (i > 0) { this.solids.tri(left[i - 1], right[i - 1], right[i], GLOSS, birth); this.solids.tri(left[i - 1], right[i], left[i], GLOSS, birth); }
    }
    this.lines.poly(tops, birth + .05); this.lines.poly(left, birth + .1); this.lines.poly(right, birth + .1);
    // end walls: a vertical post and a door hoop at the a end
    const E = Frame.from(ground(ax, az_, .05), Y, az);
    this.seg(E, [0, 0, 0], [0, r, 0], birth + .3); this.arc(E, [0, 0, 0], r * .3, 6, birth + .3, 'z', 0, Math.PI);
  }
  /** Drill derrick: tapered A-frame, braces, crown, drill string, a side hut, lights. */
  derrick(x: number, z: number, h: number, birth: number) {
    [x, , z] = siteOnLand(x, z, .3);
    const F = Frame.at(x, z, this.rand() * TAU, .15), l = lod(x, z), b = h * .19, t = h * .05;
    this.plate(x, z, b * 1.6, seg(10, l, 6), GLOSS, birth);
    for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) this.seg(F, [sx * b, 0, sz * b], [sx * t, h, sz * t], birth);
    for (const k of [.3, .6, .85]) { const w = b + (t - b) * k; this.square(F, 0, h * k, 0, w, w, birth + .1 + k * .2); }
    this.square(F, 0, h, 0, t, t, birth + .3);
    this.seg(F, [0, h + .4, 0], [0, 0, 0], birth + .35);
    this.ring(F, [0, h + .4, 0], t * 1.6, 8, birth + .3, 'x');
    this.box(F, b * 1.5, 0, 0, .7, .8, 1, birth + .2);
    this.warm(F.p(0, h * .62, 0), birth + .4, .5); this.warm(F.p(b * 1.5, .6, 0), birth + .45, .3); this.nav(F.p(0, h + .45, 0), birth + .4, .5);
  }
  /** Storage tank: a rust low-poly drum with stacked hairline hoops and a cap. */
  tank(x: number, z: number, r: number, h: number, birth: number) {
    [x, , z] = siteOnLand(x, z, .3);
    const F = Frame.at(x, z, 0, .2), l = lod(x, z), n = seg(14, l, 8);
    this.cylinder(F, 0, 0, 0, r * .96, h * .97, seg(9, l, 6), RUST, birth);
    for (const k of [.02, .35, .68, 1]) this.ring(F, [0, h * k, 0], r, n, birth + .05 + k * .15);
    for (let i = 0; i < 3; i++) { const a = i / 3 * TAU; this.seg(F, [Math.cos(a) * r, 0, Math.sin(a) * r], [Math.cos(a) * r, h, Math.sin(a) * r], birth + .1); }
    this.arc(F, [0, h, 0], r, seg(10, l, 6), birth + .25, 'z', 0, Math.PI, 0, 0);
    this.warm(F.p(r * .7, h + .1, 0), birth + .35, .3);
  }
  /** Tapering stacked-frame tower: floors, corner verticals, bracing, a mast and lights that climb floor by floor. */
  tower(x: number, z: number, w: number, h: number, birth: number, dense = false) {
    [x, , z] = siteOnLand(x, z, .4);
    const F = Frame.at(x, z, this.rand() * TAU, .1), l = lod(x, z), floors = Math.max(4, Math.round(h / (dense ? 2 : 2.3))), taper = dense ? .35 : .45;
    this.solidBox(F, 0, 0, 0, w * 1.25, .5, w * 1.25, RUST, birth);
    const hw = (i: number) => w * (1 - taper * i / floors), corners: Vec3[][] = [[], [], [], []];
    for (let i = 0; i <= floors; i++) {
      const y = .5 + (h - .5) * i / floors, s = hw(i), b = birth + .05 + i / floors * .45;
      this.square(F, 0, y, 0, s, s, b);
      [[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(([sx, sz], k) => corners[k].push([sx * s, y, sz * s]));
      if (i > 0 && l > .6 && i % 2 === 0) { const y0 = .5 + (h - .5) * (i - 1) / floors, s0 = hw(i - 1); this.seg(F, [-s0, y0, -s0], [s, y, -s], b); this.seg(F, [s0, y0, s0], [-s, y, s], b); }
      if (i > 0) for (let k = 0; k < seg(3, l, 1); k++) { const side = Math.floor(this.rand() * 4), u = (this.rand() - .5) * 1.6 * s, inset = s * .82, p: Vec3 = side === 0 ? [u, y - .5, -inset] : side === 1 ? [u, y - .5, inset] : side === 2 ? [-inset, y - .5, u] : [inset, y - .5, u]; this.warm(F.p(...p), b + .15 + this.rand() * .1, .3 + this.rand() * .15); }
      // window rows: a regular run of lights across two faces of every floor (every other floor far out)
      const per = dense ? 4 : 3;
      if (i > 0 && (l > .6 || i % 2 === 0)) for (const side of [-1, 1]) for (let k = 0; k < per; k++) this.warm(F.p((k / (per - 1) - .5) * s * 1.3, y - .55, side * s * .86), b + .12 + k * .03, .26);
      if (dense && i > 0 && i % 2 === 0) this.ring(F, [0, y - .02, 0], s * 1.12, seg(12, l, 8), b + .05);
      if (i > 0 && i % 4 === 0) this.nav(F.p(s * 1.02, y, s * 1.02), b + .2, .35);
    }
    for (const col of corners) this.poly(F, col, birth + .05);
    const ht = hw(floors);
    this.ring(F, [0, h, 0], ht * 1.1, seg(12, l, 6), birth + .5);
    this.seg(F, [0, h, 0], [0, h + h * .14, 0], birth + .5);
    this.nav(F.p(0, h + h * .14 + .05, 0), birth + .6, .55);
  }
  /** Launch gantry: an untapered lattice tower with X-bracing, a service arm with a hanging umbilical, lights. */
  gantry(x: number, z: number, h: number, birth: number, armAz: number) {
    [x, , z] = siteOnLand(x, z, .4);
    const F = Frame.at(x, z, armAz, .05), w = .9, bays = Math.round(h / 1.6);
    this.nav(F.p(w, h + .1, w), birth + .5, .5); this.nav(F.p(-w, h * .5, -w), birth + .5, .35);
    this.solidBox(F, 0, 0, 0, w * 1.5, .35, w * 1.5, GLOSS, birth);
    for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) this.seg(F, [sx * w, 0, sz * w], [sx * w, h, sz * w], birth);
    for (let i = 1; i <= bays; i++) {
      const y = h * i / bays, y0 = h * (i - 1) / bays, b = birth + .05 + i / bays * .4;
      this.square(F, 0, y, 0, w, w, b);
      this.seg(F, [-w, y0, -w], [w, y, -w], b); this.seg(F, [w, y0, w], [-w, y, w], b);
      this.seg(F, [-w, y0, w], [-w, y, -w], b); this.seg(F, [w, y0, -w], [w, y, w], b);
    }
    const ay = h * .82, reach = 3.4;
    this.poly(F, [[-w, ay, w], [-w, ay, w + reach], [w, ay, w + reach], [w, ay, w]], birth + .5);
    this.poly(F, [[-w, ay + .5, w], [-w, ay, w + reach]], birth + .5); this.poly(F, [[w, ay + .5, w], [w, ay, w + reach]], birth + .5);
    this.seg(F, [0, ay, w + reach], [0, ay - 2.2, w + reach], birth + .55);
    this.warm(F.p(0, ay - 2.3, w + reach), birth + .6, .5); this.warm(F.p(0, ay + .1, w), birth + .6, .4);
    this.seg(F, [0, h, 0], [0, h + 1.4, 0], birth + .5); this.nav(F.p(0, h + 1.45, 0), birth + .55, .7);
    for (const k of [.25, .5]) this.warm(F.p(w, h * k, w), birth + .5, .3);
  }
  /** Ascending ship: a cross-shaped hairline silhouette (fuselage + fins) with an engine spark, looping up with `rise`. */
  ship(x: number, z: number, s: number, rise: number, phase: number, birth: number) {
    const F = Frame.from(ground(x, z, .4), Y, 0);
    const body: Vec3[] = [[-.2, 0, 0], [-.24, .45, 0], [-.21, 1.45, 0], [0, 2, 0], [.21, 1.45, 0], [.24, .45, 0], [.2, 0, 0], [-.2, 0, 0]];
    const fin: Vec3[] = [[.24, .55, 0], [.58, 0, 0], [.24, .08, 0]];
    const S = (p: Vec3, swap: boolean, mx = 1): Vec3 => swap ? [0, p[1] * s, p[0] * s * mx] : [p[0] * s * mx, p[1] * s, 0];
    for (const swap of [false, true]) {
      this.poly(F, body.map(p => S(p, swap)), birth, rise, phase);
      this.poly(F, fin.map(p => S(p, swap)), birth, rise, phase); this.poly(F, fin.map(p => S(p, swap, -1)), birth, rise, phase);
    }
    this.lights.add(F.p(0, -.08 * s, 0), birth, 2, rise, phase);
    this.lights.add(F.p(0, -.5 * s, 0), birth, 1.1, rise, phase);
  }
  /** Lander: a cone/cylinder body on four splayed legs with foot pads, on a scorched pad; a hatch light. */
  lander(x: number, z: number, s: number, birth: number) {
    [x, , z] = siteOnLand(x, z, .4);
    const F = Frame.at(x, z, this.rand() * TAU, .1), l = lod(x, z), n = seg(14, l, 8);
    this.plate(x, z, 3 * s, seg(14, l, 8), GLOSS, birth);
    const rings: [number, number][] = [[1.1, .9], [2.05, .62], [2.85, .22]];
    for (const [y, r] of rings) this.ring(F, [0, y * s, 0], r * s, n, birth + .1);
    for (let i = 0; i < 6; i++) { const a = i / 6 * TAU; this.poly(F, rings.map(([y, r]) => [Math.cos(a) * r * s, y * s, Math.sin(a) * r * s] as Vec3), birth + .15); }
    for (let i = 0; i < 4; i++) {
      const a = i / 4 * TAU + .4, fx = x + Math.cos(a) * 1.9 * s, fz = z + Math.sin(a) * 1.9 * s, foot = ground(fx, fz, .04);
      this.lines.seg(F.p(Math.cos(a) * .9 * s, 1.1 * s, Math.sin(a) * .9 * s), foot, birth + .05);
      this.lines.seg(F.p(Math.cos(a) * .9 * s, .55 * s, Math.sin(a) * .9 * s), foot, birth + .05);
      this.lines.circle(foot, .2 * s, birth + .05, 'y', 6);
    }
    this.warm(F.p(.75 * s, 1.55 * s, 0), birth + .3, .4);
    this.nav(F.p(0, 2.95 * s, 0), birth + .3, .35);
  }
  /** Weather station: a short pole with a cross-arm, cup anemometer and vane, an instrument box at its foot. */
  weather(x: number, z: number, birth: number) {
    [x, , z] = siteOnLand(x, z, .3);
    const F = Frame.at(x, z, this.rand() * TAU, .2);
    this.seg(F, [0, 0, 0], [0, 2.6, 0], birth); this.seg(F, [-.8, 2.5, 0], [.8, 2.5, 0], birth + .1);
    this.ring(F, [-.8, 2.6, 0], .25, 8, birth + .15); this.seg(F, [.8, 2.5, 0], [1.05, 2.9, 0], birth + .15);
    this.seg(F, [0, 1.6, -.5], [0, 1.6, .5], birth + .1);
    this.box(F, .9, 0, .6, .45, .5, .35, birth + .1);
    this.warm(F.p(.9, .55, .6), birth + .3, .25);
  }
  /** Cable tether slung between two hilltops: end poles, a sagging catenary, a gondola with a light near the low point. */
  tether(ax: number, az: number, bx: number, bz: number, sag: number, birth: number, poleH = 3) {
    const a = ground(ax, az), b = ground(bx, bz), top = (p: Vec3): Vec3 => [p[0], p[1] + poleH, p[2]];
    this.lines.seg(a, top(a), birth); this.lines.seg(b, top(b), birth);
    const pts: Vec3[] = [], n = 20;
    for (let i = 0; i <= n; i++) { const t = i / n; pts.push([a[0] + (b[0] - a[0]) * t, a[1] + poleH + (b[1] - a[1]) * t - sag * 4 * t * (1 - t), a[2] + (b[2] - a[2]) * t]); }
    this.lines.poly(pts, birth + .1);
    const g = pts[8]; this.lines.seg(g, [g[0], g[1] - .5, g[2]], birth + .4); this.lines.circle([g[0], g[1] - .7, g[2]], .22, birth + .4, 'z', 6);
    this.warm([g[0], g[1] - .7, g[2]], birth + .45, .35);
    this.nav(top(a), birth + .2, .4); this.nav(top(b), birth + .2, .4);
  }
  /** Road through 2D waypoints (Catmull-Rom), draped on the terrain; lights every `every` units, lighting up along its length. */
  road(wp: [number, number][], birth: number, every = 0, wobble = 0, lightBirth = birth + .2) {
    const pts: Vec3[] = []; let acc = 0, total = 0;
    const sampled = spline(wp, 1.5);
    for (let i = 1; i < sampled.length; i++) total += Math.hypot(sampled[i][0] - sampled[i - 1][0], sampled[i][1] - sampled[i - 1][1]);
    for (let i = 0; i < sampled.length; i++) {
      let [x, z] = sampled[i];
      if (wobble) { x += Math.sin(i * 1.7 + wp[0][0]) * wobble; z += Math.cos(i * 2.3 + wp[0][1]) * wobble; }
      pts.push(ground(x, z, .1));
      if (i > 0) acc += Math.hypot(x - sampled[i - 1][0], z - sampled[i - 1][1]);
      if (every && i > 0 && acc >= (Math.hypot(x, z) < 60 ? Math.min(every, 2) : every)) { acc = 0; const h = heightAt(x, z); this.warm([x + .4, h.y + .3, z], lightBirth + (i / sampled.length) * .5, .3); }
    }
    this.lines.poly(pts, birth);
    return total;
  }
  /** Pipeline on short supports, from a pool intake (a ring on the water) along ground waypoints. */
  pipeline(wp: [number, number][], birth: number, intake = true) {
    const sampled = spline(wp, 2);
    const pts = sampled.map(([x, z]) => ground(x, z, .55));
    this.lines.poly(pts, birth);
    for (let i = 0; i < sampled.length; i++) { const [x, z] = sampled[i]; this.lines.seg(ground(x, z), ground(x, z, .55), birth + .1); }
    if (intake) { const [x, z] = sampled[0]; const h = heightAt(x, z); this.lines.circle([x, h.y + .08, z], .9, birth + .2, 'y', 12); this.lines.circle([x, h.y + .08, z], .45, birth + .2, 'y', 8); }
  }
  /** Pipeline bridge across a pool: a straight deck with piers standing in the water, a pipe below, deck lights at stage 3. */
  bridge(ax: number, az: number, bx: number, bz: number, birth: number) {
    const a = ground(ax, az), b = ground(bx, bz), y = Math.max(a[1], b[1]) + 1.3, n = Math.round(Math.hypot(bx - ax, bz - az) / 3.6);
    const dx = (bx - ax) / n, dz = (bz - az) / n, nx = -dz / Math.hypot(dx, dz), nz = dx / Math.hypot(dx, dz);
    this.lines.poly([a, [ax, y, az], [bx, y, bz], b], birth);
    this.lines.seg([ax + nx * .5, y - .3, az + nz * .5], [bx + nx * .5, y - .3, bz + nz * .5], birth + .1);
    for (let i = 1; i < n; i++) {
      const x = ax + dx * i, z = az + dz * i, g = heightAt(x, z).y;
      this.lines.seg([x + nx * .6, g, z + nz * .6], [x, y, z], birth + .1 + i / n * .2); this.lines.seg([x - nx * .6, g, z - nz * .6], [x, y, z], birth + .1 + i / n * .2);
      if (i % 2 === 0) this.warm([x, y + .25, z], 3 + i / n * .4, .3);
    }
  }
  /** Landing ring: draped circles, radial ticks, a glossy pad, approach lights around the rim. */
  landingRing(x: number, z: number, r: number, birth: number) {
    [x, , z] = siteOnLand(x, z, .4);
    const l = lod(x, z), n = seg(40, l, 16), y0 = heightAt(x, z).y + .1, N = Y.clone().lerp(normalAt(x, z), .3).normalize();
    const on = (a: number, rad: number, lift: number): Vec3 => { const dx = Math.cos(a) * rad, dz = Math.sin(a) * rad; return [x + dx, y0 + lift - (N.x * dx + N.z * dz) / N.y, z + dz]; };
    const flat = (rad: number, lift: number) => Array.from({ length: n + 1 }, (_, i) => on(i / n * TAU, rad, lift));
    this.plate(x, z, r * 1.05, seg(16, l, 8), GLOSS, birth);
    this.lines.poly(flat(r, .16), birth); this.lines.poly(flat(r * .62, .16), birth + .1);
    for (let i = 0; i < 4; i++) { const a = i / 4 * TAU + .3; this.lines.seg(on(a, r * .62, .16), on(a, r, .16), birth + .15); }
    const m = seg(8, l, 4);
    for (let i = 0; i < m; i++) { const a = i / m * TAU; this.warm(on(a, r * .94, .3), birth + .25 + i / m * .15, .35); }
  }
  /** Pumping station at a pool edge: a hut with a stack, a pipe running out to an intake ring on the water. */
  pump(x: number, z: number, birth: number, toward: number) {
    [x, , z] = siteOnLand(x, z, .3);
    const F = Frame.at(x, z, toward, .2);
    this.box(F, 0, 0, 0, 1.2, 1.3, .9, birth); this.seg(F, [.6, 1.3, 0], [.6, 2.4, 0], birth + .1); this.ring(F, [.6, 2.4, 0], .2, 6, birth + .1);
    const pts: Vec3[] = []; for (let i = 0; i <= 4; i++) pts.push(ground(x + Math.sin(toward) * i * 1.6, z + Math.cos(toward) * i * 1.6, .45));
    this.lines.poly(pts, birth + .15);
    const e = pts[4]; this.lines.circle([e[0], heightAt(e[0], e[2]).y + .08, e[2]], .8, birth + .3, 'y', 10);
    this.warm(F.p(0, 1.1, -.95), birth + .3, .35);
  }
  /** Comms mast: a tall guyed pole with stacked ring arrays, a cold light on top and warm ones down the pole. */
  comms(x: number, z: number, h: number, birth: number) {
    const F = this.mast(x, z, h, birth, 3, 0, true), l = lod(x, z);
    for (const [k, r] of [[.66, .7], [.78, .5], [.9, .32]]) { this.ring(F, [0, h * k, 0], r, seg(10, l, 6), birth + .2); this.seg(F, [-r, h * k, 0], [r, h * k, 0], birth + .2); }
    this.warm(F.p(0, h * .45, 0), birth + .3, .3); this.warm(F.p(0, h * .25, 0), birth + .3, .3);
  }

  // ---- near-ring set pieces (large, 35 … 50 u from the stele, each fills a good part of the frame at its yaw) ---------
  /** Big habitat dome (r 6 … 7): five latitude rings, eight meridians, three interior tiers with railings and columns, a core,
   *  three radiating airlock tunnels, a crown mast; the windows (lightBirth) come on a stage after the shell. */
  bigDome(x: number, z: number, r: number, birth: number, lightBirth = birth + 1, az = 0) {
    [x, , z] = siteOnLand(x, z, .5);
    const F = Frame.at(x, z, az, .12), o: Vec3 = [F.o.x, F.o.y, F.o.z], n = 56;
    this.plate(x, z, r * 1.1, 24, GLOSS, birth);
    for (const k of [0, .22, .45, .66, .84]) this.ring(F, [0, r * k, 0], r * Math.sqrt(1 - k * k), n, birth + .05 + k * .25);
    for (let i = 0; i < 4; i++) this.arc(Frame.from(o, F.u, az + i * Math.PI / 4), [0, 0, 0], r, 36, birth + .1 + i * .05, 'z', 0, Math.PI);
    const tiers = [.18, .4, .6], rad = (k: number) => r * Math.sqrt(1 - k * k) * .86;
    tiers.forEach((k, t) => {
      const rr = rad(k), y = r * k, b = birth + .3 + t * .1;
      this.ring(F, [0, y, 0], rr, 40, b); this.ring(F, [0, y + .45, 0], rr, 40, b + .05);
      for (let i = 0; i < 12; i++) { const a = i / 12 * TAU; this.seg(F, [Math.cos(a) * rr, y, Math.sin(a) * rr], [Math.cos(a) * rr, y + .45, Math.sin(a) * rr], b + .05); }
      const nk = tiers[t + 1] ?? .78, nr = rad(nk);
      for (let i = 0; i < 8; i++) { const a = i / 8 * TAU + .2; this.seg(F, [Math.cos(a) * rr, y, Math.sin(a) * rr], [Math.cos(a) * nr, r * nk, Math.sin(a) * nr], b + .1); }
      for (let i = 0; i < 16; i++) { const a = i / 16 * TAU + t * .13; this.warm(F.p(Math.cos(a) * rr * .97, y + .28, Math.sin(a) * rr * .97), lightBirth + i / 16 * .5 + t * .15, .3); }
    });
    // core and crown
    const cr = r * .12; for (const y of [0, r * .4, r * .78]) this.ring(F, [0, y, 0], cr, 12, birth + .25);
    for (let i = 0; i < 4; i++) { const a = i / 4 * TAU; this.seg(F, [Math.cos(a) * cr, 0, Math.sin(a) * cr], [Math.cos(a) * cr, r * .78, Math.sin(a) * cr], birth + .25); }
    this.seg(F, [0, r, 0], [0, r + 2.4, 0], birth + .5); this.ring(F, [0, r + 1.6, 0], .5, 8, birth + .5); this.nav(F.p(0, r + 2.45, 0), birth + .6, .6);
    for (let i = 0; i < 8; i++) { const a = i / 8 * TAU, rr = r * Math.sqrt(1 - .84 * .84); this.warm(F.p(Math.cos(a) * rr * .95, r * .84 - .2, Math.sin(a) * rr * .95), lightBirth + .4 + i * .03, .28); }
    // airlock tunnels running out in three directions, each ending in a hoop and a lamp
    for (let i = 0; i < 3; i++) {
      const a = az + i / 3 * TAU + .5, ax = x + Math.sin(a) * r * .98, azz = z + Math.cos(a) * r * .98, bx = x + Math.sin(a) * (r + 6), bz = z + Math.cos(a) * (r + 6);
      this.tunnel(ground(ax, azz), ground(bx, bz), birth + .35 + i * .1, .9);
      this.warm(ground(bx, bz, .4), lightBirth + .2 + i * .1, .35);
    }
    return F;
  }
  /** Tank farm: six big drums in two rows with header pipes, risers up each drum, support ticks, a walkway railing around. */
  tankFarm(x: number, z: number, birth: number, az = 0) {
    [x, , z] = siteOnLand(x, z, .5);
    const F = Frame.at(x, z, az, .08), sizes: [number, number][] = [[3.2, 6.5], [2.7, 5.4], [3.6, 7.6], [2.6, 5], [3.4, 7], [3, 6.2]];
    const pitch = 8, spots: [number, number, number, number][] = [];
    sizes.forEach(([r, h], i) => { const lx = (i % 3 - 1) * pitch, lz = (Math.floor(i / 3) - .5) * pitch; const p = F.p(lx, 0, lz); this.tank(p[0], p[2], r, h, birth + i * .07); spots.push([lx, lz, r, h]); });
    for (const row of [0, 1]) {
      const lz = (row - .5) * pitch + (row ? 5 : -5), y = 1.2;
      this.seg(F, [-pitch - 3, y, lz], [pitch + 3, y, lz], birth + .3);
      for (let u = -pitch - 2; u <= pitch + 2; u += 2) this.seg(F, [u, 0, lz], [u, y, lz], birth + .3);
      for (let i = 0; i < 3; i++) { const [lx, tz, r, h] = spots[row * 3 + i], s = row ? -1 : 1; this.poly(F, [[lx, y, lz], [lx, y, tz + s * r * 1.02], [lx, h * .98, tz + s * r * 1.02]], birth + .35 + i * .05); }
    }
    for (const sx of [-1, 1]) this.seg(F, [sx * (pitch + 3), 1.2, -pitch / 2 - 5], [sx * (pitch + 3), 1.2, pitch / 2 + 5], birth + .3);
    const hw = pitch + 5.5, hd = pitch / 2 + 7;
    this.square(F, 0, 1.05, 0, hw, hd, birth + .4);
    for (let u = -hw; u <= hw; u += 2.2) for (const sz of [-1, 1]) this.seg(F, [u, 0, sz * hd], [u, 1.05, sz * hd], birth + .45);
    for (let v = -hd; v <= hd; v += 2.2) for (const sx of [-1, 1]) this.seg(F, [sx * hw, 0, v], [sx * hw, 1.05, v], birth + .45);
    for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { this.seg(F, [sx * hw, 1.05, sz * hd], [sx * hw, 2.6, sz * hd], birth + .5); this.warm(F.p(sx * hw, 2.7, sz * hd), birth + .55, .4); }
    for (let i = 0; i < 6; i++) { const [lx, lz, r, h] = spots[i]; this.warm(F.p(lx + r * .5, h * .55, lz + r * .85), 3 + i * .08, .3); }
    this.box(F, 0, 0, 0, 1.4, 1.6, 1.1, birth + .4); this.warm(F.p(0, 1.9, 0), birth + .5, .35);
  }
  /** Dish array: six reflectors on a shared truss beam (two chords, X-bracing) carried by three A-frames, all tilted to one point in the sky. */
  dishArray(x: number, z: number, birth: number, az = 0, lookAz = -2.2, elev = .75) {
    [x, , z] = siteOnLand(x, z, .5);
    const F = Frame.at(x, z, az, .1), half = 11, y1 = 4.2, y0 = 3.5;
    this.seg(F, [-half, y1, 0], [half, y1, 0], birth); this.seg(F, [-half, y0, 0], [half, y0, 0], birth);
    for (let u = -half; u < half; u += 2) { this.seg(F, [u, y0, 0], [u + 2, y1, 0], birth + .05); this.seg(F, [u, y1, 0], [u + 2, y0, 0], birth + .05); this.seg(F, [u, y0, 0], [u, y1, 0], birth + .05); }
    for (const lx of [-half + 1.5, 0, half - 1.5]) { const g = (dz: number) => { const p = F.p(lx, 0, dz); return ground(p[0], p[2]); }; this.lines.seg(g(-1.6), F.p(lx, y0, 0), birth); this.lines.seg(g(1.6), F.p(lx, y0, 0), birth); this.lines.seg(g(-1.6), g(1.6), birth + .05); }
    for (let i = 0; i < 6; i++) {
      const lx = -half + 1 + i * 4, r = 2.3 + (i % 2) * .4, top = F.p(lx, y1 + .5, 0);
      this.seg(F, [lx, y1, 0], [lx, y1 + .5, 0], birth + .1 + i * .08);
      this.dishHead(top, r, lookAz, elev, birth + .1 + i * .08, 1);
    }
    this.nav(F.p(-half, y1 + .1, 0), birth + .5, .4); this.nav(F.p(half, y1 + .1, 0), birth + .5, .4);
    this.box(F, 0, 0, 3.2, 1.1, 1.2, .9, birth + .3); this.warm(F.p(0, 1.4, 3.2), birth + .4, .35);
  }
  /** Big lit landing ring (r ≈ 5): the ring itself, a line of approach lights, four cold rim markers, a control hut. */
  bigRing(x: number, z: number, r: number, birth: number, approachAz = 0) {
    [x, , z] = siteOnLand(x, z, .5);
    this.landingRing(x, z, r, birth);
    const y0 = heightAt(x, z).y + .1, N = Y.clone().lerp(normalAt(x, z), .3).normalize();
    for (let i = 0; i < 4; i++) { const a = i / 4 * TAU, dx = Math.cos(a) * r * 1.08, dz = Math.sin(a) * r * 1.08; this.nav([x + dx, y0 + .35 - (N.x * dx + N.z * dz) / N.y, z + dz], birth + .3 + i * .05, .45); }
    const pts: Vec3[] = [];
    for (let i = 0; i <= 10; i++) { const d = r * 1.3 + i * 1.3, px = x + Math.sin(approachAz) * d, pz = z + Math.cos(approachAz) * d; pts.push(ground(px, pz, .1)); if (i % 1 === 0) this.warm(ground(px + .5, pz, .25), birth + .4 + i * .04, .3); }
    this.lines.poly(pts, birth + .2);
    const hx = x + Math.cos(approachAz) * r * 1.5, hz = z - Math.sin(approachAz) * r * 1.5, H = Frame.at(hx, hz, approachAz, .2);
    this.box(H, 0, 0, 0, 1, 1.1, .8, birth + .3); this.seg(H, [0, 1.1, 0], [0, 2.6, 0], birth + .35); this.nav(H.p(0, 2.65, 0), birth + .4, .4); this.warm(H.p(.5, .6, .85), birth + .4, .3);
  }
  /** Solar farm: a 20 × 8 u grid of panel strips with a perimeter fence line, corner lamps and a switch box. */
  solarFarm(x: number, z: number, birth: number, az = 0) {
    [x, , z] = siteOnLand(x, z, .5);
    const F = Frame.at(x, z, az, .1);
    for (let row = 0; row < 5; row++) for (let col = 0; col < 2; col++) { const p = F.p((col - .5) * 4.2, 0, (row - 2) * 4); this.solar(p[0], p[2], 3.6, 3.4, birth + row * .06 + col * .03, az); }
    const hw = 5.4, hd = 10.4;
    this.square(F, 0, .05, 0, hw, hd, birth);
    for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { this.seg(F, [sx * hw, 0, sz * hd], [sx * hw, 1.8, sz * hd], birth + .3); this.warm(F.p(sx * hw, 1.85, sz * hd), 3 + .1 * (sx + sz + 2), .3); }
    this.box(F, hw + 1.2, 0, 0, .6, .9, .6, birth + .3); this.warm(F.p(hw + 1.2, 1, 0), birth + .4, .3);
  }
  /** Space elevator: a base station, two cables straight up out of frame, static cold marker lights up the ribbon, climbers
   *  riding up (risers with distinct phases), a counterweight ring with a cold light at the top. */
  elevator(x: number, z: number, birth: number, top = 160) {
    [x, , z] = siteOnLand(x, z, .6);
    const F = Frame.at(x, z, 0, .05), g = F.p(0, 0, 0);
    this.plate(x, z, 4, 16, GLOSS, birth);
    this.ring(F, [0, .1, 0], 3.4, 24, birth); this.ring(F, [0, 2.2, 0], 2.2, 16, birth + .05);
    for (let i = 0; i < 8; i++) { const a = i / 8 * TAU; this.seg(F, [Math.cos(a) * 3.4, .1, Math.sin(a) * 3.4], [Math.cos(a) * 2.2, 2.2, Math.sin(a) * 2.2], birth + .05); }
    this.box(F, 0, 0, 0, 1.3, 3.2, 1.3, birth + .1);
    for (const sx of [-.18, .18]) this.lines.seg([g[0] + sx, g[1] + 3.2, g[2]], [g[0] + sx, g[1] + top, g[2]], birth + .15);
    for (let i = 1; i <= 7; i++) { const y = g[1] + 3.2 + (top - 3.2) * i / 8; this.lines.circle([g[0], y, g[2]], .5, birth + .2 + i * .03, 'y', 6); this.nav([g[0], y + .05, g[2]], birth + .25 + i * .03, .35); }
    this.lines.circle([g[0], g[1] + top, g[2]], 2.2, birth + .4, 'y', 16); this.lines.circle([g[0], g[1] + top - 1.5, g[2]], 1.2, birth + .4, 'y', 10);
    this.nav([g[0], g[1] + top + .2, g[2]], birth + .5, 1.3);
    for (let i = 0; i < 8; i++) this.lights.add([g[0], g[1] + 3.4, g[2]], birth + .3, .9, .16 + i * .025, i / 8 + this.rand() * .04);
    for (let i = 0; i < 8; i++) { const a = i / 8 * TAU; this.warm(F.p(Math.cos(a) * 2.8, .5, Math.sin(a) * 2.8), birth + .2 + i * .03, .35); }
    this.warm(F.p(0, 3.3, 1.35), birth + .2, .4);
  }
}

/** Catmull-Rom through 2D waypoints, resampled every ~`step` units. */
function spline(wp: [number, number][], step: number): [number, number][] {
  const out: [number, number][] = [];
  const P = (i: number) => wp[THREE.MathUtils.clamp(i, 0, wp.length - 1)];
  for (let i = 0; i < wp.length - 1; i++) {
    const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2), n = Math.max(1, Math.round(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / step));
    for (let k = 0; k < n; k++) {
      const t = k / n, t2 = t * t, t3 = t2 * t;
      out.push([.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
        .5 * (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3)]);
    }
  }
  out.push(wp[wp.length - 1]);
  return out;
}

// ---- districts -------------------------------------------------------------------------------------------------------------

/** PAD (−z): the arrival plain at the pool's edge, the saddle behind it → the spaceport. */
function pad(c: Colony) {
  // stage 0 — arrival
  c.bigRing(12, -38, 5, 0, Math.PI * .55); c.lander(12, -38, 1, .15);
  c.weather(14.5, -28.5, .1);
  c.mast(16, -30, 5, .2, 3, 1); c.mast(16, -41, 6, .35, 3, 1);
  c.road([[12, -38], [15.5, -42], [14.5, -48], [10, -54]], .3, 0, .35);
  c.beacon(23.5, -27, 2.2, .5); c.beacon(9, -49, 2.4, .6);
  // stage 1 — outpost on the crests either side of the saddle
  c.dome(2, -50, 3.2, 1); c.dome(20, -50, 2.6, 1.2); c.dome(12, -46, 2.1, 1.35); c.dome(16, -55, 2.2, 1.5); c.dome(-4, -46, 2.4, 1.6);
  c.bigDome(25, -35, 6.5, 1, 2, .6);
  c.dish(-2, -55, 1.7, 1.4, 2.6, 1); c.lander(12, -58, 1, 1.5);
  c.mast(21, -53, 7, 1.3, 3, 2); c.solar(6, -62, 3.5, 6, 1.5, .3);
  c.road([[12, -46], [8, -49], [3, -50]], 1.1, 4);
  // stage 2 — the pads
  c.landingRing(7, -55, 2.4, 2); c.landingRing(15, -53.5, 2.3, 2.2);
  c.tank(18.5, -59, .8, 2, 2.3); c.tank(20.5, -59, .8, 2, 2.4);
  c.tunnel(siteOnLand(2, -50, .4), siteOnLand(12, -46, .4), 2.3); c.tunnel(siteOnLand(16, -55, .4), siteOnLand(20, -50, .4), 2.4);
  c.pipeline([[6, -40], [10, -44], [14, -49], [18, -57]], 2.4);
  // stage 3 — the spaceport
  c.landingRing(6, -61.5, 3.2, 3); c.tower(-6, -58, 1.6, 12, 3.1);
  c.comms(14, -27, 9, 3.3); c.tether(0, -52, 20, -52, 2.2, 3.5, 2.5);
  // stage 4 — launch
  c.gantry(14.5, -60.5, 14, 4, -Math.PI * .5); c.gantry(-1, -66, 17, 4.3, Math.PI * .3);
  c.ship(7, -55, 1, .8, .1, 4.2); c.ship(15, -53.5, .9, 1.1, .55, 4.3); c.ship(6, -61.5, 1.3, .65, .8, 4.4);
  c.nav([-4, BASE + 16, -70], 4.5, 1.2);
}

/** OBS (−x): the observatory ridge — a habitat cluster on the crest, dishes to the sky, a solar strip on the flat behind. */
function observatory(c: Colony) {
  c.beacon(-44, -6, 2.4, .7);
  // stage 1 — the ridge outpost
  c.dome(-56, -10, 3.8, 1.1, .6); c.dome(-54, -2, 3, 1.3); c.dome(-58, 2, 2.6, 1.5); c.dome(-58, -20, 2.4, 1.4); c.dome(-60, -4, 2, 1.6);
  c.dishArray(-40, 20, 1.8, .67, -2.4, .8); c.tankFarm(-46, 6, 2.2, .1);
  c.dish(-57, -27, 2.2, 1.2, -1.2, .95); c.dish(-52, -15, 1.5, 1.45, -1.6, .8);
  c.mast(-60, 0, 6, 1.2, 3, 2); c.mast(-44, 17, 4.5, 1.5, 0, 2); c.mast(-62, -6, 5, 1.35, 4, 0, false);
  c.solar(-68, 6, 5, 9, 1.6, .15);
  c.road([[-58, -25], [-56, -13], [-53, -2], [-49, 8], [-46, 15]], 1.05, 4, 0, 1.3);
  // stage 2 — settlement
  c.tunnel(siteOnLand(-56, -10, .4), siteOnLand(-54, -2, .4), 2.1); c.tunnel(siteOnLand(-54, -2, .4), siteOnLand(-50, 6, .4), 2.25); c.tunnel(siteOnLand(-56, -10, .4), siteOnLand(-58, -20, .4), 2.4);
  c.shed(-72, 10, -64, 12, 3.4, 2.2); c.shed(-72, 15, -64, 17, 3.2, 2.4);
  c.tank(-51, -11, 1, 2.4, 2.3); c.tank(-49, -12.5, 1, 2.4, 2.4);
  c.derrick(-42, -24, 7, 2.1);
  c.pipeline([[-46, -21], [-50, -19], [-54, -16], [-56, -12], [-53, -9]], 2.5);
  // stage 3 — city
  c.tower(-56, -6, 1.5, 12, 3.2); c.comms(-57, -32, 10, 3.1);
  c.tether(-56, -4, -36, 16, 2.6, 3.4);
  c.pump(-41, -18, 3.3, Math.atan2(2, 3));
  c.landingRing(-64, 20, 3, 3.5);
}

/** SCI (−x −z, ~100 out): a small science outpost on the far crest, simplified for the fog. */
function science(c: Colony) {
  c.dome(-76, -62, 3, 1.5); c.dish(-79, -66, 2.4, 1.7, -2.2, 1); c.mast(-73, -58, 8, 1.6, 3, 1);
  c.dome(-72, -64, 2.2, 2.6); c.tank(-78, -58, 1, 2.2, 2.7);
  c.comms(-80, -70, 12, 3.4); c.beacon(-70, -70, 2.5, 2.8);
  c.road([[-76, -62], [-72, -64], [-73, -58]], 2.6, 0);
}

/** FARM (+z): greenhouses in the valley on the west shore of the long south lake, under its crest. */
function farm(c: Colony) {
  c.beacon(-26, 40, 2.4, .8);
  c.dome(-29, 44, 2.6, 1.6); c.mast(-33, 42, 5, 1.7, 3, 1); c.dome(-36, 46, 2.2, 2.7); c.dome(-31, 40, 2, 1.9);
  // stage 2 — the farm: sheds down the slope toward the shore
  c.shed(-38, 48, -28, 49, 3.2, 2); c.shed(-39, 53, -28, 54, 3.4, 2.15); c.shed(-39, 58, -28, 59, 3.2, 2.3); c.shed(-38, 63, -27, 64, 3, 2.45); c.shed(-39, 68, -28, 69, 3.1, 2.55); c.shed(-38, 73, -28, 74, 3.2, 2.65);
  c.tank(-31, 45, 1.1, 2.6, 2.5); c.tank(-28, 41, .9, 2.2, 2.55);
  c.pipeline([[-29, 46], [-29.5, 51], [-29.5, 56], [-29, 61], [-28, 66]], 2.3, false);
  c.pump(-30, 56, 2.6, Math.PI * .5);
  c.road([[-29, 44], [-33, 49], [-34, 54], [-34, 59], [-33, 64]], 2.1, 4);
  // stage 3
  c.tether(-36, 36, -36, 56, 2.2, 3.3);
  c.dome(-30, 78, 2.2, 3.4); c.mast(-37, 50, 7, 3.2, 3, 2);
}

/** IND (+z): mining and processing on the east shore of the lake — derricks at the water, pipelines, tanks, the bridge. */
function industry(c: Colony) {
  c.mast(24, 44, 5, 1.6, 3, 1); c.dome(28, 48, 2.4, 1.7);
  // stage 2 — the drills
  c.derrick(14, 40.5, 7, 2); c.derrick(26, 38.5, 8.5, 2.2);
  c.pipeline([[10, 35], [13, 39], [18, 43], [24, 46], [30, 46]], 2.3); c.pipeline([[22, 34], [26, 37], [29, 42], [31, 46]], 2.45);
  c.tank(31, 47, 1.3, 2.8, 2.4); c.tank(34, 47.5, 1.3, 2.8, 2.5); c.tank(33, 50.5, 1.1, 2.4, 2.6);
  c.box(Frame.at(21, 47, .4, .2), 0, 0, 0, 2.6, 2, 1.5, 2.5); c.warm(Frame.at(21, 47, .4, .2).p(0, 1.6, 1.55), 2.8, .35);
  c.landingRing(37, 42, 3, 2.6);
  c.bridge(19.5, 42, -27, 48, 2.7);
  c.road([[14, 40.5], [20, 44], [26, 46], [32, 44], [37, 42]], 2.2, 4);
  // stage 3
  c.pump(22, 39, 3.1, -Math.PI * .85); c.tower(28, 36, 2.4, 28, 3, true); c.tower(35, 51, 1.6, 14, 3.3);
  c.landingRing(41, 44, 4.2, 3.4); c.comms(48, 42, 9, 3.5); c.bigDome(42, 51, 5.5, 2, 3, 2.4);
  c.road([[37, 42], [44, 46]], 3.2, 3);
}

/** CITY (+x): the far shore of the east pool — towers mirrored in the water, tethers between the crests behind. */
function city(c: Colony) {
  c.dome(74, -6, 3, 1.4); c.mast(70, -14, 6, 1.6, 3, 1);
  // stage 2
  c.dome(72, 4, 2.8, 2.1); c.dome(76, 12, 2.4, 2.3); c.dome(70, -16, 2.2, 2.4); c.dome(82, -12, 2.6, 2.5); c.dome(76, -12, 2.6, 2.6); c.dome(70, 8, 2.4, 2.7); c.dome(66, 16, 2.2, 2.8); c.dome(84, 8, 2.8, 3.4);
  c.elevator(80, -2, 4.2);
  c.tunnel(siteOnLand(74, -6, .4), siteOnLand(72, 4, .4), 2.4); c.tunnel(siteOnLand(72, 4, .4), siteOnLand(76, 12, .4), 2.5);
  c.tank(78, 16, 1.2, 2.6, 2.5); c.tank(80.5, 16.5, 1.2, 2.6, 2.6);
  c.landingRing(78, -26, 3, 2.6);
  c.road([[70, -30], [68.5, -14], [70, -2], [72, 10], [76, 20]], 2.1, 4);
  // stage 3 — the city
  c.tower(80, -11, 1.9, 20, 3); c.tower(78, 7, 1.7, 16, 3.2);
  c.comms(85, -22, 11, 3.3); c.comms(74, 27, 9, 3.5);
  c.tether(84, -28, 84, 0, 2.6, 3.4); c.tether(84, 0, 72, 28, 3, 3.5);
  c.pump(68, 0, 3.1, -Math.PI * .5);
  c.landingRing(84, 21, 4.5, 3.4);
  c.road([[70, -30], [68.5, -14], [70, -2], [72, 10], [76, 20], [84, 21]], 3.1, 3, 0, 3.1);
  // stage 4
  c.ship(84, 21, 1.2, .7, .3, 4.3);
}

/** RELAY (−z, ~100 out): a comms relay on the far northern crest. */
function relay(c: Colony) {
  c.beacon(8, -100, 2.6, .9);
  c.mast(10, -102, 9, 2.6, 3, 1); c.dome(5, -98, 2.4, 2.8);
  c.comms(13, -105, 12, 3.6); c.tether(8, -100, 36, -108, 3.2, 3.6);
}

/** Roads between the districts (stage 2) that become lit boulevards (stage 3), and a few more lights everywhere at launch. */
function network(c: Colony) {
  // PAD saddle → west along the ridge mass → the observatory ridge
  const padObs: [number, number][] = [[3, -50], [-6, -56], [-18, -62], [-30, -56], [-42, -46], [-50, -36], [-56, -26]];
  c.road(padObs, 2.5, 0); c.road(padObs.map(([x, z]) => [x + .6, z + .6]), 3.1, 3, 0, 3.1);
  // observatory → farm, around the west pool's southern shore
  const obsFarm: [number, number][] = [[-50, 14], [-47, 22], [-43, 30], [-36, 38], [-29, 44]];
  c.road(obsFarm, 2.6, 0); c.road(obsFarm.map(([x, z]) => [x - .6, z]), 3.2, 3, 0, 3.2);
  // industry → city, along the east shore of the south pool and up the east land
  const indCity: [number, number][] = [[37, 42], [46, 40], [56, 38], [64, 34], [70, 26], [76, 20]];
  c.road(indCity, 2.7, 0); c.road(indCity.map(([x, z]) => [x, z + .6]), 3.3, 3, 0, 3.3);
  // more tethers between the ridge tops (stage 3)
  c.tether(16, -30, 2, -50, 2.5, 3.4); c.tether(-44, 14, -48, -2, 2, 3.5); c.tether(28, 36, 36, 50, 2.5, 3.6); c.tether(76, -14, 72, 12, 3, 3.3); c.tether(-24, -54, -6, -58, 2, 3.4); c.tether(-36, 46, -31, 70, 2.5, 3.5);
  c.solarFarm(-24, -56, 2.2, 1.2);
  // launch: lit crest markers all round the horizon and more beacons
  for (const [x, z] of [[-24, -60], [-36, -48], [-56, -40], [-36, 36], [36, 52], [44, 48], [84, -28], [72, 28], [0, -76], [-8, -80]]) c.nav(ground(x, z, .6), 4 + c.rand() * .5, .4);
}
