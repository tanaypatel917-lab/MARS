import * as THREE from 'three';
import * as shader from './landscapeShaders';
import { EXTENT, BASE, POOL, FOG_K, FOG_SCALE_HEIGHT, HORIZON, heightAt, siteOnLand, seeded } from './landscapeTerrain';
import { Strokes, Sparks } from './landscapeKit';

export { heightAt, POOL } from './landscapeTerrain';

/**
 * The colonised Martian landscape under the /how stele, after the fog-tinted low-poly plains of Guillaume's home: rolling
 * dunes with flat glossy pools in the valleys, a plateau the stele stands on, a dust fog that dissolves the far terrain into a
 * sky gradient of the same tint, and the hairline ivory colony with its warm window lights. One colour, `fog`, tints all of it;
 * the page tweens it between the FOG entries per move and the shaders read it each frame. `stage` (0 … 4, tween it alongside
 * the fog) is how far the colonisation has come: structures born at a later stage draw on as it passes them.
 *
 * Heights, fog constants and the camera convention live in ./landscapeTerrain; geometry builders in ./landscapeKit.
 */
export const FOG = ['#3a3220', '#1d3838', '#2f4433', '#3a1a12', '#2a0c0e'];

const KEY = new THREE.Vector3(-.62, .5, .6).normalize();
const COLONY = 0xece6dc, LIGHT = 0xffb27a;

export class Landscape {
  readonly fog = new THREE.Color(FOG[0]);
  /** Colonisation progress, 0 (arrival) … 4 (ascent); fractional values grow the structures in. Tween it with `fog`. */
  stage = 4;
  private readonly scene: THREE.Scene;
  private readonly objects: THREE.Object3D[] = [];
  private readonly disposables: { dispose(): void }[] = [];
  private readonly sky: THREE.ShaderMaterial; private readonly terrain: THREE.ShaderMaterial;
  private readonly staged: THREE.ShaderMaterial[] = [];
  private readonly ratio = Math.min(devicePixelRatio || 1, 2);
  private readonly camera = new THREE.Vector3(0, .6, 5.6);
  private readonly key = KEY.clone();

  constructor(scene: THREE.Scene, mobile: boolean) {
    this.scene = scene;

    // sky: a background quad that reconstructs the view ray per pixel so the gradient stays on the world horizon as the camera orbits
    this.sky = new THREE.ShaderMaterial({ vertexShader: shader.skyVertex, fragmentShader: shader.skyFragment, uniforms: {
      uProjInv: { value: new THREE.Matrix4() }, uCamWorld: { value: new THREE.Matrix4() }, uFog: { value: this.fog }, uKey: { value: this.key }, uTime: { value: 0 }, uStage: { value: this.stage }, uHorizon: { value: HORIZON } },
      depthTest: false, depthWrite: false });
    const skyGeometry = new THREE.PlaneGeometry(2, 2);
    const sky = new THREE.Mesh(skyGeometry, this.sky);
    sky.renderOrder = -1; sky.frustumCulled = false;
    this.add(sky); this.disposables.push(skyGeometry, this.sky);

    // terrain: a jittered grid built in world space (x, height, z)
    const terrainGeometry = grid(mobile ? 110 : 180);
    this.terrain = new THREE.ShaderMaterial({ vertexShader: shader.terrainVertex, fragmentShader: shader.terrainFragment, uniforms: {
      ...this.shared(), uPool: { value: POOL } } });
    const terrain = new THREE.Mesh(terrainGeometry, this.terrain);
    terrain.frustumCulled = false;
    this.add(terrain); this.disposables.push(terrainGeometry, this.terrain);

    // colony hairlines and window lights
    const { lines, lights } = colony();
    this.addStrokes(lines, COLONY, .45);
    this.addSparks(lights, LIGHT, 16);
    this.staged.push(this.terrain);
  }

  private shared() {
    return { uKey: { value: this.key }, uCamera: { value: this.camera }, uFog: { value: this.fog }, uTime: { value: 0 }, uStage: { value: this.stage },
      uFogK: { value: FOG_K }, uFogH: { value: FOG_SCALE_HEIGHT }, uBase: { value: BASE }, uHorizon: { value: HORIZON } };
  }

  /** Hairline strokes (a Strokes geometry) in the landscape's fog, drawing on with `stage`. */
  addStrokes(geometry: THREE.BufferGeometry, color = COLONY, opacity = .45) {
    const m = new THREE.ShaderMaterial({ vertexShader: shader.colonyVertex, fragmentShader: shader.colonyFragment, uniforms: { ...this.shared(), uColor: { value: new THREE.Color(color) }, uOpacity: { value: opacity }, uSize: { value: 1 }, uPoint: { value: 0 } }, transparent: true, depthWrite: false });
    const mesh = new THREE.LineSegments(geometry, m); mesh.frustumCulled = false;
    this.add(mesh); this.disposables.push(geometry, m); this.staged.push(m);
    return mesh;
  }

  /** Soft additive lights (a Sparks geometry); `size` is the base point size in CSS px. */
  addSparks(geometry: THREE.BufferGeometry, color = LIGHT, size = 16, opacity = 1) {
    const m = new THREE.ShaderMaterial({ vertexShader: shader.colonyVertex, fragmentShader: shader.colonyFragment, uniforms: { ...this.shared(), uColor: { value: new THREE.Color(color) }, uOpacity: { value: opacity }, uSize: { value: size * this.ratio }, uPoint: { value: 1 } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const mesh = new THREE.Points(geometry, m); mesh.frustumCulled = false;
    this.add(mesh); this.disposables.push(geometry, m); this.staged.push(m);
    return mesh;
  }

  /** Low-poly solids (a Solids geometry: boulders, rims, hulls) shaded like the terrain, appearing at their aBirth stage. */
  addSolid(geometry: THREE.BufferGeometry) {
    const mesh = new THREE.Mesh(geometry, this.terrain); mesh.frustumCulled = false;
    this.add(mesh); this.disposables.push(geometry);
    return mesh;
  }

  private add(...objects: THREE.Object3D[]) { for (const o of objects) { this.scene.add(o); this.objects.push(o); } }

  update(time: number, camera: THREE.PerspectiveCamera, key: THREE.Vector3) {
    this.camera.copy(camera.position); this.key.copy(key).normalize();
    camera.updateMatrixWorld();
    this.sky.uniforms.uProjInv.value.copy(camera.projectionMatrixInverse);
    this.sky.uniforms.uCamWorld.value.copy(camera.matrixWorld);
    this.sky.uniforms.uTime.value = time; this.sky.uniforms.uStage.value = this.stage;
    for (const m of this.staged) { m.uniforms.uTime.value = time; m.uniforms.uStage.value = this.stage; }
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

/** Hairline colony on the land: domes (three latitude rings + a meridian), masts, a landing ring, lit tracks; warm window lights. */
function colony() {
  const lines = new Strokes(), lights = new Sparks(); const rand = seeded(11);
  const dome = (sx: number, sz: number, r: number, birth: number) => {
    const [x, y, z] = siteOnLand(sx, sz, .6);
    for (const k of [.0, .45, .78]) lines.circle([x, y + r * k, z], r * Math.sqrt(1 - k * k), birth);
    lines.arc([x, y, z], r, birth, 0, Math.PI, 'z', 12);
    for (let i = 0; i < 5; i++) { const a = rand() * Math.PI * 2; lights.add([x + Math.cos(a) * r * .8, y + r * .25 + rand() * r * .3, z + Math.sin(a) * r * .8], birth + .3, .9); }
  };
  const mast = (sx: number, sz: number, h: number, birth: number) => { const [x, y, z] = siteOnLand(sx, sz, .6); lines.seg([x, y, z], [x, y + h, z], birth); lights.add([x, y + h, z], birth + .2, .8); };
  const sites: [number, number, number, number][] = [[-38, -52, 6, 1], [-30, -58, 4, 2], [-46, -47, 3.2, 2], [52, -40, 5, 1], [58, -34, 3.4, 3], [20, -70, 7, 2], [27, -64, 3.6, 3], [-60, 20, 4.5, 2], [64, 30, 5.2, 3], [-20, 72, 5.5, 3], [-12, 66, 3, 3], [26, -22, 2.4, 0], [-24, 28, 2.8, 1], [34, 18, 2.2, 2], [-30, -26, 3, 1], [14, -34, 2.6, 0], [40, 2, 2.2, 2], [-36, 6, 2.4, 1], [6, 40, 2.8, 2], [-14, -40, 2, 1]];
  for (const [x, z, r, b] of sites) dome(x, z, r, b);
  for (const [x, z, h, b] of [[-24, -60, 11, 1], [48, -50, 14, 2], [10, -74, 9, 2], [66, 22, 10, 3], [-66, 12, 12, 2], [-4, 78, 8, 3], [30, -26, 5, 0], [-28, 24, 6, 1], [-34, -30, 7, 1], [10, -38, 6, 0], [-6, 44, 5, 2]]) mast(x, z, h, b);
  const ring = (cx: number, cz: number, r: number, birth: number) => { const [x, y, z] = siteOnLand(cx, cz, .6); lines.circle([x, y + .15, z], r, birth, 'y', 48); };
  ring(36, -58, 5, 1); ring(36, -58, 3.4, 1);
  const track = (p: (t: number) => readonly [number, number], n: number, birth: number, every: number) => {
    const pts: [number, number, number][] = [];
    for (let i = 0; i <= n; i++) { const [x, z] = p(i / n); pts.push([x, heightAt(x, z).y + .1, z]); if (i % every === 0) lights.add([x, heightAt(x, z).y + .3, z], birth + .4 + i / n * .4, .7); }
    lines.poly(pts, birth);
  };
  track(t => [THREE.MathUtils.lerp(-40, 36, t) + Math.sin(t * 6) * 4, THREE.MathUtils.lerp(-52, -58, t)], 60, 2, 6);
  track(t => [THREE.MathUtils.lerp(-34, 30, t) + Math.sin(t * 4 + 1) * 3, THREE.MathUtils.lerp(-24, -30, t) + Math.cos(t * 3) * 2], 48, 1, 4);
  return { lines: lines.geometry(), lights: lights.geometry() };
}
