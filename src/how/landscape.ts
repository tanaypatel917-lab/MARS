import * as THREE from 'three';
import { fbm } from '../geometry';
import * as shader from './landscapeShaders';

/**
 * The colonised Martian landscape under the /how stele, after the fog-tinted low-poly plains of Guillaume's home: rolling
 * dunes with flat glossy pools in the valleys, a plateau the stele stands on, a dust fog that dissolves the far terrain into a
 * sky gradient of the same tint, and the hairline ivory colony with its warm window lights. One colour, `fog`, tints all of it;
 * the page tweens it between the FOG entries per move and the shaders read it each frame.
 *
 * Camera convention: the stele is at the origin, the camera orbits at radius ~5.6, height ~.6, looking at (0,.2,0), fov 34.
 * The plain lies ~10 units below the stele and slopes away, so from that camera the horizon dissolves ~58 % down the frame
 * and the nearest ridges rise to just under the stele's base.
 */
export const FOG = ['#3a3220', '#1d3838', '#2f4433', '#3a1a12', '#2a0c0e'];

const EXTENT = 440;
/** Level of the plain under the stele; the land falls DROP further toward the horizon (so the horizon sits ~58 % down the frame). */
const BASE = -9, DROP = 12;
/** Relief (above the local base) at or below which the terrain is a pool. */
const POOL = 1.05;
/** Haze density (exp(-d²k)): the terrain is fully dissolved ~140 units out. */
const FOG_K = 1 / (100 * 100);
/** Elevation (unit direction y) of the sky's horizon, matched to where the far terrain dissolves. */
const HORIZON = -.16;
const KEY = new THREE.Vector3(-.62, .5, .6).normalize();
const COLONY = 0xece6dc, LIGHT = 0xffb27a;

/**
 * Height of the landscape at (x, z): the gently falling base plus dune relief — long ridged dunes (1 − |fbm|, so the crests are
 * sharp and the basins between them broad) with finer facets on the crests — flattened into a plain near the stele; everything at
 * or below the pool level is clamped flat so the basins become pools.
 */
export function heightAt(x: number, z: number) {
  const r = Math.hypot(x, z);
  const base = BASE - DROP * THREE.MathUtils.smoothstep(r, 10, 150);
  const ridged = 1 - Math.abs(fbm(x * .0165 + 3.1, z * .0135, 1.7, 3)) * 4.5;
  const crest = Math.max(ridged, 0) ** 1.8;
  let relief = (crest * 7.4 + fbm(x * .07, z * .07 + 9, 4.2, 3) * 1.4 * (.3 + crest)) * THREE.MathUtils.smoothstep(r, 6, 17);
  relief = Math.max(relief, POOL);
  return { y: base + relief, relief };
}

export class Landscape {
  readonly fog = new THREE.Color(FOG[0]);
  private readonly scene: THREE.Scene;
  private readonly objects: THREE.Object3D[] = [];
  private readonly disposables: { dispose(): void }[] = [];
  private readonly sky: THREE.ShaderMaterial; private readonly terrain: THREE.ShaderMaterial;
  private readonly lines: THREE.ShaderMaterial; private readonly lights: THREE.ShaderMaterial;
  private readonly camera = new THREE.Vector3(0, .6, 5.6);
  private readonly key = KEY.clone();

  constructor(scene: THREE.Scene, mobile: boolean) {
    this.scene = scene;
    const ratio = Math.min(devicePixelRatio || 1, 2);

    // sky: a background quad that reconstructs the view ray per pixel so the gradient stays on the world horizon as the camera orbits
    this.sky = new THREE.ShaderMaterial({ vertexShader: shader.skyVertex, fragmentShader: shader.skyFragment, uniforms: {
      uProjInv: { value: new THREE.Matrix4() }, uCamWorld: { value: new THREE.Matrix4() }, uFog: { value: this.fog }, uKey: { value: this.key }, uTime: { value: 0 }, uHorizon: { value: HORIZON } },
      depthTest: false, depthWrite: false });
    const skyGeometry = new THREE.PlaneGeometry(2, 2);
    const sky = new THREE.Mesh(skyGeometry, this.sky);
    sky.renderOrder = -1; sky.frustumCulled = false;
    this.add(sky); this.disposables.push(skyGeometry, this.sky);

    // terrain: a jittered grid built in world space (x, height, z)
    const terrainGeometry = grid(mobile ? 110 : 180);
    this.terrain = new THREE.ShaderMaterial({ vertexShader: shader.terrainVertex, fragmentShader: shader.terrainFragment, uniforms: {
      uKey: { value: this.key }, uCamera: { value: this.camera }, uFog: { value: this.fog }, uTime: { value: 0 }, uPool: { value: POOL }, uFogK: { value: FOG_K }, uHorizon: { value: HORIZON } } });
    const terrain = new THREE.Mesh(terrainGeometry, this.terrain);
    terrain.frustumCulled = false;
    this.add(terrain); this.disposables.push(terrainGeometry, this.terrain);

    // colony hairlines and window lights
    const colonyUniforms = (color: number, opacity: number, size: number, point: number) => ({
      uColor: { value: new THREE.Color(color) }, uFog: { value: this.fog }, uKey: { value: this.key }, uCamera: { value: this.camera }, uOpacity: { value: opacity }, uFogK: { value: FOG_K }, uSize: { value: size * ratio }, uPoint: { value: point }, uTime: { value: 0 }, uHorizon: { value: HORIZON } });
    this.lines = new THREE.ShaderMaterial({ vertexShader: shader.colonyVertex, fragmentShader: shader.colonyFragment, uniforms: colonyUniforms(COLONY, .45, 1, 0), transparent: true, depthWrite: false });
    this.lights = new THREE.ShaderMaterial({ vertexShader: shader.colonyVertex, fragmentShader: shader.colonyFragment, uniforms: colonyUniforms(LIGHT, 1, 16, 1), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const { lines, lights } = colony();
    const lineMesh = new THREE.LineSegments(lines, this.lines), lightMesh = new THREE.Points(lights, this.lights);
    lineMesh.frustumCulled = lightMesh.frustumCulled = false;
    this.add(lineMesh, lightMesh); this.disposables.push(lines, lights, this.lines, this.lights);
  }

  private add(...objects: THREE.Object3D[]) { for (const o of objects) { this.scene.add(o); this.objects.push(o); } }

  update(time: number, camera: THREE.PerspectiveCamera, key: THREE.Vector3) {
    this.camera.copy(camera.position); this.key.copy(key).normalize();
    camera.updateMatrixWorld();
    this.sky.uniforms.uProjInv.value.copy(camera.projectionMatrixInverse);
    this.sky.uniforms.uCamWorld.value.copy(camera.matrixWorld);
    this.sky.uniforms.uTime.value = time;
    this.terrain.uniforms.uTime.value = this.lines.uniforms.uTime.value = this.lights.uniforms.uTime.value = time;
  }

  dispose() { for (const o of this.objects) this.scene.remove(o); for (const d of this.disposables) d.dispose(); }
}

const hash = (x: number, y: number) => { const h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return h - Math.floor(h); };

/** Square grid over EXTENT, vertices jittered off the lattice (except on the plain) so the facets fall irregularly. */
function grid(segments: number) {
  const n = segments + 1, position = new Float32Array(n * n * 3), relief = new Float32Array(n * n), index: number[] = [];
  const step = EXTENT / segments;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const k = j * n + i;
    const edge = i === 0 || j === 0 || i === segments || j === segments ? 0 : 1;
    let x = (i / segments - .5) * EXTENT, z = (j / segments - .5) * EXTENT;
    const jitter = .38 * step * edge * THREE.MathUtils.smoothstep(Math.hypot(x, z), 7, 14);
    x += (hash(i, j) - .5) * jitter; z += (hash(j + 7.3, i) - .5) * jitter;
    const h = heightAt(x, z);
    position[k * 3] = x; position[k * 3 + 1] = h.y; position[k * 3 + 2] = z; relief[k] = h.relief;
  }
  for (let j = 0; j < segments; j++) for (let i = 0; i < segments; i++) {
    const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
    if ((i + j) % 2) index.push(a, c, b, b, c, d); else index.push(a, c, d, a, d, b);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(position, 3));
  g.setAttribute('aRelief', new THREE.BufferAttribute(relief, 1));
  g.setIndex(index);
  return g;
}

/** Hairline colony on the land: domes (three latitude rings + a meridian), masts, a landing ring, one lit track; warm window lights. */
function colony() {
  const lines: number[] = [], lights: number[] = [];
  let seed = 11;
  const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  /** Nudge a site outward until it stands on land rather than in a pool. */
  const site = (x: number, z: number): [number, number, number] => {
    for (let k = 0; k < 12; k++) { const h = heightAt(x, z); if (h.relief > POOL + .6) return [x, h.y, z]; const r = Math.hypot(x, z); x += x / r * 3; z += z / r * 3; }
    const h = heightAt(x, z); return [x, h.y, z];
  };
  const circle = (cx: number, cy: number, cz: number, r: number, ax: 'y' | 'z', n = 40) => { for (let i = 0; i < n; i++) { const a0 = i / n * Math.PI * 2, a1 = (i + 1) / n * Math.PI * 2; if (ax === 'y') lines.push(cx + Math.cos(a0) * r, cy, cz + Math.sin(a0) * r, cx + Math.cos(a1) * r, cy, cz + Math.sin(a1) * r); else lines.push(cx + Math.cos(a0) * r, cy + Math.sin(a0) * r, cz, cx + Math.cos(a1) * r, cy + Math.sin(a1) * r, cz); } };
  const dome = (sx: number, sz: number, r: number) => {
    const [x, y, z] = site(sx, sz);
    for (const k of [.0, .45, .78]) circle(x, y + r * k, z, r * Math.sqrt(1 - k * k), 'y');
    for (let i = 0; i < 12; i++) { const a0 = i / 12 * Math.PI, a1 = (i + 1) / 12 * Math.PI; lines.push(x + Math.cos(a0) * r, y + Math.sin(a0) * r, z, x + Math.cos(a1) * r, y + Math.sin(a1) * r, z); }
    for (let i = 0; i < 5; i++) { const a = rand() * Math.PI * 2; lights.push(x + Math.cos(a) * r * .8, y + r * .25 + rand() * r * .3, z + Math.sin(a) * r * .8); }
  };
  const mast = (sx: number, sz: number, h: number) => { const [x, y, z] = site(sx, sz); lines.push(x, y, z, x, y + h, z); lights.push(x, y + h, z); };
  for (const [x, z, r] of [[-38, -52, 6], [-30, -58, 4], [-46, -47, 3.2], [52, -40, 5], [58, -34, 3.4], [20, -70, 7], [27, -64, 3.6], [-60, 20, 4.5], [64, 30, 5.2], [-20, 72, 5.5], [-12, 66, 3], [26, -22, 2.4], [-24, 28, 2.8], [34, 18, 2.2], [-30, -26, 3], [14, -34, 2.6], [40, 2, 2.2], [-36, 6, 2.4], [6, 40, 2.8], [-14, -40, 2]]) dome(x, z, r);
  for (const [x, z, h] of [[-24, -60, 11], [48, -50, 14], [10, -74, 9], [66, 22, 10], [-66, 12, 12], [-4, 78, 8], [30, -26, 5], [-28, 24, 6], [-34, -30, 7], [10, -38, 6], [-6, 44, 5]]) mast(x, z, h);
  const ring = (cx: number, cz: number, r: number) => { const [x, y, z] = site(cx, cz); circle(x, y + .15, z, r, 'y', 48); };
  ring(36, -58, 5); ring(36, -58, 3.4);
  for (let i = 0; i < 60; i++) { const t0 = i / 60, t1 = (i + 1) / 60; const p = (t: number) => [THREE.MathUtils.lerp(-40, 36, t) + Math.sin(t * 6) * 4, THREE.MathUtils.lerp(-52, -58, t)] as const; const [x0, z0] = p(t0), [x1, z1] = p(t1); lines.push(x0, heightAt(x0, z0).y + .1, z0, x1, heightAt(x1, z1).y + .1, z1); if (i % 6 === 0) lights.push(x0, heightAt(x0, z0).y + .3, z0); }
  for (let i = 0; i < 48; i++) { const t0 = i / 48, t1 = (i + 1) / 48; const p = (t: number) => [THREE.MathUtils.lerp(-34, 30, t) + Math.sin(t * 4 + 1) * 3, THREE.MathUtils.lerp(-24, -30, t) + Math.cos(t * 3) * 2] as const; const [x0, z0] = p(t0), [x1, z1] = p(t1); lines.push(x0, heightAt(x0, z0).y + .1, z0, x1, heightAt(x1, z1).y + .1, z1); if (i % 4 === 0) lights.push(x0, heightAt(x0, z0).y + .3, z0); }
  const lg = new THREE.BufferGeometry(); lg.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
  const pg = new THREE.BufferGeometry(); pg.setAttribute('position', new THREE.Float32BufferAttribute(lights, 3));
  return { lines: lg, lights: pg };
}
