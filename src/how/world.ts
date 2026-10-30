import * as THREE from 'three';
import * as shader from '../shaders';
import { fbm, planetGeometry, wireGeometry } from '../geometry';

/**
 * The /how world: one continuous space. The camera sits at a pivot and yaws 90° per section (Lusion's section-bound ratios);
 * each section's object waits on a ring around the pivot, recedes when it is not the current one, and a colonised Martian plain
 * lies far below. Objects reuse the home page's shaders so the two pages share one material language.
 */
export type SceneKind = 'shard' | 'field' | 'sieve' | 'slab' | 'gate';
export interface WorldState {
  time: number;
  /** 0..4, fractional between sections (already eased by the page). */
  progress: number;
  pointer: { x: number; y: number };
  /** Per-object controls. */
  fieldSpin: number;
  threshold: number;
  growth: number;
  contour: { x: number; y: number; z: number; r: number } | null;
  candidateOrbit: number;
  candidateOffset: { x: number; y: number } | null;
  shatter: number;
  flare: number;
  engrave: number;
  facet: number;
  crack: number;
  fade: number;
}
export interface Hit { kind: SceneKind; point: THREE.Vector3; local: THREE.Vector3; index: number; facet: number; distance: number }

const RING = 7;
const SECTION_YAW = [0, 1, 2, 3, 4].map(i => i * Math.PI / 2);
const SECTION_Y = [.35, .35, .35, .35, 3.9];
const COLONY = 0xece6dc;
/** Objects sit right of the copy column. */
const SHIFT = 1.15;
const MOBILE_LIFT = .8;

export class HowWorld {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(34, 1, .1, 400);
  readonly groups: THREE.Group[] = [];
  private readonly raycaster = new THREE.Raycaster();
  private readonly key = new THREE.Vector3(-.62, .5, .6).normalize();
  private readonly materials: THREE.ShaderMaterial[] = [];
  private readonly disposables: { dispose(): void }[] = [];
  private readonly shard: THREE.Mesh; private readonly field: THREE.Points; private readonly sieve: THREE.Mesh; private readonly slab: THREE.Mesh;
  private readonly incumbent: THREE.Mesh; private readonly candidate: THREE.LineSegments;
  private readonly beauty: THREE.ShaderMaterial[] = [];
  private readonly traces: THREE.ShaderMaterial; private readonly glass: THREE.ShaderMaterial; private readonly wire: THREE.ShaderMaterial;
  private readonly land: THREE.ShaderMaterial; private readonly colony: THREE.ShaderMaterial; private readonly lights: THREE.ShaderMaterial;
  readonly facetOf: Float32Array;
  readonly traceCount: number;
  private ratio = 1;
  yaw = 0; pitch = 0;

  private readonly shift: number; private readonly lift: number;
  constructor(canvas: HTMLCanvasElement, mobile: boolean) {
    this.shift = mobile ? .15 : SHIFT; this.lift = mobile ? MOBILE_LIFT : 0;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setClearColor(0x050407, 1);
    this.camera.position.set(0, .4, 0);
    const detail = mobile ? 22 : 36;

    // terrain bake shared by every beauty-shaded body
    const bake = new THREE.WebGLRenderTarget(mobile ? 1024 : 2048, mobile ? 512 : 1024, { type: THREE.HalfFloatType, depthBuffer: false, wrapS: THREE.RepeatWrapping, wrapT: THREE.ClampToEdgeWrapping, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    const quad = new THREE.PlaneGeometry(2, 2);
    const bakeMaterial = new THREE.ShaderMaterial({ vertexShader: shader.fullscreenVertex, fragmentShader: shader.bakeFragment, depthTest: false, depthWrite: false });
    const bakeScene = new THREE.Scene(); bakeScene.add(new THREE.Mesh(quad, bakeMaterial));
    this.renderer.setRenderTarget(bake); this.renderer.render(bakeScene, this.camera); this.renderer.setRenderTarget(null);
    bakeMaterial.dispose(); this.disposables.push(bake, quad);
    const beautyMaterial = () => {
      const m = new THREE.ShaderMaterial({ vertexShader: shader.bodyVertex, fragmentShader: shader.beautyFragment, uniforms: {
        uMorph: { value: 0 }, uWordScale: { value: 1 }, uBox: { value: new THREE.Vector2(1, 1) }, tWord: { value: null }, uSpawn: { value: 0 },
        uTime: { value: 0 }, uFade: { value: 1 }, uGrowth: { value: 1 }, uContour: { value: new THREE.Vector4() }, tTerrain: { value: bake.texture },
        uTexel: { value: new THREE.Vector2(1 / bake.width, 1 / bake.height) }, uKey: { value: this.key } } });
      this.beauty.push(m); this.materials.push(m); return m;
    };
    const body = (geometry: THREE.BufferGeometry) => {
      geometry.setAttribute('aTarget', new THREE.BufferAttribute(new Float32Array(geometry.attributes.position.count * 3), 3));
      geometry.setAttribute('aDelay', new THREE.BufferAttribute(new Float32Array(geometry.attributes.position.count), 1));
      this.disposables.push(geometry); return geometry;
    };
    const place = (i: number, object: THREE.Object3D) => {
      const g = new THREE.Group();
      g.position.set(Math.sin(SECTION_YAW[i]) * RING, SECTION_Y[i], -Math.cos(SECTION_YAW[i]) * RING);
      g.lookAt(0, SECTION_Y[i], 0);
      object.position.x += this.shift; object.position.y += this.lift; if (this.lift) object.scale.multiplyScalar(.7); g.add(object); this.scene.add(g); this.groups[i] = g; return g;
    };

    // 0 · the shard, with per-vertex facet ids for hover
    const shardGeometry = body(planetGeometry(detail, 'shard'));
    this.facetOf = facetIds(shardGeometry);
    shardGeometry.setAttribute('aFacet', new THREE.BufferAttribute(this.facetOf, 1));
    const shardMaterial = beautyMaterial();
    shardMaterial.vertexShader = shader.bodyVertex.replace('attribute vec3 aTarget;', 'attribute vec3 aTarget;attribute float aFacet;varying float vFacet;').replace('vForm=f;', 'vForm=f;vFacet=aFacet;');
    shardMaterial.fragmentShader = shader.beautyFragment.replace('uniform float uTime;', 'uniform float uTime;uniform float uFacet;uniform float uCrack;varying float vFacet;').replace(' float grain=', ' if(abs(vFacet-uFacet)<.5){c+=vec3(.93,.89,.82)*.07;}\n float grain=');
    shardMaterial.uniforms.uFacet = { value: -1 }; shardMaterial.uniforms.uCrack = { value: 0 };
    this.shard = new THREE.Mesh(shardGeometry, shardMaterial);
    this.shard.scale.setScalar(1.25);
    place(0, this.shard);

    // 1 · the trace field
    const count = mobile ? 900 : 2000; this.traceCount = count;
    const fieldGeometry = new THREE.BufferGeometry();
    const dirs = new Float32Array(count * 3), lands = new Float32Array(count * 3), tangents = new Float32Array(count * 3), seeds = new Float32Array(count), ms = new Float32Array(count), index = new Float32Array(count), born = new Float32Array(count);
    const d = new THREE.Vector3(), t = new THREE.Vector3(), up = new THREE.Vector3();
    for (let i = 0; i < count; i++) {
      const u = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2, s = Math.sqrt(1 - u * u);
      d.set(s * Math.cos(a), u * .55, s * Math.sin(a)).normalize().toArray(dirs, i * 3);
      d.clone().multiplyScalar(1.6 + Math.pow(Math.random(), .6) * 1.1).toArray(lands, i * 3);
      t.crossVectors(d, Math.abs(u) < .9 ? up.set(0, 1, 0) : up.set(1, 0, 0)).normalize().toArray(tangents, i * 3);
      seeds[i] = Math.random(); ms[i] = latency(i); index[i] = i;
    }
    fieldGeometry.setAttribute('position', new THREE.BufferAttribute(lands.slice(), 3));
    fieldGeometry.setAttribute('aDir', new THREE.BufferAttribute(dirs, 3)); fieldGeometry.setAttribute('aLand', new THREE.BufferAttribute(lands, 3));
    fieldGeometry.setAttribute('aTangent', new THREE.BufferAttribute(tangents, 3)); fieldGeometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
    fieldGeometry.setAttribute('aMs', new THREE.BufferAttribute(ms, 1)); fieldGeometry.setAttribute('aIndex', new THREE.BufferAttribute(index, 1)); fieldGeometry.setAttribute('aBorn', new THREE.BufferAttribute(born, 1));
    this.traces = new THREE.ShaderMaterial({ vertexShader: shader.tracesVertex, fragmentShader: shader.tracesFragment, uniforms: { uFall: { value: 1 }, uScore: { value: 0 }, uSink: { value: 0 }, uTime: { value: 0 }, uDpr: { value: 1 }, uRadius: { value: 0 }, uCount: { value: count }, uThreshold: { value: 800 } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    this.field = new THREE.Points(fieldGeometry, this.traces); this.field.scale.setScalar(.5);
    this.field.frustumCulled = false;
    this.disposables.push(fieldGeometry, this.traces);
    place(1, this.field);

    // 2 · the sieve
    const glassGeometry = new THREE.PlaneGeometry(2.8, 1.7, 1, 1);
    this.glass = new THREE.ShaderMaterial({ vertexShader: shader.glassVertex, fragmentShader: shader.glassFragment, uniforms: { uTime: { value: 0 }, uEngrave: { value: 0 }, tText: { value: evalTexture() }, uFade: { value: 1 } }, transparent: true, depthWrite: false, side: THREE.DoubleSide });
    this.sieve = new THREE.Mesh(glassGeometry, this.glass);
    this.sieve.rotation.y = .35;
    this.disposables.push(glassGeometry, this.glass);
    const passSet = new THREE.Points(fieldGeometry, this.traces); // the same traces, shown as the pass set behind the glass
    passSet.scale.setScalar(.3); passSet.position.set(.9, -.1, -1.4); passSet.frustumCulled = false;
    const sieveGroup = new THREE.Group(); sieveGroup.add(this.sieve, passSet);
    place(2, sieveGroup);

    // 3 · the slab: a flattened shard that grows while the pointer rests on it
    const slabGeometry = body(planetGeometry(detail, 'shard'));
    this.slab = new THREE.Mesh(slabGeometry, beautyMaterial());
    this.slab.scale.set(1.5, .55, 1.1); this.slab.rotation.x = .25;
    place(3, this.slab);

    // 4 · candidate vs incumbent
    this.incumbent = new THREE.Mesh(shardGeometry, beautyMaterial());
    this.incumbent.scale.setScalar(1.0);
    const wireGeo = wireGeometry(mobile ? 160 : 260, 'shard'); this.disposables.push(wireGeo);
    this.wire = new THREE.ShaderMaterial({ vertexShader: shader.wireVertex, fragmentShader: shader.wireFragment, uniforms: { uReveal: { value: 1 }, uOpacity: { value: .85 }, uDissolve: { value: 0 } }, transparent: true, depthWrite: false });
    this.candidate = new THREE.LineSegments(wireGeo, this.wire);
    this.candidate.scale.setScalar(.7);
    this.disposables.push(this.wire);
    const gateGroup = new THREE.Group(); gateGroup.add(this.incumbent, this.candidate);
    place(4, gateGroup);

    // the colonised plain
    const landGeometry = new THREE.PlaneGeometry(320, 320, mobile ? 110 : 180, mobile ? 110 : 180);
    const lp = landGeometry.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < lp.count; i++) {
      const x = lp.getX(i), y = lp.getY(i), r = Math.hypot(x, y);
      const h = fbm(x * .022 + 3.1, y * .022, 1.7, 4) * 7 + Math.abs(fbm(x * .07, y * .07 + 9, 4.2, 3)) * 2.2;
      lp.setZ(i, h * THREE.MathUtils.smoothstep(r, 6, 40) + Math.max(0, r - 90) * .05);
    }
    landGeometry.computeVertexNormals();
    this.land = new THREE.ShaderMaterial({ vertexShader: shader.landVertex, fragmentShader: shader.landFragment, uniforms: { uKey: { value: this.key }, uCamera: { value: this.camera.position }, uTime: { value: 0 }, uFade: { value: 1 } } });
    const land = new THREE.Mesh(landGeometry, this.land);
    land.rotation.x = -Math.PI / 2; land.position.y = -13;
    this.scene.add(land); this.disposables.push(landGeometry, this.land);
    this.colony = new THREE.ShaderMaterial({ vertexShader: shader.colonyVertex, fragmentShader: shader.colonyFragment, uniforms: { uColor: { value: new THREE.Color(COLONY) }, uOpacity: { value: .55 }, uCamera: { value: this.camera.position }, uSize: { value: 1 } }, transparent: true, depthWrite: false });
    this.lights = new THREE.ShaderMaterial({ vertexShader: shader.colonyVertex, fragmentShader: shader.colonyFragment, uniforms: { uColor: { value: new THREE.Color(0xffb27a) }, uOpacity: { value: .9 }, uCamera: { value: this.camera.position }, uSize: { value: 2.5 } }, transparent: true, depthWrite: false });
    const { lines, lights } = colony(landGeometry);
    this.scene.add(new THREE.LineSegments(lines, this.colony), new THREE.Points(lights, this.lights));
    this.disposables.push(lines, lights, this.colony, this.lights);
    this.resize();
  }

  resize() {
    const width = innerWidth, height = innerHeight;
    this.ratio = Math.min(devicePixelRatio || 1, 1.5, Math.sqrt(2_400_000 / (width * height)));
    this.renderer.setPixelRatio(this.ratio); this.renderer.setSize(width, height);
    this.camera.aspect = width / height; this.camera.updateProjectionMatrix();
    this.lights.uniforms.uSize.value = 2.5 * this.ratio;
  }

  /** Raycast the current section's object. */
  pick(section: number, x: number, y: number): Hit | null {
    this.raycaster.setFromCamera(new THREE.Vector2(x, y), this.camera);
    this.raycaster.params.Points.threshold = .09;
    const target = [this.shard, this.field, this.sieve, this.slab, this.candidate][section] as THREE.Object3D;
    const kinds: SceneKind[] = ['shard', 'field', 'sieve', 'slab', 'gate'];
    const hits = this.raycaster.intersectObjects(section === 4 ? [this.candidate, this.incumbent] : [target], false);
    const hit = hits[0];
    if (!hit) return null;
    const local = hit.object.worldToLocal(hit.point.clone());
    const facet = section === 0 && hit.face ? this.facetOf[hit.face.a] : -1;
    return { kind: kinds[section], point: hit.point, local, index: section === 4 ? (hit.object === this.incumbent ? 1 : 0) : hit.index ?? 0, facet, distance: hit.distance };
  }
  /** Screen position of a world point. */
  project(point: THREE.Vector3) { const p = point.clone().project(this.camera); return { x: (p.x * .5 + .5) * innerWidth, y: (.5 - p.y * .5) * innerHeight, behind: p.z > 1 }; }
  /** World position of trace i in the field. */
  tracePoint(i: number) { const a = this.field.geometry.attributes.aLand as THREE.BufferAttribute; return this.field.localToWorld(new THREE.Vector3().fromBufferAttribute(a, i)); }
  traceMs(i: number) { return (this.field.geometry.attributes.aMs as THREE.BufferAttribute).getX(i); }

  render(state: WorldState) {
    const yaw = THREE.MathUtils.lerp(0, Math.PI * 2, state.progress / 4);
    const pitch = THREE.MathUtils.smoothstep(state.progress, 3, 4) * .42;
    this.yaw = yaw; this.pitch = pitch;
    this.camera.position.set(0, .4 + state.pointer.y * .05, 0);
    this.camera.lookAt(Math.sin(yaw + state.pointer.x * .03) * RING, .4 + Math.sin(pitch) * RING + state.pointer.y * .3, -Math.cos(yaw + state.pointer.x * .03) * RING);
    const drift = state.time * .05;
    this.key.set(-.62 + Math.sin(drift) * .25, .5 + Math.cos(drift * .7) * .12, .6).normalize();
    for (let i = 0; i < 5; i++) {
      const dist = Math.min(Math.abs(state.progress - i), 4.5);
      const s = THREE.MathUtils.lerp(1, .55, THREE.MathUtils.smoothstep(dist, 0, 1));
      this.groups[i].scale.setScalar(s);
      this.groups[i].visible = dist < 1.6;
      this.groups[i].position.y = SECTION_Y[i] - THREE.MathUtils.smoothstep(dist, 0, 1.2) * 1.4;
    }
    const near = (i: number) => 1 - THREE.MathUtils.smoothstep(Math.abs(state.progress - i), .55, 1.3);
    for (const m of this.beauty) { m.uniforms.uTime.value = state.time; m.uniforms.uKey.value = this.key; }
    const shardM = this.shard.material as THREE.ShaderMaterial;
    shardM.uniforms.uFade.value = near(0) * state.fade; shardM.uniforms.uFacet.value = state.facet; shardM.uniforms.uCrack.value = state.crack;
    shardM.uniforms.uSpawn.value = state.crack * .55;
    this.shard.rotation.set(.15, state.time * .07, -.06);
    this.field.rotation.y = state.time * .03 + state.fieldSpin;
    const tr = this.traces.uniforms; tr.uTime.value = state.time; tr.uDpr.value = this.ratio; tr.uThreshold.value = state.threshold;
    tr.uScore.value = THREE.MathUtils.smoothstep(state.progress, 1.4, 2.1);
    this.glass.uniforms.uTime.value = state.time; this.glass.uniforms.uEngrave.value = state.engrave; this.glass.uniforms.uFade.value = near(2) * state.fade;
    const slabM = this.slab.material as THREE.ShaderMaterial;
    slabM.uniforms.uGrowth.value = state.growth; slabM.uniforms.uFade.value = near(3) * state.fade;
    const c = state.contour; slabM.uniforms.uContour.value.set(c?.x ?? 0, c?.y ?? 0, c?.z ?? 0, c?.r ?? 0);
    this.slab.rotation.y = state.time * .04;
    const incM = this.incumbent.material as THREE.ShaderMaterial; incM.uniforms.uFade.value = near(4) * state.fade;
    this.incumbent.rotation.set(.18, state.time * .06, -.08);
    if (state.candidateOffset) this.candidate.position.set(this.shift + state.candidateOffset.x, this.lift + state.candidateOffset.y, 0);
    else this.candidate.position.set(this.shift + Math.cos(state.candidateOrbit) * 2.0, this.lift + Math.sin(state.candidateOrbit * .7) * .5, Math.sin(state.candidateOrbit) * 1.0);
    this.candidate.rotation.set(.1, state.time * .2, 0);
    this.wire.uniforms.uDissolve.value = state.shatter;
    this.wire.uniforms.uOpacity.value = .85 * near(4) * (1 - state.shatter) * (1 - state.flare);
    this.land.uniforms.uTime.value = state.time; this.land.uniforms.uFade.value = state.fade;
    this.renderer.render(this.scene, this.camera);
  }

  dispose() { for (const d of this.disposables) d.dispose(); for (const m of this.materials) m.dispose(); this.renderer.dispose(); }
}

/** Facet id per vertex: cluster vertex normals into 16 bins of the shard's half-space normals (good enough for hover). */
function facetIds(geometry: THREE.BufferGeometry) {
  const n = geometry.attributes.normal as THREE.BufferAttribute, out = new Float32Array(n.count);
  const centres: THREE.Vector3[] = [];
  const v = new THREE.Vector3();
  for (let i = 0; i < n.count; i++) {
    v.fromBufferAttribute(n, i);
    let best = -1, bestDot = .92;
    centres.forEach((c, k) => { const dot = c.dot(v); if (dot > bestDot) { bestDot = dot; best = k; } });
    if (best < 0 && centres.length < 24) { centres.push(v.clone()); best = centres.length - 1; }
    out[i] = Math.max(0, best);
  }
  return out;
}
const latency = (i: number) => { const h = (k: number) => { const x = Math.sin(k * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); }; const u = Math.max(1e-4, h(i)), w = h(i * 1.7 + 9.2); const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(6.2831853 * w); return Math.round(Math.min(2400, Math.max(120, Math.exp(6.33 + z * .42)))); };

/** The eval, engraved into the glass. */
function evalTexture() {
  const c = document.createElement('canvas'); c.width = 1024; c.height = 640;
  const g = c.getContext('2d')!;
  g.fillStyle = '#000'; g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = '#fff'; g.font = "400 34px 'Commit Mono', monospace"; g.textBaseline = 'top';
  ["// evals/triage.ts", "export default eval('triage', ({ out, ref, ms }) =>", "  out.label === ref.label &&", "  out.owner in ref.team &&", "  ms < 800,", ")"].forEach((line, i) => g.fillText(line, 70, 120 + i * 60));
  const texture = new THREE.CanvasTexture(c); texture.flipY = true; return texture;
}

/** Hairline colony on the plain: domes (three latitude rings + a meridian), masts, a landing ring, one lit track; warm window lights. */
function colony(land: THREE.PlaneGeometry) {
  const lines: number[] = [], lights: number[] = [];
  const heightAt = (x: number, z: number) => { const r = Math.hypot(x, z); const h = fbm(x * .022 + 3.1, -z * .022, 1.7, 4) * 7 + Math.abs(fbm(x * .07, -z * .07 + 9, 4.2, 3)) * 2.2; return -13 + h * THREE.MathUtils.smoothstep(r, 6, 40) + Math.max(0, r - 90) * .05; };
  void land;
  const circle = (cx: number, cy: number, cz: number, r: number, ax: 'y' | 'z', n = 40) => { for (let i = 0; i < n; i++) { const a0 = i / n * Math.PI * 2, a1 = (i + 1) / n * Math.PI * 2; if (ax === 'y') lines.push(cx + Math.cos(a0) * r, cy, cz + Math.sin(a0) * r, cx + Math.cos(a1) * r, cy, cz + Math.sin(a1) * r); else lines.push(cx + Math.cos(a0) * r, cy + Math.sin(a0) * r, cz, cx + Math.cos(a1) * r, cy + Math.sin(a1) * r, cz); } };
  const dome = (x: number, z: number, r: number) => {
    const y = heightAt(x, z);
    for (const k of [.0, .45, .78]) circle(x, y + r * k, z, r * Math.sqrt(1 - k * k), 'y');
    for (let i = 0; i < 12; i++) { const a0 = i / 12 * Math.PI, a1 = (i + 1) / 12 * Math.PI; lines.push(x + Math.cos(a0) * r, y + Math.sin(a0) * r, z, x + Math.cos(a1) * r, y + Math.sin(a1) * r, z); }
    for (let i = 0; i < 5; i++) { const a = Math.random() * Math.PI * 2; lights.push(x + Math.cos(a) * r * .8, y + r * .25 + Math.random() * r * .3, z + Math.sin(a) * r * .8); }
  };
  const mast = (x: number, z: number, h: number) => { const y = heightAt(x, z); lines.push(x, y, z, x, y + h, z); lights.push(x, y + h, z); };
  for (const [x, z, r] of [[-38, -52, 6], [-30, -58, 4], [-46, -47, 3.2], [52, -40, 5], [58, -34, 3.4], [20, -70, 7], [27, -64, 3.6], [-60, 20, 4.5], [64, 30, 5.2], [-20, 72, 5.5], [-12, 66, 3]]) dome(x, z, r);
  for (const [x, z, h] of [[-24, -60, 11], [48, -50, 14], [10, -74, 9], [66, 22, 10], [-66, 12, 12], [-4, 78, 8]]) mast(x, z, h);
  const ring = (cx: number, cz: number, r: number) => circle(cx, heightAt(cx, cz) + .15, cz, r, 'y', 48);
  ring(36, -58, 5); ring(36, -58, 3.4);
  for (let i = 0; i < 60; i++) { const t0 = i / 60, t1 = (i + 1) / 60; const p = (t: number) => [THREE.MathUtils.lerp(-40, 36, t) + Math.sin(t * 6) * 4, THREE.MathUtils.lerp(-52, -58, t)] as const; const [x0, z0] = p(t0), [x1, z1] = p(t1); lines.push(x0, heightAt(x0, z0) + .1, z0, x1, heightAt(x1, z1) + .1, z1); if (i % 6 === 0) lights.push(x0, heightAt(x0, z0) + .3, z0); }
  const lg = new THREE.BufferGeometry(); lg.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
  const pg = new THREE.BufferGeometry(); pg.setAttribute('position', new THREE.Float32BufferAttribute(lights, 3));
  return { lines: lg, lights: pg };
}
