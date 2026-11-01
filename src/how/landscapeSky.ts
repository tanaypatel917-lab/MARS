import * as THREE from 'three';
import { fbm } from '../geometry';
import { heightAt, siteOnLand, seeded } from './landscapeTerrain';
import { Strokes, Sparks, Solids, type Vec3 } from './landscapeKit';

/**
 * What lives above the horizon of the colonised Martian landscape: a sparse star field with a galactic band, Phobos and Deimos,
 * giant distant landforms whose tops poke out of the dust (a shield volcano, mesas, a crater rim), and — once the colony is a
 * civilisation — launch contrails, an orbital ring arc, slow-climbing craft and an orbital station.
 *
 * Conventions: the camera at yaw θ (see landscapeTerrain) looks toward azimuth θ + 180°, so a landform at azimuth φ is on the
 * skyline at yaw φ − 180°; `at(φ, r)` places things by azimuth (degrees, 0 = +z, 90 = +x). The shared shaders haze everything
 * toward the fog with distance, thinning with altitude (FOG_SCALE_HEIGHT), so the bases of the landforms dissolve and only their
 * tops read — that is wanted. Everything here is deterministic (`seeded`).
 *
 * Births: the kit draws a stroke on over `(stage − birth) · 2.4 − aT · 1.2`, so an element must be born ≈ .9 before an integer
 * stage to be complete at that stage; the ASCEND elements here are born 3.1 … 3.6 (absent at stage 3, complete at 4) and the
 * REFINE craft at 2.6 … 2.9.
 */
export function buildSky() {
  return { stars: stars(), traffic: traffic(), strokes: strokes(), moons: moons(), mesas: mesas() };
}

/** The spaceport the launch traffic leaves from (the colony's landing rings). */
const PORT: readonly [number, number] = [36, -58];
const RAD = Math.PI / 180;
const at = (phi: number, r: number, y = 0): Vec3 => [Math.sin(phi * RAD) * r, y, Math.cos(phi * RAD) * r];

/**
 * Star sphere radius. The shared shaders haze by exp(−d²k·thin) toward the (near-black) zenith colour, so at the camera's
 * visible elevations (6 … 13°) a star 380 u out is > 85 % hazed and vanishes; at 110 u it keeps ~half its light and still fades
 * naturally into the dust band. Everything else in the sky sits beyond it only where no star is placed (moons get a clear cone).
 */
const STAR_R = 110;
const PHOBOS = at(332, 265 * Math.cos(11 * RAD), 265 * Math.sin(11 * RAD)), DEIMOS = at(102, 300 * Math.cos(12.3 * RAD), 300 * Math.sin(12.3 * RAD));

/** ~900 stars above 7.5° elevation (over the fog band), weighted toward the low sky the camera actually sees, denser toward a tilted galactic band, none in front of a moon. */
function stars() {
  const sparks = new Sparks(), rand = seeded(401);
  const band = new THREE.Vector3(.34, .5, .79).normalize();
  const d = new THREE.Vector3(), moons = [PHOBOS, DEIMOS].map(m => new THREE.Vector3(...m).normalize());
  let n = 0;
  while (n < 900) {
    const y = .13 + .87 * rand() ** 2.2, a = rand() * Math.PI * 2, h = Math.sqrt(1 - y * y);
    d.set(Math.cos(a) * h, y, Math.sin(a) * h);
    if (moons.some(m => m.dot(d) > Math.cos(2.5 * RAD))) continue;
    const off = d.dot(band), weight = .22 + .78 * Math.exp(-off * off / (2 * .15 * .15));
    if (rand() > weight) continue;
    const bright = rand(), size = .5 + .5 * bright * bright * (bright > .93 ? 1 : .8);
    sparks.add([d.x * STAR_R, d.y * STAR_R, d.z * STAR_R], 0, size, 0, rand());
    n++;
  }
  return sparks.geometry();
}

/** Cold navigation lights: slow-climbing craft over the city (REFINE), launches, ring traffic and the orbital station (ASCEND). */
function traffic() {
  const sparks = new Sparks(), rand = seeded(402);
  for (let i = 0; i < 14; i++) {
    const phi = i * 360 / 14 + (rand() - .5) * 18, r = 48 + rand() * 50;
    const [x, y, z] = siteOnLand(Math.sin(phi * RAD) * r, Math.cos(phi * RAD) * r, .4);
    sparks.add([x, y + 1.5, z], 2.6 + rand() * .3, .75, .3 + rand() * .3, rand());
  }
  for (let i = 0; i < 6; i++) {
    const [px, pz] = i < 4 ? PORT : [-62, 16];
    const [x, y, z] = siteOnLand(px + (rand() - .5) * 10, pz + (rand() - .5) * 10, .4);
    sparks.add([x, y + 1, z], 3.5 + rand() * .1, 1, .9 + rand() * .7, rand());
  }
  const station = at(148, 250, 48);
  sparks.add(station, 3.55, .9); sparks.add([station[0] + 2.6, station[1] + .6, station[2] - .8], 3.6, .7); sparks.add([station[0] - 1.2, station[1] - 1.4, station[2] + 1.1], 3.65, .6);
  for (const s of [-.85, -.3, .25, .8]) sparks.add(ring(s), 3.6, .5, 0, rand());
  return sparks.geometry();
}

/** A point on the orbital ring arc: azimuth 148° ± 60°, dipping toward the horizon at both ends, r = 320. */
function ring(s: number): Vec3 {
  const e = .055 + .145 * Math.cos(s * 1.12);
  return at(148 + s / RAD, 320 * Math.cos(e), 320 * Math.sin(e));
}

/** Hairline sky elements: dashed launch trajectories arcing up and out of the spaceport, and the thin orbital ring arc. */
function strokes() {
  const lines = new Strokes();
  contrail(lines, PORT, 150, 210, 62, 3.1, 1);
  contrail(lines, PORT, 104, 180, 55, 3.4, 2);
  contrail(lines, [-62, 16], 262, 170, 50, 3.25, 3);
  contrail(lines, [64, 30], 40, 150, 58, 3.55, 4);
  const pts: Vec3[] = [];
  for (let i = 0; i <= 80; i++) pts.push(ring(-1.05 + 2.1 * i / 80));
  dashed(lines, pts, 3.1, i => i % 14 < 8);
  return lines.geometry();
}

/** A launch trajectory from `pad`: vertical off the pad, arcing over toward azimuth `phi`, `reach` out and `top` up; dashed and thinning as it dissipates. */
function contrail(lines: Strokes, pad: readonly [number, number], phi: number, reach: number, top: number, birth: number, variant: number) {
  const [x0, y0, z0] = siteOnLand(pad[0], pad[1], .4);
  const dx = Math.sin(phi * RAD), dz = Math.cos(phi * RAD), bend = 1.3 + variant * .1;
  const pts: Vec3[] = [];
  for (let i = 0; i <= 64; i++) {
    const t = i / 64, h = reach * t ** 2.2, y = y0 + 1.5 + top * (1 - (1 - t) ** 1.8) + Math.sin(t * 9 + variant) * .4 * t;
    pts.push([x0 + dx * h + Math.cos(t * 5 + variant) * bend * t, y, z0 + dz * h + Math.sin(t * 4 + variant) * bend * t]);
  }
  dashed(lines, pts, birth, i => i < 10 ? true : i < 40 ? i % 5 < 3 : i % 7 < 2);
}

/** Polyline → dashed strokes (segment i kept where `on(i)`), aT running 0 → 1 along the whole line so it still draws on end to end. */
function dashed(lines: Strokes, pts: readonly Vec3[], birth: number, on: (i: number) => boolean) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]));
  const total = cum[cum.length - 1] || 1;
  for (let i = 0; i < pts.length - 1; i++) if (on(i)) lines.seg(pts[i], pts[i + 1], birth, cum[i] / total, cum[i + 1] / total);
}

/** Phobos (an irregular potato ~8 u across, 265 u out at 11° elevation) and Deimos (~4 u, 300 u out at 12°): basalt, low-poly, cratered. */
function moons() {
  const solids = new Solids();
  moon(solids, PHOBOS, 4.1, [1.3, .88, 1.02], 1.1, 7, [[.3, .5, .81, .55, .22], [-.7, -.3, .65, .4, .14], [.1, -.9, .4, .3, .1]]);
  moon(solids, DEIMOS, 2, [1.08, .95, 1.1], 2.4, 8, [[-.5, .6, .62, .5, .16], [.8, -.2, .56, .35, .1]]);
  return solids.geometry();
}

/** One moon: icosahedron detail 1 (80 facets), radius jittered by seeded fbm, bowl craters dented in (unit centre, angular radius, depth), stretched into a potato. */
function moon(solids: Solids, centre: Vec3, radius: number, stretch: readonly [number, number, number], turn: number, seed: number, craters: readonly [number, number, number, number, number][]) {
  const g = new THREE.IcosahedronGeometry(1, 1), p = g.getAttribute('position');
  const m = new THREE.Matrix4().makeTranslation(centre[0], centre[1], centre[2]).multiply(new THREE.Matrix4().makeRotationY(turn)).multiply(new THREE.Matrix4().makeRotationX(turn * .6)).multiply(new THREE.Matrix4().makeScale(stretch[0] * radius, stretch[1] * radius, stretch[2] * radius));
  const v = new THREE.Vector3(), c = new THREE.Vector3();
  const shape = (i: number) => {
    v.fromBufferAttribute(p, i).normalize();
    let r = 1 + fbm(v.x * 1.7 + seed, v.y * 1.7, v.z * 1.7 + seed, 2) * .16;
    for (const [cx, cy, cz, rho, depth] of craters) {
      const d = Math.acos(THREE.MathUtils.clamp(v.dot(c.set(cx, cy, cz).normalize()), -1, 1));
      if (d < rho) r -= depth * (Math.cos(d / rho * Math.PI) + 1) * .5; else if (d < rho * 1.35) r += depth * .25 * (1 - (d - rho) / (rho * .35));
    }
    return v.multiplyScalar(r).applyMatrix4(m).toArray() as [number, number, number];
  };
  const rand = seeded(seed * 13);
  for (let i = 0; i < p.count; i += 3) solids.tri(shape(i), shape(i + 1), shape(i + 2), 2.7 + rand() * .8, 0);
  g.dispose();
}

/** Giant landforms 150 … 215 u out, spread around the compass so every yaw has a skyline: a shield volcano, mesas, a crater rim. */
function mesas() {
  const solids = new Solids();
  // Olympus-Mons-like shield: very wide, concave low slope, flat caldera (yaw ~35°, behind the main settlement)
  landform(solids, at(215, 210), [[58, 0], [48, 6], [37, 14], [26, 23], [15, 31], [9, 37], [5, 34]], 24, 21, { jitter: .07, relief: [2, 5], stretch: 1.12, turn: .4 });
  // a flat-topped mesa with a talus skirt (yaw ~95°)
  landform(solids, at(275, 160), [[24, 0], [19, 8], [13, 28], [11, 37]], 16, 22, { stretch: 1.2, turn: 1.1, relief: [2.4, 5] });
  // crater rim: a ring of rampart rising to a crest and dropping into a bowl (yaw ~155°, under Phobos)
  landform(solids, at(335, 190), [[36, 0], [28, 12], [23, 24], [17, 17], [11, 9]], 20, 23, { jitter: .1, relief: [2, 4.2] });
  // a long low ridge-plateau (yaw ~215°)
  landform(solids, at(35, 185), [[31, 0], [25, 12], [18, 27], [14, 33]], 18, 24, { stretch: 2.1, turn: -.5, relief: [2.2, 4.6] });
  // a pair of buttes (yaw ~275°, under Deimos)
  landform(solids, at(95, 170), [[17, 0], [12, 7], [10, 26], [7, 31]], 14, 25, { stretch: 1.2, turn: .3, relief: [2.5, 5] });
  landform(solids, at(106, 195), [[14, 0], [10, 18], [7, 24], [3.5, 28]], 12, 26, { relief: [2.5, 5] });
  // a low broad far mesa (yaw ~335°)
  landform(solids, at(155, 200), [[26, 0], [19, 10], [12, 24], [7, 29]], 14, 27, { stretch: 1.6, turn: -.9, relief: [2.4, 4.8] });
  return solids.geometry();
}

type Ring = readonly [r: number, h: number];
interface LandformOptions { stretch?: number; turn?: number; jitter?: number; relief?: readonly [number, number] }

/**
 * A low-poly landform at (cx, ·, cz) from a profile of rings (radius, height above the local terrain), capped flat; each column of
 * vertices shares a jittered angle and radius scale so the facets line up into vertical ridges. The base ring is sunk 3 u below the
 * terrain under each vertex so no gap shows. `aRelief` runs from relief[0] at the base to relief[1] at the top (basalt → rust).
 */
function landform(solids: Solids, [cx, , cz]: Vec3, rings: readonly Ring[], segs: number, seed: number, { stretch = 1, turn = 0, jitter = .12, relief = [2, 5] }: LandformOptions = {}) {
  const rand = seeded(seed * 101), base = heightAt(cx, cz).y, hMax = Math.max(...rings.map(r => r[1]));
  const angles = Array.from({ length: segs }, (_, i) => (i + (rand() - .5) * .55) / segs * Math.PI * 2);
  const radial = angles.map(() => 1 + (rand() - .5) * jitter * 2);
  const pts = rings.map(([r, h], k) => angles.map((a, i) => {
    const rr = r * radial[i] * (1 + (rand() - .5) * jitter * (k === rings.length - 1 ? .4 : 1));
    const u = Math.cos(a) * rr * stretch, v = Math.sin(a) * rr;
    const x = cx + u * Math.cos(turn) - v * Math.sin(turn), z = cz + u * Math.sin(turn) + v * Math.cos(turn);
    return [x, k === 0 ? heightAt(x, z).y - 3 : base + h * (1 + (rand() - .5) * .07), z] as Vec3;
  }));
  const rel = (h: number) => relief[0] + (relief[1] - relief[0]) * h / hMax;
  const tri = (a: Vec3, b: Vec3, c: Vec3, out: Vec3, re: number) => {
    const n = new THREE.Vector3().crossVectors(new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]), new THREE.Vector3(c[0] - a[0], c[1] - a[1], c[2] - a[2]));
    if (n.x * out[0] + n.y * out[1] + n.z * out[2] < 0) solids.tri(a, c, b, re, 0); else solids.tri(a, b, c, re, 0);
  };
  for (let k = 1; k < rings.length; k++) for (let i = 0; i < segs; i++) {
    const j = (i + 1) % segs, a = pts[k - 1][i], b = pts[k - 1][j], c = pts[k][i], d = pts[k][j], re = rel((rings[k - 1][1] + rings[k][1]) / 2);
    const mid: Vec3 = [(a[0] + d[0]) / 2 - cx, rings[k][1] >= rings[k - 1][1] ? 1 : -1, (a[2] + d[2]) / 2 - cz];
    const out: Vec3 = [mid[0] * Math.abs(mid[1]), Math.hypot(mid[0], mid[2]) * mid[1] * .6, mid[2] * Math.abs(mid[1])];
    if ((i + k) % 2) { tri(a, b, c, out, re); tri(b, d, c, out, re); } else { tri(a, b, d, out, re); tri(a, d, c, out, re); }
  }
  const top = pts[pts.length - 1], centre: Vec3 = [top.reduce((s, p) => s + p[0], 0) / segs, top.reduce((s, p) => s + p[1], 0) / segs, top.reduce((s, p) => s + p[2], 0) / segs];
  for (let i = 0; i < segs; i++) tri(top[i], top[(i + 1) % segs], centre, [0, 1, 0], rel(rings[rings.length - 1][1]));
}
