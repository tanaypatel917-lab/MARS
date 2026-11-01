import * as THREE from 'three';
import { heightAt, isLand, seeded, POOL } from './landscapeTerrain';
import { Strokes, Sparks, Solids, type Vec3 } from './landscapeKit';
import { groundRelief, CRATERS } from './landscapeGroundRelief';

/**
 * The ground's dressing under the /how stele — what makes the plains read as a worked, walked-on surface rather than a
 * height field: boulder fields banked on the crater rims and at the dune feet, tilted strata outcrops on the crests, the
 * scorched landing terraces of the spaceport sites, and the faint marks of use between them — paired rover tracks routed
 * around the pools, dotted footpaths around the habitats, survey stake rows, beacon stakes and runway lights.
 *
 *   solids  → landscape.addSolid(solids)                 boulders, outcrops, pads (aRelief 2 … 5 basalt → rust; pads ≤ POOL, glossy)
 *   strokes → landscape.addStrokes(strokes, 0xece6dc, .18) tracks, footpaths, stake rows, beacon stakes, runway edge strips
 *   lights  → landscape.addSparks(lights, 0xffb27a, 9)    crater-field beacons (birth 0 … 1), pad rim and runway lights (2 … 4)
 *
 * Everything sits on `ground()` = heightAt + groundRelief, so it stays seated once the terrain gets the relief too.
 */
export function buildGround(): { solids: THREE.BufferGeometry; strokes: THREE.BufferGeometry; lights: THREE.BufferGeometry } {
  const solids = new Solids(), strokes = new Strokes(), lights = new Sparks();
  const rand = seeded(2026);
  const fields = boulders(solids, rand);
  outcrops(solids, rand);
  for (const p of PADS) pad(solids, p);
  tracks(strokes, fields, rand);
  footpaths(strokes, rand);
  stakes(strokes, rand);
  beacons(strokes, lights, rand);
  runways(strokes, lights, rand);
  return { solids: solids.geometry(), strokes: strokes.geometry(), lights: lights.geometry() };
}

/** Ground height with the fine relief. NOTE for wiring: once `heightAt` adds groundRelief itself, drop the second term. */
const ground = (x: number, z: number) => heightAt(x, z).y + groundRelief(x, z);
const groundNormal = (x: number, z: number, e = .5) => new THREE.Vector3(ground(x - e, z) - ground(x + e, z), 2 * e, ground(x, z - e) - ground(x, z + e)).normalize();
const UP = new THREE.Vector3(0, 1, 0), TAU = Math.PI * 2;
const hash3 = (x: number, y: number, z: number) => { const h = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453; return h - Math.floor(h); };
type Site = { x: number; z: number; birth: number };

/** Spaceport terraces: [x, z, radius, birth]. The stage-0 lander pad, two settlement pads, two launch pads. */
const PADS: readonly (readonly [number, number, number, number])[] = [[20, -50, 4.5, 0], [11, -62, 6, 2], [-54, -4, 5.5, 2], [-22, 68, 5.5, 2], [30, 74, 7, 4], [-70, -90, 7, 4]];
/** Habitat sites (x, z, dome radius, birth) the footpaths gather around — the colony module's dome sites inside the detail band. */
const HABITATS: readonly (readonly [number, number, number, number])[] = [[-38, -52, 6, 1], [-30, -58, 4, 2], [-46, -47, 3.2, 2], [52, -40, 5, 1], [20, -70, 7, 2], [-60, 20, 4.5, 2], [26, -22, 2.4, 0], [-24, 28, 2.8, 1], [34, 18, 2.2, 2], [-30, -26, 3, 1], [14, -34, 2.6, 0], [40, 2, 2.2, 2], [-36, 6, 2.4, 1], [6, 40, 2.8, 2], [-14, -40, 2, 1]];
/** Stage at which a crater field is reached: the nearest is the arrival site, the inner ring is surveyed at 1, the rest at 2. */
const craterBirth = (i: number) => i === 0 ? 0 : Math.hypot(CRATERS[i][0], CRATERS[i][1]) < 80 ? 1 : 2;
const nearPad = (x: number, z: number, extra = 3) => PADS.some(p => Math.hypot(x - p[0], z - p[1]) < p[2] * 1.3 + extra);

// ─── solids ───────────────────────────────────────────────────────────────────────────────────────────────────────────

const ICO = new THREE.IcosahedronGeometry(1, 0), DODE = new THREE.DodecahedronGeometry(1, 0);

/** A low-poly boulder: a jittered icosahedron / dodecahedron, squashed, seated on the ground and tilted with it. */
function boulder(solids: Solids, x: number, z: number, size: number, seed: number, relief: number, birth: number, rand: () => number) {
  const kind = rand() < .62 ? ICO : DODE;
  const sx = size * (.8 + rand() * .4), sz = size * (.8 + rand() * .4), sy = size * (.55 + rand() * .4);
  const q = new THREE.Quaternion().setFromUnitVectors(UP, groundNormal(x, z)).multiply(new THREE.Quaternion().setFromAxisAngle(UP, rand() * TAU));
  const m = new THREE.Matrix4().compose(new THREE.Vector3(x, ground(x, z) + sy - .2, z), q, new THREE.Vector3(sx, sy, sz));
  const p = kind.getAttribute('position'), v = new THREE.Vector3(), out: Vec3[] = [];
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    v.multiplyScalar(.74 + .5 * hash3(Math.round(v.x * 40), Math.round(v.y * 40), Math.round(v.z * 40) + seed)).applyMatrix4(m);
    out.push([v.x, v.y, v.z]);
  }
  for (let i = 0; i < out.length; i += 3) solids.tri(out[i], out[i + 1], out[i + 2], relief, birth);
}

/** ~250 boulders banked on the crater rims and aprons, and strewn at the dune feet near the pool shores. */
function boulders(solids: Solids, rand: () => number): Site[] {
  let n = 0, seed = 0;
  const place = (x: number, z: number, size: number, birth: number, margin: number) => {
    if (Math.hypot(x, z) < 24 || !isLand(x, z, margin) || nearPad(x, z, 1)) return;
    boulder(solids, x, z, size, ++seed, 2 + rand() * 3, birth, rand); n++;
  };
  for (const c of CRATERS) {
    const count = Math.round(7 + c[2] * .75);
    for (let k = 0; k < count; k++) {
      const a = rand() * TAU, d = c[2] * (1.04 + Math.pow(rand(), 1.6) * .6);
      place(c[0] + Math.cos(a) * d, c[1] + Math.sin(a) * d, .4 + 2.6 * Math.pow(rand(), 2.4) * (d < c[2] * 1.25 ? 1 : .6), 0, .3);
    }
  }
  const fields: Site[] = [];
  for (let tries = 0; tries < 4000 && fields.length < 16; tries++) {
    const a = rand() * TAU, r = 28 + Math.sqrt(rand()) * 108, x = Math.cos(a) * r, z = Math.sin(a) * r;
    const h = heightAt(x, z);
    if (h.relief < POOL + .5 || h.relief > POOL + 1.9 || nearPad(x, z, 6)) continue;
    if (fields.some(f => Math.hypot(f.x - x, f.z - z) < 22) || CRATERS.some(c => Math.hypot(c[0] - x, c[1] - z) < c[2] * 1.8 + 4)) continue;
    fields.push({ x, z, birth: r < 70 ? 1 : 2 });
    const count = 6 + Math.floor(rand() * 7);
    for (let k = 0; k < count; k++) {
      const b = rand() * TAU, d = Math.pow(rand(), .7) * 6.5;
      place(x + Math.cos(b) * d, z + Math.sin(b) * d, .4 + 2.2 * Math.pow(rand(), 2.6), 0, .22);
    }
  }
  while (n < 250) {
    const a = rand() * TAU, r = 26 + Math.sqrt(rand()) * 110;
    place(Math.cos(a) * r, Math.sin(a) * r, .4 + 1.6 * Math.pow(rand(), 2.2), 0, .4);
  }
  return fields;
}

/** Bake a convex piece (CCW faces, quads or triangles) through a matrix. */
function piece(solids: Solids, verts: Vec3[], faces: number[][], m: THREE.Matrix4, relief: number, birth: number) {
  const w = verts.map(p => { const v = new THREE.Vector3(...p).applyMatrix4(m); return [v.x, v.y, v.z] as Vec3; });
  for (const f of faces) for (let i = 1; i + 1 < f.length; i++) solids.tri(w[f[0]], w[f[i]], w[f[i + 1]], relief, birth);
}
const BOX: Vec3[] = [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1], [-1, 1, -1], [1, 1, -1], [1, 1, 1], [-1, 1, 1]];
const BOX_FACES = [[0, 1, 2, 3], [4, 7, 6, 5], [3, 2, 6, 7], [1, 0, 4, 5], [2, 1, 5, 6], [0, 3, 7, 4]];
const WEDGE: Vec3[] = [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1], [-.3, 1, -1], [-.3, 1, 1]];
const WEDGE_FACES = [[0, 1, 2, 3], [1, 0, 4], [3, 2, 5], [2, 1, 4, 5], [0, 3, 5, 4]];

/** 15 … 25 strata outcrops on the crests: two or three tilted slabs and a wedge, dipping the same way, half buried. */
function outcrops(solids: Solids, rand: () => number) {
  const placed: [number, number][] = [];
  for (let tries = 0; tries < 6000 && placed.length < 22; tries++) {
    const a = rand() * TAU, r = 30 + Math.sqrt(rand()) * 108, x = Math.cos(a) * r, z = Math.sin(a) * r;
    if (heightAt(x, z).relief < 4.6 || nearPad(x, z, 8) || placed.some(p => Math.hypot(p[0] - x, p[1] - z) < 16)) continue;
    if (CRATERS.some(c => Math.hypot(c[0] - x, c[1] - z) < c[2] * 1.3)) continue;
    placed.push([x, z]);
    const yaw = rand() * TAU, dip = .22 + rand() * .42, L = 3 + rand() * 5, relief = 1.3 + rand() * 1.4;
    const base = new THREE.Quaternion().setFromUnitVectors(UP, groundNormal(x, z, 1.2)).multiply(new THREE.Quaternion().setFromAxisAngle(UP, yaw));
    const dir = new THREE.Vector3(0, 0, 1).applyQuaternion(base), along = new THREE.Vector3(1, 0, 0).applyQuaternion(base);
    const pieces = 2 + (rand() < .55 ? 1 : 0);
    let off = -(pieces - 1) * .5;
    for (let k = 0; k < pieces; k++, off += 1) {
      const len = L * (k === 0 ? 1 : .55 + rand() * .35), T = .25 + len * .06 + rand() * .2, W = .7 + rand() * .9;
      const shift = dir.clone().multiplyScalar(off * W * 2.2).addScaledVector(along, (rand() - .5) * len * .3);
      const px = x + shift.x, pz = z + shift.z;
      const q = base.clone().multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), dip + (rand() - .5) * .14));
      const m = new THREE.Matrix4().compose(new THREE.Vector3(px, ground(px, pz) + T * .4 + len * .5 * Math.sin(dip) * .35, pz), q, new THREE.Vector3(len * .5, T, W));
      if (k === pieces - 1 && pieces === 3) piece(solids, WEDGE, WEDGE_FACES, m, relief, 0); else piece(solids, BOX, BOX_FACES, m, relief, 0);
    }
  }
}

/** A scorched landing terrace: a flat glossy 12-gon levelled at the high side of its footprint, on a dark rubble skirt. */
function pad(solids: Solids, [x, z, R, birth]: readonly [number, number, number, number]) {
  const top: Vec3[] = [], foot: Vec3[] = [];
  let y = ground(x, z);
  for (let i = 0; i < 12; i++) { const a = i / 12 * TAU; for (const k of [.5, 1]) y = Math.max(y, ground(x + Math.cos(a) * R * k, z + Math.sin(a) * R * k)); }
  y += .15;
  for (let i = 0; i < 12; i++) {
    const a = i / 12 * TAU, c = Math.cos(a), s = Math.sin(a);
    top.push([x + c * R, y, z + s * R]);
    foot.push([x + c * R * 1.18, ground(x + c * R * 1.18, z + s * R * 1.18) - .7, z + s * R * 1.18]);
  }
  for (let i = 0; i < 12; i++) {
    const j = (i + 1) % 12;
    solids.tri([x, y, z], top[j], top[i], .5, birth);
    solids.tri(top[i], top[j], foot[j], 2.2, birth); solids.tri(top[i], foot[j], foot[i], 2.2, birth);
  }
}

// ─── strokes ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Marches from a to b in 1.2 u steps, steering around the pools (probing ahead in widening angles); null if it gets stuck. */
function route(ax: number, az: number, bx: number, bz: number, margin = .35): [number, number][] | null {
  const pts: [number, number][] = [[ax, az]];
  let x = ax, z = az, hx = bx - ax, hz = bz - az; { const l = Math.hypot(hx, hz) || 1; hx /= l; hz /= l; }
  for (let step = 0; step < 220; step++) {
    const dx = bx - x, dz = bz - z, d = Math.hypot(dx, dz);
    if (d < 1.5) { pts.push([bx, bz]); return pts; }
    const wx = dx / d, wz = dz / d;
    let found = false;
    for (const turn of [0, .3, -.3, .6, -.6, .95, -.95, 1.35, -1.35, 1.8, -1.8, 2.3, -2.3]) {
      const c = Math.cos(turn), s = Math.sin(turn), tx = wx * c - wz * s, tz = wx * s + wz * c;
      if (tx * hx + tz * hz < -.2) continue;
      if (isLand(x + tx * 1.3, z + tz * 1.3, margin) && isLand(x + tx * 3, z + tz * 3, margin) && (d < 6 || isLand(x + tx * 6, z + tz * 6, margin * .6))) {
        hx = hx * .45 + tx * .55; hz = hz * .45 + tz * .55; const l = Math.hypot(hx, hz); hx /= l; hz /= l; found = true; break;
      }
    }
    if (!found) return null;
    x += hx * 1.2; z += hz * 1.2; pts.push([x, z]);
  }
  return null;
}

/** Relaxes a polyline (keeping its ends) and adds a gentle lateral wobble. */
function relax(pts: [number, number][], wobble: number, phase: number) {
  let p = pts;
  for (let pass = 0; pass < 2; pass++) p = p.map((q, i) => i === 0 || i === p.length - 1 ? q : [(p[i - 1][0] + q[0] * 2 + p[i + 1][0]) / 4, (p[i - 1][1] + q[1] * 2 + p[i + 1][1]) / 4]);
  return p.map((q, i) => {
    if (i === 0 || i === p.length - 1) return q;
    const nx = p[i + 1][1] - p[i - 1][1], nz = -(p[i + 1][0] - p[i - 1][0]), l = Math.hypot(nx, nz) || 1, w = Math.sin(i * .7 + phase) * wobble;
    return [q[0] + nx / l * w, q[1] + nz / l * w] as [number, number];
  });
}

/** A pair of tyre tracks .9 u apart along a routed centreline, hugging the ground. */
function tyreTracks(strokes: Strokes, centre: [number, number][], birth: number) {
  const left: Vec3[] = [], right: Vec3[] = [];
  for (let i = 0; i < centre.length; i++) {
    const a = centre[Math.max(0, i - 1)], b = centre[Math.min(centre.length - 1, i + 1)];
    const nx = b[1] - a[1], nz = -(b[0] - a[0]), l = Math.hypot(nx, nz) || 1;
    const [x, z] = centre[i];
    const lx = x + nx / l * .45, lz = z + nz / l * .45, rx = x - nx / l * .45, rz = z - nz / l * .45;
    left.push([lx, ground(lx, lz) + .08, lz]); right.push([rx, ground(rx, rz) + .08, rz]);
  }
  strokes.poly(left, birth); strokes.poly(right, birth + .04);
}

/** Rover track network: the survey loop at 0, the inner crater fields at 1, pads, far fields and dune-foot fields at 2. */
function tracks(strokes: Strokes, fields: Site[], rand: () => number) {
  const nodes: Site[] = [{ x: PADS[0][0], z: PADS[0][1], birth: 0 }];
  const rimPoint = (i: number, toward: [number, number]): [number, number] => {
    const c = CRATERS[i], a = Math.atan2(toward[1] - c[1], toward[0] - c[0]);
    return [c[0] + Math.cos(a) * c[2] * 1.45, c[1] + Math.sin(a) * c[2] * 1.45];
  };
  const connect = (a: Site, b: Site, birth: number, wobble = .3) => {
    const r = route(a.x, a.z, b.x, b.z); if (!r) return false;
    tyreTracks(strokes, relax(r, wobble, rand() * 6), birth); return true;
  };
  // survey loop: pad → crater rim → around the rim → back
  const hub = nodes[0], c0 = CRATERS[0];
  const p1 = rimPoint(0, [hub.x, hub.z]), a1 = Math.atan2(p1[1] - c0[1], p1[0] - c0[0]), a2 = a1 + 2.2;
  const p2: [number, number] = [c0[0] + Math.cos(a2) * c0[2] * 1.5, c0[1] + Math.sin(a2) * c0[2] * 1.5];
  const rim: [number, number][] = []; for (let k = 0; k <= 10; k++) { const a = a1 + (a2 - a1) * k / 10; rim.push([c0[0] + Math.cos(a) * c0[2] * (1.45 + Math.sin(k) * .08), c0[1] + Math.sin(a) * c0[2] * (1.45 + Math.sin(k) * .08)]); }
  const s1: Site = { x: p1[0], z: p1[1], birth: 0 }, s2: Site = { x: p2[0], z: p2[1], birth: 0 };
  connect(hub, s1, 0); tyreTracks(strokes, relax(rim, .15, 1), .12); connect(s2, hub, .22, .4);
  nodes.push(s1, s2);
  // later fields: each new site links to the nearest earlier node, a few get a second link for loops
  const later: Site[] = [];
  CRATERS.forEach((_, i) => { if (i === 0) return; const p = rimPoint(i, [0, 0]); later.push({ x: p[0], z: p[1], birth: craterBirth(i) }); });
  for (const p of PADS.slice(1)) later.push({ x: p[0], z: p[1] + p[2] * 1.25, birth: Math.min(2, p[3]) });
  for (const f of fields) later.push(f);
  later.sort((a, b) => a.birth - b.birth || Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z));
  for (const s of later) {
    const byDist = nodes.map(n => ({ n, d: Math.hypot(n.x - s.x, n.z - s.z) })).sort((a, b) => a.d - b.d);
    let linked = 0;
    for (const { n, d } of byDist) {
      if (d > 95 || linked >= (s.birth >= 2 && rand() < .4 ? 2 : 1)) break;
      if (connect(n, s, s.birth + rand() * .5)) linked++;
    }
    if (linked) nodes.push(s);
  }
}

/** A dotted hairline along a polyline (dash .45 u, gap .55 u) hugging the ground. */
function dotted(strokes: Strokes, pts: [number, number][], birth: number, lift = .08) {
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    const [ax, az] = pts[i - 1], [bx, bz] = pts[i], len = Math.hypot(bx - ax, bz - az);
    for (let s = carry; s < len; s += 1) {
      const e = Math.min(len, s + .45), t0 = s / len, t1 = e / len;
      const x0 = ax + (bx - ax) * t0, z0 = az + (bz - az) * t0, x1 = ax + (bx - ax) * t1, z1 = az + (bz - az) * t1;
      strokes.seg([x0, ground(x0, z0) + lift, z0], [x1, ground(x1, z1) + lift, z1], birth, 0, 1);
      carry = s + 1 - len;
    }
    if (carry < 0) carry = 0;
  }
}

/** Dotted footpaths: a loop around each habitat and dotted links between neighbouring habitats, worn in at 2 … 3. */
function footpaths(strokes: Strokes, rand: () => number) {
  const sites = HABITATS.filter(h => Math.hypot(h[0], h[1]) > 24).map(h => { const [x, z] = [h[0], h[1]]; return { x, z, r: h[2], birth: h[3] }; });
  for (const s of sites) {
    const loop: [number, number][] = [], R = s.r + 1.6, n = Math.max(12, Math.round(R * 2.2));
    for (let k = 0; k <= n; k++) { const a = k / n * TAU; loop.push([s.x + Math.cos(a) * R * (1 + Math.sin(k * 1.7) * .05), s.z + Math.sin(a) * R * (1 + Math.cos(k * 2.3) * .05)]); }
    dotted(strokes, loop.filter(p => isLand(p[0], p[1], .15)), 2 + rand() * .9);
  }
  for (let i = 0; i < sites.length; i++) for (let j = i + 1; j < sites.length; j++) {
    const a = sites[i], b = sites[j], d = Math.hypot(a.x - b.x, a.z - b.z);
    if (d > 17) continue;
    const ux = (b.x - a.x) / d, uz = (b.z - a.z) / d;
    const r = route(a.x + ux * (a.r + 1.6), a.z + uz * (a.r + 1.6), b.x - ux * (b.r + 1.6), b.z - uz * (b.r + 1.6), .2);
    if (r) dotted(strokes, relax(r, .2, rand() * 6), 2.2 + rand() * .8);
  }
}

/** Survey stake rows: .4 u ticks every 3 u along a line (every fifth a little taller), at 0 near the arrival site, 1 at the inner fields. */
function stakes(strokes: Strokes, rand: () => number) {
  const row = (x0: number, z0: number, x1: number, z1: number, birth: number) => {
    const len = Math.hypot(x1 - x0, z1 - z0), n = Math.floor(len / 3);
    for (let k = 0; k <= n; k++) {
      const t = k * 3 / len, x = x0 + (x1 - x0) * t, z = z0 + (z1 - z0) * t;
      if (!isLand(x, z, .15) || Math.hypot(x, z) < 22) continue;
      const y = ground(x, z), h = k % 5 === 0 ? .8 : .4;
      strokes.seg([x, y, z], [x, y + h, z], birth + k / Math.max(1, n) * .25);
    }
  };
  const hub = PADS[0];
  row(hub[0] + 6, hub[1] - 2, hub[0] + 6, hub[1] + 22, 0);
  row(hub[0] - 8, hub[1] + 4, hub[0] + 18, hub[1] + 4, .1);
  row(CRATERS[0][0] - 12, CRATERS[0][1] + 10, CRATERS[0][0] + 12, CRATERS[0][1] + 10, .3);
  CRATERS.forEach((c, i) => {
    if (i === 0 || craterBirth(i) > 1) return;
    const a = rand() * TAU, d = c[2] * 1.7, L = 9 + c[2] * 1.2;
    const cx = c[0] + Math.cos(a) * d, cz = c[1] + Math.sin(a) * d, tx = -Math.sin(a), tz = Math.cos(a);
    row(cx - tx * L, cz - tz * L, cx + tx * L, cz + tz * L, .6 + rand() * .4);
  });
}

/** Beacon stakes at the crater fields: a 3 … 4.5 u mast on the rim facing the stele, a warm light on top; big craters get two. */
function beacons(strokes: Strokes, lights: Sparks, rand: () => number) {
  CRATERS.forEach((c, i) => {
    const birth = Math.min(1, craterBirth(i)) * .8 + rand() * .2;
    const count = c[2] >= 9 ? 2 : 1;
    for (let k = 0; k < count; k++) {
      const a = Math.atan2(-c[1], -c[0]) + (k ? Math.PI * .8 : -.35) + (rand() - .5) * .5, d = c[2] * (1.3 + k * .15);
      const x = c[0] + Math.cos(a) * d, z = c[1] + Math.sin(a) * d;
      if (!isLand(x, z, .2)) continue;
      const y = ground(x, z), h = 3 + rand() * 1.5;
      strokes.seg([x, y, z], [x, y + h, z], birth);
      strokes.seg([x - .25, y + h - .6, z], [x + .25, y + h - .6, z], birth + .05);
      lights.add([x, y + h + .05, z], birth + .1, 1.3);
    }
  });
}

/** Pad rim lights (12 around each terrace) and runway edge lights in two rows along the approach strip, with hairline edge strips. */
function runways(strokes: Strokes, lights: Sparks, rand: () => number) {
  for (const [x, z, R, birth] of PADS) {
    const lb = birth === 0 ? .7 : birth === 2 ? 2.3 : 3.55;
    let y = ground(x, z);
    for (let i = 0; i < 12; i++) { const a = i / 12 * TAU; for (const k of [.5, 1]) y = Math.max(y, ground(x + Math.cos(a) * R * k, z + Math.sin(a) * R * k)); }
    for (let i = 0; i < 12; i++) { const a = (i + .5) / 12 * TAU; lights.add([x + Math.cos(a) * R * .96, y + .3, z + Math.sin(a) * R * .96], lb + i / 12 * .3, .55); }
    if (birth === 0) continue;
    // approach strip: the direction out of the pad with the least climb that stays on land
    let best: { a: number; len: number; cost: number } | null = null;
    for (let k = 0; k < 24; k++) {
      const a = k / 24 * TAU, c = Math.cos(a), s = Math.sin(a);
      let len = 0, cost = 0;
      for (let d = R * 1.3; d <= R * 1.3 + 27; d += 3) {
        if (!isLand(x + c * d, z + s * d, .3) || !isLand(x + c * d - s * 2.2, z + s * d + c * 2.2, .25) || !isLand(x + c * d + s * 2.2, z + s * d - c * 2.2, .25)) break;
        cost += Math.abs(ground(x + c * d, z + s * d) - ground(x + c * (d - 3), z + s * (d - 3))); len = d;
      }
      if (len < R * 1.3 + 12) continue;
      const score = cost / len - len * .01 + rand() * .02;
      if (!best || score < best.cost) best = { a, len, cost: score };
    }
    if (!best) continue;
    const c = Math.cos(best.a), s = Math.sin(best.a), edges: [Vec3[], Vec3[]] = [[], []];
    let i = 0;
    for (let d = R * 1.3; d <= best.len; d += 3, i++) {
      for (const side of [-1, 1]) {
        const px = x + c * d - s * 2.2 * side, pz = z + s * d + c * 2.2 * side, py = ground(px, pz);
        lights.add([px, py + .25, pz], lb + .25 + (1 - d / best.len) * .45, .6 + (i % 3 === 0 ? .25 : 0));
        edges[side > 0 ? 1 : 0].push([px, py + .07, pz]);
      }
    }
    strokes.poly(edges[0], lb + .2); strokes.poly(edges[1], lb + .24);
    const ex = x + c * best.len, ez = z + s * best.len;
    strokes.seg([ex - s * 2.2, ground(ex - s * 2.2, ez + c * 2.2) + .07, ez + c * 2.2], [ex + s * 2.2, ground(ex + s * 2.2, ez - c * 2.2) + .07, ez - c * 2.2], lb + .6);
  }
}
