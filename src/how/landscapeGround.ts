import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { fbm } from '../geometry';
import { noise } from '../shaders';
import { heightAt, isLand, seeded, POOL, BASE, FOG_K, FOG_SCALE_HEIGHT, HORIZON } from './landscapeTerrain';
import { Strokes, Sparks, Solids, type Vec3 } from './landscapeKit';
import { skyChunk } from './landscapeShaders';
import { FOG } from './landscape';
import { CRATERS } from './landscapeGroundRelief';

/**
 * The ground's dressing under the /how stele — what makes the plains read as a worked, walked-on surface rather than a
 * height field: boulder fields banked on the crater rims and at the dune feet, tilted strata outcrops on the crests, the
 * scorched landing terraces of the spaceport sites, and the faint marks of use between them — paired rover tracks routed
 * around the pools, dotted footpaths around the habitats, survey stake rows, beacon stakes and runway lights.
 *
 *   rocks   → scene.add(rocks); updateRocks(rocks, t, camera, key, landscape.fog, landscape.stage) each frame after landscape.update
 *              ~250 boulders + ~22 strata outcrops as smooth facetted stones (the hero bodies' shard construction) with their own
 *              beauty-pass shader (per-pixel basalt relief, basalt → rust by aRelief, dust on top, fogged like the terrain)
 *   solids  → landscape.addSolid(solids)                 the scorched landing pads (flat 12-gons, aRelief ≤ POOL so they read glossy)
 *   strokes → landscape.addStrokes(strokes, 0xece6dc, .18) tracks, footpaths, stake rows, beacon stakes, runway edge strips
 *   lights  → landscape.addSparks(lights, 0xffb27a, 9)    crater-field beacons (birth 0 … 1), pad rim and runway lights (2 … 4)
 *
 * Everything sits on `ground()` = heightAt + groundRelief, so it stays seated once the terrain gets the relief too.
 */
export function buildGround(): { solids: THREE.BufferGeometry; strokes: THREE.BufferGeometry; lights: THREE.BufferGeometry; rocks: THREE.Mesh } {
  const solids = new Solids(), strokes = new Strokes(), lights = new Sparks(), rocks = new Rocks();
  const rand = seeded(2026);
  const fields = boulders(rocks, rand);
  outcrops(rocks, rand);
  for (const p of PADS) pad(solids, p);
  tracks(strokes, fields, rand);
  footpaths(strokes, rand);
  stakes(strokes, rand);
  beacons(strokes, lights, rand);
  runways(strokes, lights, rand);
  const mesh = new THREE.Mesh(rocks.geometry(), rockMaterial()); mesh.frustumCulled = false;
  return { solids: solids.geometry(), strokes: strokes.geometry(), lights: lights.geometry(), rocks: mesh };
}

/** Ground height with the fine relief. NOTE for wiring: once `heightAt` adds groundRelief itself, drop the second term. */
const ground = (x: number, z: number) => heightAt(x, z).y;
const groundNormal = (x: number, z: number, e = .5) => new THREE.Vector3(ground(x - e, z) - ground(x + e, z), 2 * e, ground(x, z - e) - ground(x, z + e)).normalize();
const UP = new THREE.Vector3(0, 1, 0), TAU = Math.PI * 2;
type Site = { x: number; z: number; birth: number };

/** Spaceport terraces: [x, z, radius, birth]. The stage-0 lander pad, two settlement pads, two launch pads. */
const PADS: readonly (readonly [number, number, number, number])[] = [[20, -50, 4.5, 0], [11, -62, 6, 2], [-54, -4, 5.5, 2], [-22, 68, 5.5, 2], [30, 74, 7, 4], [-70, -90, 7, 4]];
/** Habitat sites (x, z, dome radius, birth) the footpaths gather around — the colony module's dome sites inside the detail band. */
const HABITATS: readonly (readonly [number, number, number, number])[] = [[-38, -52, 6, 1], [-30, -58, 4, 2], [-46, -47, 3.2, 2], [52, -40, 5, 1], [20, -70, 7, 2], [-60, 20, 4.5, 2], [26, -22, 2.4, 0], [-24, 28, 2.8, 1], [34, 18, 2.2, 2], [-30, -26, 3, 1], [14, -34, 2.6, 0], [40, 2, 2.2, 2], [-36, 6, 2.4, 1], [6, 40, 2.8, 2], [-14, -40, 2, 1]];
/** Stage at which a crater field is reached: the nearest is the arrival site, the inner ring is surveyed at 1, the rest at 2. */
const craterBirth = (i: number) => i === 0 ? 0 : Math.hypot(CRATERS[i][0], CRATERS[i][1]) < 80 ? 1 : 2;
const nearPad = (x: number, z: number, extra = 3) => PADS.some(p => Math.hypot(x - p[0], z - p[1]) < p[2] * 1.3 + extra);

// ─── rocks ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Rocks are built the way the hero bodies are (src/geometry.ts shardPoint): a tessellated sphere remapped radially onto the
 * intersection of random half-spaces (large flat facets, sharp ridges), the underside worn back toward a rounded form, fbm
 * wear on top, smooth normals pulled toward the owning facet so the ridges stay crisp. The shader then adds per-pixel
 * basalt relief (bump from the same noise family as the planet's bake) and lights it like the planet's beauty pass.
 */
function rockShape(detail: number, rand: () => number) {
  const g = mergeVertices(new THREE.IcosahedronGeometry(1, detail), 1e-5);
  const facets: { n: THREE.Vector3; d: number }[] = [];
  for (let k = 8 + Math.floor(rand() * 6); k > 0; k--) {
    const u = rand() * 2 - 1, a = rand() * TAU, s = Math.sqrt(1 - u * u);
    facets.push({ n: new THREE.Vector3(s * Math.cos(a), u, s * Math.sin(a)), d: .72 + rand() * .26 });
  }
  const stretch = new THREE.Vector3(1 + rand() * .5, .62 + rand() * .3, .85 + rand() * .3), salt = rand() * 100;
  const pos = g.attributes.position as THREE.BufferAttribute, owners: THREE.Vector3[] = [], worns: number[] = [];
  const dir = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    dir.fromBufferAttribute(pos, i).normalize();
    let r = 1.3, best: THREE.Vector3 | undefined;
    for (const f of facets) { const k = dir.dot(f.n); if (k > 1e-3) { const t = f.d / k; if (t < r) { r = t; best = f.n; } } }
    r = Math.min(r, 1.2);
    const worn = fade(THREE.MathUtils.clamp((-.1 - dir.y) / .6, 0, 1));
    r = THREE.MathUtils.lerp(r, .88, worn * .6);
    r *= 1 + fbm(dir.x * 2.2 + salt, dir.y * 2.2, dir.z * 2.2, 3) * .05 + fbm(dir.x * 7 + salt, dir.y * 7, dir.z * 7, 2) * .012;
    pos.setXYZ(i, dir.x * r * stretch.x, dir.y * r * stretch.y, dir.z * r * stretch.z);
    owners.push(best ?? dir.clone()); worns.push(worn);
  }
  g.computeVertexNormals();
  const nor = g.attributes.normal as THREE.BufferAttribute, n = new THREE.Vector3(), f = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    n.fromBufferAttribute(nor, i); f.copy(owners[i]).divide(stretch).normalize();
    n.lerp(f, .45 * (1 - worns[i])).normalize(); nor.setXYZ(i, n.x, n.y, n.z);
  }
  return g;
}
const fade = (t: number) => t * t * (3 - 2 * t);

/** Collects placed rocks into one indexed geometry: smooth normals, the rock-local frame for the shader's bump, tint, birth. */
class Rocks {
  private readonly pos: number[] = []; private readonly nor: number[] = []; private readonly loc: number[] = []; private readonly seed: number[] = [];
  private readonly relief: number[] = []; private readonly birth: number[] = []; private readonly index: number[] = [];
  tris = 0; count = 0;
  add(detail: number, center: THREE.Vector3, q: THREE.Quaternion, scale: THREE.Vector3, relief: number, birth: number, rand: () => number) {
    const g = rockShape(detail, rand), seed = rand() * 10;
    const m = new THREE.Matrix4().compose(center, q, scale), nm = new THREE.Matrix3().getNormalMatrix(m);
    const p = g.attributes.position as THREE.BufferAttribute, n = g.attributes.normal as THREE.BufferAttribute, idx = g.index!;
    const base = this.pos.length / 3, size = Math.max(scale.x, scale.y, scale.z), v = new THREE.Vector3(), w = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).applyMatrix4(m); this.pos.push(v.x, v.y, v.z);
      this.loc.push((v.x - center.x) / size, (v.y - center.y) / size, (v.z - center.z) / size);
      w.fromBufferAttribute(n, i).applyMatrix3(nm).normalize(); this.nor.push(w.x, w.y, w.z);
      this.seed.push(seed); this.relief.push(relief); this.birth.push(birth);
    }
    for (let i = 0; i < idx.count; i++) this.index.push(idx.getX(i) + base);
    this.tris += idx.count / 3; this.count++; g.dispose();
  }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('aLocal', new THREE.Float32BufferAttribute(this.loc, 3));
    g.setAttribute('aSeed', new THREE.Float32BufferAttribute(this.seed, 1));
    g.setAttribute('aRelief', new THREE.Float32BufferAttribute(this.relief, 1));
    g.setAttribute('aBirth', new THREE.Float32BufferAttribute(this.birth, 1));
    g.setIndex(this.index);
    return g;
  }
}

/** Tessellation by size (three 0.180 icosahedron detail is linear: 20·(d+1)² tris): small rubble 80 tris, big rocks and outcrops 320. */
const detailFor = (size: number) => size < 1.3 ? 1 : size < 2.4 ? 2 : 3;

/** A boulder, half buried, seated on the ground and tilted with it; the long axis turned at random. */
function boulder(rocks: Rocks, x: number, z: number, size: number, relief: number, birth: number, rand: () => number) {
  const scale = new THREE.Vector3(size * (.8 + rand() * .4), size * (.55 + rand() * .4), size * (.8 + rand() * .4));
  const q = new THREE.Quaternion().setFromUnitVectors(UP, groundNormal(x, z)).multiply(new THREE.Quaternion().setFromAxisAngle(UP, rand() * TAU))
    .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), (rand() - .5) * .5));
  rocks.add(detailFor(size), new THREE.Vector3(x, ground(x, z) - .2 + scale.y * .6, z), q, scale, relief, birth, rand);
}

/** ~250 boulders banked on the crater rims and aprons, and strewn at the dune feet near the pool shores. */
function boulders(rocks: Rocks, rand: () => number): Site[] {
  let n = 0;
  const place = (x: number, z: number, size: number, birth: number, margin: number) => {
    if (Math.hypot(x, z) < 24 || !isLand(x, z, margin) || nearPad(x, z, 1)) return;
    boulder(rocks, x, z, size, 2 + rand() * 3, birth, rand); n++;
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

/** 15 … 25 strata outcrops on the crests: one or two long tilted slabs dipping the same way, half buried, plus a shoulder stone. */
function outcrops(rocks: Rocks, rand: () => number) {
  const placed: [number, number][] = [];
  for (let tries = 0; tries < 6000 && placed.length < 22; tries++) {
    const a = rand() * TAU, r = 30 + Math.sqrt(rand()) * 108, x = Math.cos(a) * r, z = Math.sin(a) * r;
    if (heightAt(x, z).relief < 4.6 || nearPad(x, z, 8) || placed.some(p => Math.hypot(p[0] - x, p[1] - z) < 16)) continue;
    if (CRATERS.some(c => Math.hypot(c[0] - x, c[1] - z) < c[2] * 1.3)) continue;
    placed.push([x, z]);
    const yaw = rand() * TAU, dip = .25 + rand() * .4, L = 3 + rand() * 5, relief = 1.3 + rand() * 1.4;
    const base = new THREE.Quaternion().setFromUnitVectors(UP, groundNormal(x, z, 1.2)).multiply(new THREE.Quaternion().setFromAxisAngle(UP, yaw));
    const dir = new THREE.Vector3(0, 0, 1).applyQuaternion(base);
    const slabs = 1 + (rand() < .6 ? 1 : 0);
    for (let k = 0; k < slabs; k++) {
      const len = L * (k === 0 ? 1 : .55 + rand() * .35), T = .35 + len * .07 + rand() * .25, W = .8 + rand() * 1;
      const shift = dir.clone().multiplyScalar((k - (slabs - 1) * .5) * W * 2.4);
      const px = x + shift.x, pz = z + shift.z;
      const q = base.clone().multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), dip + (rand() - .5) * .14));
      rocks.add(3, new THREE.Vector3(px, ground(px, pz) + T * .3 + len * .5 * Math.sin(dip) * .3, pz), q, new THREE.Vector3(len * .5, T, W), relief, 0, rand);
    }
    const sx = x - dir.x * (W_SHOULDER + L * .3), sz = z - dir.z * (W_SHOULDER + L * .3);
    if (isLand(sx, sz, .3)) boulder(rocks, sx, sz, 1 + rand() * 1.4, relief + .8, 0, rand);
  }
}
const W_SHOULDER = 2;

export const rockVertex = /* glsl */`
attribute vec3 aLocal;attribute float aSeed;attribute float aRelief;attribute float aBirth;uniform float uStage;
varying vec3 vWorld;varying vec3 vNormal;varying vec3 vLocal;varying float vSeed;varying float vRelief;varying float vBorn;
void main(){vec4 w=modelMatrix*vec4(position,1.);vWorld=w.xyz;vNormal=normalize(mat3(modelMatrix)*normal);vLocal=aLocal;vSeed=aSeed;vRelief=aRelief;vBorn=step(aBirth-.01,uStage);gl_Position=projectionMatrix*viewMatrix*w;}
`;
/**
 * The planet's beauty pass brought down to the ground: per-pixel basalt relief (fbm + ridged, finite-differenced into the
 * smooth normal), basalt→rust albedo by aRelief with pale dust settled on the up-facing surfaces, the key with a soft
 * terminator, the home page's violet wrap, the fog's dusty sky light on the tops, a satin key specular, a fog rim, and the
 * same haze toward the sky as the terrain so the rocks sink into the distance with it.
 */
export const rockFragment = /* glsl */`
precision highp float;
uniform vec3 uKey;uniform vec3 uCamera;uniform vec3 uFog;uniform float uTime;uniform float uFogK;uniform float uHorizon;uniform float uFogH;uniform float uBase;
varying vec3 vWorld;varying vec3 vNormal;varying vec3 vLocal;varying float vSeed;varying float vRelief;varying float vBorn;
${noise}
${skyChunk}
float relief(vec3 s){return fbm(s*2.6)*.62+ridged(s*7.)*.3+fbm(s*17.)*.06;}
void main(){
 if(vBorn<.5)discard;
 vec3 n=normalize(vNormal);vec3 toEye=uCamera-vWorld;float dist=length(toEye);vec3 eye=toEye/dist;vec3 key=normalize(uKey);
 vec3 s=vLocal*1.4+vec3(vSeed*7.3,vSeed*2.1,vSeed*5.7);
 vec3 t=normalize(cross(n,abs(n.y)<.95?vec3(0,1,0):vec3(1,0,0)));vec3 b=cross(n,t);
 float e=.03;float h0=relief(s);float hx=relief(s+t*e);float hy=relief(s+b*e);
 float bump=mix(5.5,1.5,smoothstep(20.,120.,dist));
 vec3 pn=normalize(n-(t*(hx-h0)+b*(hy-h0))*bump);
 float lowland=smoothstep(-1.,5.,vRelief);
 vec3 basalt=vec3(.045,.024,.018),rust=vec3(.27,.10,.05),pale=vec3(.36,.19,.12);
 float dust=smoothstep(.15,.85,pn.y)*smoothstep(.3,.75,fbm(s*2.+5.))*lowland;
 vec3 albedo=mix(basalt,rust,lowland*(.5+.5*h0));albedo=mix(albedo,pale,dust*.55);albedo*=(.7+.6*h0)*.42;
 float diffuse=max(0.,dot(pn,key));float terminator=smoothstep(-.08,.35,dot(n,key));
 float wrap=pow(max(0.,dot(pn,normalize(vec3(.6,.5,.75)))),1.4);
 vec3 c=albedo*(diffuse*terminator*.85*vec3(1.,.93,.84)+.004)+albedo*wrap*vec3(.07,.11,.30)*.25;
 c+=albedo*uFog*(.35+.65*max(pn.y,0.))*.9;
 c+=pow(max(0.,dot(reflect(-key,pn),eye)),24.)*.05*vec3(1.,.93,.84)*(.4+.6*lowland);
 c+=uFog*pow(1.-max(0.,dot(n,eye)),4.)*.22;
 c=c/(1.+c*.25);
 float thin=exp(-max(0.,vWorld.y-uBase)/uFogH);float haze=1.-exp(-dist*dist*uFogK*thin);
 c=mix(c,sky(-eye,uFog,uHorizon,uTime,key),haze);
 float grain=(hash(vec3(gl_FragCoord.xy,floor(uTime*6.)))-.5)*.012;
 gl_FragColor=vec4(pow(max(c,0.),vec3(1./2.2))+grain,1.);}
`;

function rockMaterial() {
  return new THREE.ShaderMaterial({ vertexShader: rockVertex, fragmentShader: rockFragment, uniforms: {
    uKey: { value: new THREE.Vector3(-.62, .5, .6).normalize() }, uCamera: { value: new THREE.Vector3(0, .6, 5.6) }, uFog: { value: new THREE.Color(FOG[0]) },
    uTime: { value: 0 }, uStage: { value: 0 }, uFogK: { value: FOG_K }, uFogH: { value: FOG_SCALE_HEIGHT }, uBase: { value: BASE }, uHorizon: { value: HORIZON } } });
}

/** Per frame, right after `landscape.update(time, camera, key)`: the rocks share the landscape's fog, key, camera and stage. */
export function updateRocks(rocks: THREE.Mesh, time: number, camera: THREE.Camera, key: THREE.Vector3, fog: THREE.Color, stage: number) {
  const u = (rocks.material as THREE.ShaderMaterial).uniforms;
  u.uTime.value = time; u.uStage.value = stage; u.uCamera.value.copy(camera.position); u.uKey.value.copy(key).normalize(); u.uFog.value.copy(fog);
}

// ─── solids ───────────────────────────────────────────────────────────────────────────────────────────────────────────

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
