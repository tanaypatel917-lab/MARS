import * as THREE from 'three';
import * as shader from './landscapeShaders';
import { EXTENT, BASE, POOL, FOG_K, FOG_SCALE_HEIGHT, HORIZON, heightAt } from './landscapeTerrain';
import { buildColony } from './landscapeColony';
import { buildGround, updateRocks } from './landscapeGround';
import { buildSky } from './landscapeSky';
import { buildFlora } from './landscapeFlora';

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
const COLONY = 0xece6dc, LIGHT = 0xffb27a, COLD = 0x9fc4d8;

export class Landscape {
  readonly fog = new THREE.Color(FOG[0]);
  /** Colonisation progress, 0 (arrival) … 4 (ascent); fractional values grow the structures in. Tween it with `fog`. */
  stage = 4;
  private readonly scene: THREE.Scene;
  private readonly objects: THREE.Object3D[] = [];
  private readonly disposables: { dispose(): void }[] = [];
  private readonly sky: THREE.ShaderMaterial; private readonly terrain: THREE.ShaderMaterial;
  private readonly staged: THREE.ShaderMaterial[] = [];
  private readonly rocks: THREE.Mesh;
  private readonly flora: ReturnType<typeof buildFlora>;
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
    const terrainGeometry = grid(mobile ? 140 : 240);
    this.terrain = new THREE.ShaderMaterial({ vertexShader: shader.terrainVertex, fragmentShader: shader.terrainFragment, uniforms: {
      ...this.shared(), uPool: { value: POOL } } });
    const terrain = new THREE.Mesh(terrainGeometry, this.terrain);
    terrain.frustumCulled = false;
    this.add(terrain); this.disposables.push(terrainGeometry, this.terrain);

    this.staged.push(this.terrain);

    // the colony, stage by stage (./landscapeColony): hairlines, warm window lights, cold navigation lights, hull/pad plates
    const colony = buildColony();
    this.addStrokes(colony.lines, COLONY, .45);
    this.addSparks(colony.lights, LIGHT, 16);
    this.addSparks(colony.cold, COLD, 10);
    this.addSolid(colony.solids);

    // the ground's detail (./landscapeGround): boulders, outcrops, landing pads, tyre tracks, survey stakes, beacons
    const ground = buildGround();
    this.addSolid(ground.solids);
    this.addStrokes(ground.strokes, COLONY, .18);
    this.addSparks(ground.lights, LIGHT, 9);
    this.addSparks(ground.cold, COLD, 10);
    this.addSparks(ground.dust, COLONY, 5, .35);
    this.rocks = ground.rocks; this.add(this.rocks); this.disposables.push(this.rocks.geometry, this.rocks.material as THREE.Material);

    // above the horizon (./landscapeSky): stars, Phobos and Deimos, the far volcano and mesas, traffic and the stage-4 orbital works
    const above = buildSky();
    this.addSolid(above.mesas);
    this.addSolid(above.moons);
    this.addSparks(above.stars, COLONY, 3, .55);
    this.addSparks(above.traffic, COLD, 8);
    this.addStrokes(above.strokes, COLONY, .3);

    // life and weather (./landscapeFlora): bioluminescent flora growing with the stages, dust motes, dust devils, meteors, pool mist
    this.flora = buildFlora();
    this.add(...this.flora.objects);
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
    updateRocks(this.rocks, time, camera, this.key, this.fog, this.stage);
    this.flora.update(time, camera, this.key, this.fog, this.stage);
  }

  dispose() { for (const o of this.objects) this.scene.remove(o); for (const d of this.disposables) d.dispose(); this.flora.dispose(); }
}

const hash = (x: number, y: number) => { const h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return h - Math.floor(h); };

/**
 * Square grid over EXTENT, vertices jittered off the lattice (except on the plain) so the silhouettes fall irregularly, denser
 * toward the stele (the band the camera sees up close) and with analytic smooth normals from heightAt so the dunes shade as
 * continuous regolith rather than facets; the shader adds the per-pixel detail.
 */
function grid(segments: number) {
  const n = segments + 1, position = new Float32Array(n * n * 3), normal = new Float32Array(n * n * 3), relief = new Float32Array(n * n), index: number[] = [];
  const warp = (t: number) => { const u = t * 2 - 1; return (Math.sign(u) * (Math.abs(u) * .55 + u * u * .45) + 1) * .5; };
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const k = j * n + i;
    const edge = i === 0 || j === 0 || i === segments || j === segments ? 0 : 1;
    let x = (warp(i / segments) - .5) * EXTENT, z = (warp(j / segments) - .5) * EXTENT;
    const step = EXTENT / segments * (.55 + .9 * Math.hypot(x, z) / EXTENT);
    const jitter = .38 * step * edge * THREE.MathUtils.smoothstep(Math.hypot(x, z), 7, 14);
    x += (hash(i, j) - .5) * jitter; z += (hash(j + 7.3, i) - .5) * jitter;
    const h = heightAt(x, z), e = Math.max(.35, step * .5);
    position[k * 3] = x; position[k * 3 + 1] = h.y; position[k * 3 + 2] = z; relief[k] = h.relief;
    const nx = heightAt(x - e, z).y - heightAt(x + e, z).y, nz = heightAt(x, z - e).y - heightAt(x, z + e).y, l = Math.hypot(nx, 2 * e, nz);
    normal[k * 3] = nx / l; normal[k * 3 + 1] = 2 * e / l; normal[k * 3 + 2] = nz / l;
  }
  for (let j = 0; j < segments; j++) for (let i = 0; i < segments; i++) {
    const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
    if ((i + j) % 2) index.push(a, c, b, b, c, d); else index.push(a, c, d, a, d, b);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(position, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  g.setAttribute('aRelief', new THREE.BufferAttribute(relief, 1));
  g.setIndex(index);
  return g;
}
