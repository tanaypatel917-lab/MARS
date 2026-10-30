import * as THREE from 'three';
import * as shader from './shaders';
import { type Body, bodyPoint, fbm, planetGeometry, wireGeometry } from './geometry';

export type Pass = 'wireframe' | 'observe' | 'evaluate' | 'refine' | 'beauty';
/** A panel's inner viewport in CSS pixels, measured from the top-left of the page. */
export interface PanelView { pass: Pass; x: number; y: number; w: number; h: number; spawn: number }
export interface FrameState {
  time: number;
  outlineReveal: number;
  outlineOpacity: number;
  wireReveal: number;
  wireOpacity: number;
  beautyFade: number;
  /** Faint blue limb shown inside the outline while the planet is still unrendered. */
  rimGhost: number;
  /** 0..1: the finished planet settles up and slightly smaller to clear the waitlist. */
  settle: number;
  /** Pointer in -1..1 (x right, y up) and extra spin from scroll velocity. */
  pointer: { x: number; y: number };
  morph: number;
  /** Horizontal RGB split of the hairline in viewport fraction; follows scroll velocity (madrepunk). */
  split: number;
  spin: number;
  light: number;
  horizon: number;
  word: number;
  panels: PanelView[];
  /** Optional planet offset in world units and scale multiplier, for pages that keep the planet off-centre. */
  shift?: { x: number; y: number; scale: number };
  /** /how: relief grows from a smooth clay sphere (0) to the full terrain (1); the home page leaves it at 1. */
  growth?: number;
  /** /how: trace particles fall onto the planet, are scored (fails flung off) and the passes sink into the surface. */
  traces?: { fall: number; score: number; sink: number; count?: number; threshold?: number; ms?: Float32Array; born?: Float32Array };
  /** /how ascend 0..1: a wireframe candidate splits off the incumbent and collapses back into it. */
  twin?: number;
  /** Overrides the body's noise materialisation while the beauty pass fades in (home: (1 - beautyFade) * .9). */
  bodySpawn?: number;
  /** /how ascend: where the dragged candidate sits relative to the incumbent (world units), replacing the scripted arc. */
  twinOffset?: { x: number; y: number };
  /** /how ascend: the rejected candidate dissolves line by line (0..1). */
  shatter?: number;
  /** /how ascend: pointillist flare in the void at a screen uv when the candidate merges ({ x, y, t } with t 0..1). */
  flare?: { x: number; y: number; t: number };
  /** /how refine: Lando-style contour field on the body around an object-space point, radius in object units. */
  contour?: { x: number; y: number; z: number; r: number };
}

const BACKGROUND = new THREE.Color(0x050407);
const PASS_BACKGROUND: Record<Pass, THREE.Color> = {
  wireframe: new THREE.Color(0x070608),
  observe: new THREE.Color(0x0a0a0b),
  evaluate: new THREE.Color(0x08070d),
  refine: new THREE.Color(0x5a17b0),
  beauty: new THREE.Color(0x050407),
};

export class MarsScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly camera = new THREE.PerspectiveCamera(30, 1, .5, 30);
  private readonly bodies: THREE.Object3D[] = [];
  private readonly passes: Record<Pass, THREE.Scene>;
  private readonly maskScene = new THREE.Scene();
  private readonly outlineScene = new THREE.Scene();
  private readonly voidScene = new THREE.Scene();
  private readonly rimScene = new THREE.Scene();
  private readonly voidMaterial: THREE.ShaderMaterial;
  private readonly mask: THREE.WebGLRenderTarget;
  private readonly outline: THREE.ShaderMaterial;
  private readonly wire: THREE.ShaderMaterial;
  private readonly twin: THREE.LineSegments;
  private readonly twinScene = new THREE.Scene();
  private readonly traces: THREE.ShaderMaterial;
  private traceMs!: THREE.BufferAttribute;
  private traceBorn!: THREE.BufferAttribute;
  private lastMs?: Float32Array;
  private bornVersion = -1;
  /** Capacity of the trace particle pool. */
  traceCount = 0;
  private readonly raycaster = new THREE.Raycaster();
  private readonly tracesScene = new THREE.Scene();
  private readonly beauty: THREE.ShaderMaterial;
  private readonly atmosphere: THREE.ShaderMaterial;
  private readonly transmission: THREE.ShaderMaterial;
  private readonly dusk: THREE.Mesh;
  private readonly refineBackdrop: THREE.Mesh;
  private readonly disposables: { dispose(): void }[] = [];
  private readonly scissor = new THREE.Vector4();
  /** Key light in view space; it drifts slowly so the finished planet keeps living. */
  private readonly key = new THREE.Vector3(-.62, .5, .6);
  private ratio = 1;
  private fraction = .64;
  private disposed = false;
  private readonly spawn = { uSpawn: { value: 0 } };
  private readonly morph = { uMorph: { value: 0 }, uWordScale: { value: 1 }, uBox: { value: new THREE.Vector2(2, .5) }, tWord: { value: null as THREE.Texture | null } };
  private readonly bodyGeometries: THREE.BufferGeometry[] = [];
  readonly tier: 'full' | 'mid' | 'lite';
  private readonly dprCap: number;
  private readonly pixelBudget: number;

  constructor(canvas: HTMLCanvasElement, kind: Body = 'planet') {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.autoClear = false;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    const mobile = Math.min(innerWidth, innerHeight) < 700;
    this.tier = detectTier(this.renderer, mobile);
    const q = TIERS[this.tier];
    this.dprCap = q.dpr; this.pixelBudget = q.budget;
    const body = planetGeometry(q.detail, kind);
    const wire = wireGeometry(q.wire, kind);
    const shellScale = kind === 'shard' ? 1.018 : 1.03;
    const shell = body.clone().scale(shellScale, shellScale, shellScale);
    this.bodyGeometries.push(body, shell);
    for (const g of this.bodyGeometries) {
      g.setAttribute('aTarget', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 3), 3));
      g.setAttribute('aDelay', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count), 1));
    }
    const quad = new THREE.PlaneGeometry(2, 2);
    this.disposables.push(body, wire, shell, quad);
    const material = (fragmentShader: string, uniforms: Record<string, THREE.IUniform> = {}, extra: THREE.ShaderMaterialParameters = {}) => {
      const m = new THREE.ShaderMaterial({ vertexShader: shader.bodyVertex, fragmentShader, uniforms: { ...uniforms, ...this.morph, ...this.spawn }, ...extra });
      this.disposables.push(m);
      return m;
    };
    const mesh = (geometry: THREE.BufferGeometry, m: THREE.Material, scene: THREE.Scene, track = true) => {
      const object = new THREE.Mesh(geometry, m);
      scene.add(object);
      if (track) this.bodies.push(object);
      return object;
    };
    this.wire = new THREE.ShaderMaterial({ vertexShader: shader.wireVertex, fragmentShader: shader.wireFragment, uniforms: { uReveal: { value: 1 }, uOpacity: { value: 1 }, uDissolve: { value: 0 } }, transparent: true, depthWrite: false });
    this.transmission = material(shader.transmissionFragment, { uTime: { value: 0 }, uRect: { value: new THREE.Vector4() } });
    const bake = new THREE.WebGLRenderTarget(q.bake, q.bake / 2, { type: THREE.HalfFloatType, depthBuffer: false, wrapS: THREE.RepeatWrapping, wrapT: THREE.ClampToEdgeWrapping, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    const bakeMaterial = new THREE.ShaderMaterial({ vertexShader: shader.fullscreenVertex, fragmentShader: shader.bakeFragment, depthTest: false, depthWrite: false });
    const bakeScene = new THREE.Scene();
    bakeScene.add(new THREE.Mesh(quad, bakeMaterial));
    this.renderer.setRenderTarget(bake);
    this.renderer.render(bakeScene, this.camera);
    this.renderer.setRenderTarget(null);
    bakeMaterial.dispose();
    this.disposables.push(bake);
    this.beauty = material(shader.beautyFragment, { uTime: { value: 0 }, uFade: { value: 1 }, uGrowth: { value: 1 }, uContour: { value: new THREE.Vector4() }, tTerrain: { value: bake.texture }, uTexel: { value: new THREE.Vector2(1 / bake.width, 1 / bake.height) }, uKey: { value: this.key } });
    this.atmosphere = material(shader.atmosphereFragment, { uFade: { value: 1 }, uKey: { value: this.key } }, { transparent: true, side: THREE.BackSide, depthWrite: false, blending: THREE.AdditiveBlending });
    this.disposables.push(this.wire);
    const wireScene = new THREE.Scene();
    const lines = new THREE.LineSegments(wire, this.wire);
    wireScene.add(lines);
    this.bodies.push(lines);
    this.twin = new THREE.LineSegments(wire, this.wire);
    this.twinScene.add(this.twin);
    const count = mobile ? 900 : 2000;
    const dirs = new Float32Array(count * 3), lands = new Float32Array(count * 3), tangents = new Float32Array(count * 3), seeds = new Float32Array(count), ms = new Float32Array(count), index = new Float32Array(count);
    this.traceCount = count;
    const dir = new THREE.Vector3(), land = new THREE.Vector3(), tangent = new THREE.Vector3(), up = new THREE.Vector3();
    for (let i = 0; i < count; i++) {
      const u = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2, s = Math.sqrt(1 - u * u);
      dir.set(s * Math.cos(a), u, s * Math.sin(a)).toArray(dirs, i * 3);
      bodyPoint(kind, dir, land).toArray(lands, i * 3);
      tangent.crossVectors(dir, Math.abs(u) < .9 ? up.set(0, 1, 0) : up.set(1, 0, 0)).normalize().toArray(tangents, i * 3);
      seeds[i] = Math.random();
      ms[i] = 620; index[i] = i;
    }
    const traceGeometry = new THREE.BufferGeometry();
    traceGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    traceGeometry.setAttribute('aDir', new THREE.BufferAttribute(dirs, 3));
    traceGeometry.setAttribute('aLand', new THREE.BufferAttribute(lands, 3));
    traceGeometry.setAttribute('aTangent', new THREE.BufferAttribute(tangents, 3));
    traceGeometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
    this.traceMs = new THREE.BufferAttribute(ms, 1);
    traceGeometry.setAttribute('aMs', this.traceMs);
    this.traceBorn = new THREE.BufferAttribute(new Float32Array(count), 1);
    traceGeometry.setAttribute('aBorn', this.traceBorn);
    traceGeometry.setAttribute('aIndex', new THREE.BufferAttribute(index, 1));
    this.traces = new THREE.ShaderMaterial({ vertexShader: shader.tracesVertex, fragmentShader: shader.tracesFragment, uniforms: { uFall: { value: 0 }, uScore: { value: 0 }, uSink: { value: 0 }, uTime: { value: 0 }, uDpr: { value: 1 }, uRadius: { value: kind === 'shard' ? .72 : 1.0 }, uCount: { value: count }, uThreshold: { value: 800 } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const points = new THREE.Points(traceGeometry, this.traces);
    points.frustumCulled = false;
    this.tracesScene.add(points);
    this.bodies.push(points);
    this.disposables.push(traceGeometry, this.traces);
    const beautyScene = new THREE.Scene();
    const duskMaterial = new THREE.ShaderMaterial({ vertexShader: shader.fullscreenVertex, fragmentShader: shader.duskFragment, uniforms: { uRect: { value: new THREE.Vector4() } }, depthTest: false, depthWrite: false });
    this.disposables.push(duskMaterial);
    this.dusk = mesh(quad, duskMaterial, beautyScene, false);
    this.dusk.renderOrder = -1;
    this.dusk.frustumCulled = false;
    mesh(body, this.beauty, beautyScene);
    mesh(shell, this.atmosphere, beautyScene).renderOrder = 1;
    mesh(shell, this.atmosphere, this.rimScene);
    const refineScene = this.single(body, this.transmission, mesh);
    const refineBg = new THREE.ShaderMaterial({ vertexShader: shader.fullscreenVertex, fragmentShader: shader.refineFragment, uniforms: { uRect: { value: new THREE.Vector4() }, uTime: { value: 0 } }, depthTest: false, depthWrite: false });
    this.disposables.push(refineBg);
    this.refineBackdrop = mesh(quad, refineBg, refineScene, false);
    this.refineBackdrop.renderOrder = -1;
    this.refineBackdrop.frustumCulled = false;
    this.passes = {
      wireframe: wireScene,
      observe: this.single(body, material(shader.uvFragment), mesh),
      evaluate: this.single(body, material(shader.normalFragment, { tTerrain: { value: bake.texture } }), mesh),
      refine: refineScene,
      beauty: beautyScene,
    };
    const maskMaterial = new THREE.ShaderMaterial({ vertexShader: shader.bodyVertex, fragmentShader: shader.maskFragment, uniforms: { ...this.morph } });
    this.disposables.push(maskMaterial);
    mesh(body, maskMaterial, this.maskScene);
    this.mask = new THREE.WebGLRenderTarget(2, 2, { depthBuffer: true, format: THREE.RGBAFormat });
    this.disposables.push(this.mask);
    this.outline = new THREE.ShaderMaterial({
      vertexShader: shader.fullscreenVertex, fragmentShader: shader.outlineFragment, transparent: true, depthTest: false, depthWrite: false,
      uniforms: { tMask: { value: this.mask.texture }, uTexel: { value: new THREE.Vector2() }, uCenter: { value: new THREE.Vector2(.5, .5) }, uReveal: { value: 1 }, uOpacity: { value: 1 }, uSplit: { value: 0 } },
    });
    this.disposables.push(this.outline);
    mesh(quad, this.outline, this.outlineScene, false).frustumCulled = false;
    this.voidMaterial = new THREE.ShaderMaterial({ vertexShader: shader.fullscreenVertex, fragmentShader: shader.voidFragment, depthTest: false, depthWrite: false,
      uniforms: { uPointer: { value: new THREE.Vector2(.5, .5) }, uAspect: { value: 1 }, uTime: { value: 0 }, uLight: { value: 0 }, uHorizon: { value: 0 }, uWord: { value: 0 }, tWord: { value: null }, tMask: { value: this.mask.texture }, uFlare: { value: new THREE.Vector3() } } });
    this.disposables.push(this.voidMaterial);
    mesh(quad, this.voidMaterial, this.voidScene, false).frustumCulled = false;
    this.resize();
  }

  private single(geometry: THREE.BufferGeometry, m: THREE.Material, mesh: (g: THREE.BufferGeometry, m: THREE.Material, s: THREE.Scene) => THREE.Mesh) {
    const scene = new THREE.Scene();
    mesh(geometry, m, scene);
    return scene;
  }

  /** Object-space point on the body under a pointer in NDC (-1..1), or null. */
  pick(x: number, y: number): THREE.Vector3 | null {
    this.raycaster.setFromCamera(new THREE.Vector2(x, y), this.camera);
    const hit = this.raycaster.intersectObject(this.bodies[0], false)[0];
    return hit ? this.bodies[0].worldToLocal(hit.point.clone()) : null;
  }
  /** Screen position (px) of a world-space offset from the body's centre. */
  project(offsetX: number, offsetY: number) {
    const p = this.bodies[0].position.clone().add(new THREE.Vector3(offsetX, offsetY, 0)).project(this.camera);
    return { x: (p.x * .5 + .5) * innerWidth, y: (.5 - p.y * .5) * innerHeight };
  }
  /** World units per CSS pixel at the body's depth. */
  get unitsPerPixel() { return this.unitsPerHalfHeight / (innerHeight / 2); }

  /** World units spanned by half the viewport height at the planet's depth. */
  get unitsPerHalfHeight() { return 1.07 / this.fraction; }

  resize() {
    const width = innerWidth, height = innerHeight;
    this.ratio = Math.min(devicePixelRatio || 1, this.dprCap, Math.sqrt(this.pixelBudget / (width * height)));
    this.renderer.setPixelRatio(this.ratio);
    this.renderer.setSize(width, height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    const portrait = width / height < 1;
    const fraction = portrait ? .78 * (width / height) : .64;
    this.fraction = fraction;
    const halfAngle = Math.atan(Math.tan(THREE.MathUtils.degToRad(15)) * fraction);
    this.camera.position.set(0, 0, 1.07 / Math.sin(halfAngle));
    this.camera.lookAt(0, 0, 0);
    this.camera.updateMatrixWorld();
    const halfWidth = this.camera.position.z * Math.tan(THREE.MathUtils.degToRad(15)) * this.camera.aspect;
    this.morph.uWordScale.value = Math.min(1, halfWidth * .92 / (WORD_HALF_WIDTH * .56));
    const w = Math.round(width * this.ratio), h = Math.round(height * this.ratio);
    this.mask.setSize(w, h);
    this.outline.uniforms.uTexel.value.set(1 / w, 1 / h);
  }

  render(state: FrameState) {
    this.morph.uMorph.value = state.morph;
    if (this.disposed) return;
    const r = this.renderer;
    const drift = state.time * .05;
    this.key.set(-.62 + Math.sin(drift) * .25, .5 + Math.cos(drift * .7) * .12, .6).normalize();
    const spin = state.time * .04 + state.spin;
    const scale = (1 - state.settle * .14) * (state.shift?.scale ?? 1);
    const sx = state.shift?.x ?? 0, sy = state.shift?.y ?? 0;
    this.outline.uniforms.uCenter.value.set(.5 + sx / (2 * this.unitsPerHalfHeight * this.camera.aspect), .5 + sy / (2 * this.unitsPerHalfHeight));
    for (const body of this.bodies) {
      const settle = 1 - THREE.MathUtils.smoothstep(state.morph, 0, .28);
      body.rotation.set((.18 - state.pointer.y * .10) * settle, (spin + state.pointer.x * .12) * settle, -.08 * settle);
      body.position.set(state.pointer.x * .03 + sx, state.settle * .16 + state.pointer.y * .02 + sy, 0);
      body.scale.setScalar(scale);
      body.updateMatrixWorld();
    }
    const v = this.voidMaterial.uniforms;
    v.uPointer.value.set(state.pointer.x * .5 + .5, state.pointer.y * .5 + .5);
    v.uAspect.value = this.camera.aspect;
    v.uTime.value = state.time;
    v.uLight.value = state.light;
    v.uHorizon.value = state.horizon;
    v.uWord.value = this.voidMaterial.uniforms.tWord.value ? state.word : 0;
    this.transmission.uniforms.uTime.value = state.time;
    this.beauty.uniforms.uTime.value = state.time;
    this.beauty.uniforms.uGrowth.value = state.growth ?? 1;
    const ct = state.contour; this.beauty.uniforms.uContour.value.set(ct?.x ?? 0, ct?.y ?? 0, ct?.z ?? 0, ct?.r ?? 0);
    this.voidMaterial.uniforms.uFlare.value.set(state.flare?.x ?? 0, state.flare?.y ?? 0, state.flare?.t ?? 0);
    this.wire.uniforms.uReveal.value = state.wireReveal;
    this.wire.uniforms.uOpacity.value = state.wireOpacity;
    this.wire.uniforms.uDissolve.value = 0;

    r.setRenderTarget(this.mask);
    r.setScissorTest(false);
    r.setClearColor(0x000000, 1);
    r.clear(true, true, false);
    r.render(this.maskScene, this.camera);
    r.setRenderTarget(null);
    r.setClearColor(BACKGROUND, 1);
    r.clear(true, true, false);
    r.render(this.voidScene, this.camera);
    if (state.beautyFade > .001) {
      this.setFade(state.beautyFade);
      this.dusk.visible = false;
      this.spawn.uSpawn.value = state.bodySpawn ?? (1 - state.beautyFade) * .9;
      r.render(this.passes.beauty, this.camera);
      this.spawn.uSpawn.value = 0;
    }
    if (state.rimGhost > .001 && state.beautyFade < .001) { this.setFade(state.rimGhost); r.render(this.rimScene, this.camera); }
    if (state.wireOpacity > .001 && state.wireReveal > 0) r.render(this.passes.wireframe, this.camera);
    if (state.traces && state.traces.fall > .001) {
      const u = this.traces.uniforms;
      u.uFall.value = state.traces.fall; u.uScore.value = state.traces.score; u.uSink.value = state.traces.sink;
      u.uCount.value = state.traces.count ?? this.traceCount; u.uThreshold.value = state.traces.threshold ?? 800;
      if (state.traces.ms && state.traces.ms !== this.lastMs) { this.lastMs = state.traces.ms; (this.traceMs.array as Float32Array).set(state.traces.ms.subarray(0, this.traceCount)); this.traceMs.needsUpdate = true; }
      if (state.traces.born && (state.traces.count ?? 0) !== this.bornVersion) { this.bornVersion = state.traces.count ?? 0; (this.traceBorn.array as Float32Array).set(state.traces.born.subarray(0, this.traceCount)); this.traceBorn.needsUpdate = true; }
      u.uTime.value = state.time; u.uDpr.value = this.ratio;
      r.render(this.tracesScene, this.camera);
    }
    if (state.twin && state.twin > .001) {
      const arc = Math.sin(state.twin * Math.PI);
      const first = this.bodies[0];
      this.twin.rotation.copy(first.rotation);
      this.twin.scale.copy(first.scale).multiplyScalar(state.twinOffset ? .55 : 1 - arc * .2);
      this.twin.position.copy(first.position);
      if (state.twinOffset) { this.twin.position.x += state.twinOffset.x; this.twin.position.y += state.twinOffset.y; }
      else { this.twin.position.x -= arc * 1.8 * first.scale.x; this.twin.position.y += arc * .22 * first.scale.x; }
      this.twin.updateMatrixWorld();
      this.wire.uniforms.uReveal.value = 1;
      this.wire.uniforms.uDissolve.value = state.shatter ?? 0;
      this.wire.uniforms.uOpacity.value = (state.twinOffset ? Math.min(1, state.twin * 3) : Math.min(1, arc * 1.6)) * .85 * (1 - (state.shatter ?? 0));
      r.render(this.twinScene, this.camera);
    }
    const height = innerHeight;
    for (const panel of state.panels) {
      if (panel.w < 2 || panel.h < 2) continue;
      // three multiplies setScissor() by the pixel ratio itself; shaders reading gl_FragCoord need device pixels.
      r.setScissorTest(true);
      r.setScissor(panel.x, height - panel.y - panel.h, panel.w, panel.h);
      this.scissor.set(Math.round(panel.x * this.ratio), Math.round((height - panel.y - panel.h) * this.ratio), Math.round(panel.w * this.ratio), Math.round(panel.h * this.ratio));
      r.setClearColor(PASS_BACKGROUND[panel.pass], 1);
      r.clear(true, true, false);
      this.spawn.uSpawn.value = panel.spawn;
      if (panel.pass === 'beauty') {
        this.setFade(1);
        this.dusk.visible = true;
        (this.dusk.material as THREE.ShaderMaterial).uniforms.uRect.value.copy(this.scissor);
      }
      if (panel.pass === 'wireframe') { this.wire.uniforms.uReveal.value = 1; this.wire.uniforms.uOpacity.value = 1; }
      if (panel.pass === 'refine') {
        this.transmission.uniforms.uRect.value.copy(this.scissor);
        const bg = (this.refineBackdrop.material as THREE.ShaderMaterial).uniforms;
        bg.uRect.value.copy(this.scissor);
        bg.uTime.value = state.time;
      }
      r.render(this.passes[panel.pass], this.camera);
    }
    this.spawn.uSpawn.value = 0;
    r.setScissorTest(false);
    this.outline.uniforms.uSplit.value = state.split;
    this.outline.uniforms.uReveal.value = state.outlineReveal;
    this.outline.uniforms.uOpacity.value = state.outlineOpacity;
    if (state.outlineOpacity > .001 && state.outlineReveal > 0) r.render(this.outlineScene, this.camera);
  }

  /** A Canvas2D wordmark that the void pass reveals under the pointer light, after Guillaume's masked title. */
  setWordmark(text: string, font: string) {
    const canvas = document.createElement('canvas');
    canvas.width = 2048; canvas.height = 512;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.fillStyle = '#000';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#fff';
    context.font = font;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(text, canvas.width / 2, canvas.height / 2 + 14);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.NoColorSpace;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.anisotropy = Math.min(4, this.renderer.capabilities.getMaxAnisotropy());
    this.disposables.push(texture);
    this.voidMaterial.uniforms.tWord.value = texture;
    this.morph.tWord.value = texture;
    this.assignTargets(context.getImageData(0, 0, canvas.width, canvas.height));
  }

  /**
   * Each body vertex is projected onto the wordmark's bounding box and pulled to the nearest point inside a glyph
   * (its own projection when that lands on ink, otherwise the closest point of the nearest inked cell), so neighbouring
   * vertices keep their order and the letters form without ridges. aDelay staggers the flow left to right.
   */
  private assignTargets(image: ImageData) {
    const cols = 192, rows = 48;
    const halfWidth = WORD_HALF_WIDTH, halfHeight = halfWidth * image.height / image.width;
    const filled: number[] = [];
    const ink = new Uint8Array(cols * rows);
    let minC = cols, maxC = -1, minR = rows, maxR = -1;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const x = Math.floor((c + .5) / cols * image.width), y = Math.floor((r + .5) / rows * image.height);
      if (image.data[(y * image.width + x) * 4] > 128) {
        filled.push(c, r);
        ink[r * cols + c] = 1;
        minC = Math.min(minC, c); maxC = Math.max(maxC, c); minR = Math.min(minR, r); maxR = Math.max(maxR, r);
      }
    }
    if (!filled.length) return;
    const nearest = new Int32Array(cols * rows);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      let best = 0, bestDistance = Infinity;
      for (let i = 0; i < filled.length; i += 2) {
        const d = (filled[i] - c) ** 2 + (filled[i + 1] - r) ** 2;
        if (d < bestDistance) { bestDistance = d; best = i; }
      }
      nearest[r * cols + c] = best;
    }
    const u0 = minC / cols, u1 = (maxC + 1) / cols, v0 = minR / rows, v1 = (maxR + 1) / rows;
    this.morph.uBox.value.set((u1 - u0) * halfWidth, (v1 - v0) * halfHeight);
    for (const geometry of this.bodyGeometries) {
      const position = geometry.attributes.position as THREE.BufferAttribute;
      const target = geometry.attributes.aTarget as THREE.BufferAttribute;
      const delay = geometry.attributes.aDelay as THREE.BufferAttribute;
      for (let i = 0; i < position.count; i++) {
        const px = THREE.MathUtils.clamp(position.getX(i) * SPREAD, -1, 1) * .5 + .5, py = THREE.MathUtils.clamp(position.getY(i) / 1.07 * SPREAD, -1, 1) * .5 + .5;
        const cc = THREE.MathUtils.clamp((u0 + px * (u1 - u0)) * cols, 0, cols - 1e-3), rr = THREE.MathUtils.clamp((v1 - py * (v1 - v0)) * rows, 0, rows - 1e-3);
        const ci = Math.floor(cc), ri = Math.floor(rr);
        let tx = cc, ty = rr;
        if (!ink[ri * cols + ci]) {
          const cell = nearest[ri * cols + ci];
          tx = THREE.MathUtils.clamp(cc, filled[cell] + .05, filled[cell] + .95);
          ty = THREE.MathUtils.clamp(rr, filled[cell + 1] + .05, filled[cell + 1] + .95);
        }
        const drift = fbm(position.getX(i) * 1.8 + 5.2, position.getY(i) * 1.8, position.getZ(i) * 1.8, 3) * .5 + .5;
        target.setXYZ(i, (tx / cols - .5) * 2 * halfWidth, (.5 - ty / rows) * 2 * halfHeight, position.getZ(i) * .12);
        delay.setX(i, THREE.MathUtils.clamp((tx / cols - u0) / (u1 - u0), 0, 1) * .82 + drift * .18);
      }
      target.needsUpdate = true;
      delay.needsUpdate = true;
    }
  }

  /** Compile every material once so the intro never hitches on first use. */
  warm() {
    const r = this.renderer;
    r.setScissorTest(true);
    r.setScissor(0, 0, 2, 2);
    for (const pass of Object.values(this.passes)) r.render(pass, this.camera);
    r.render(this.maskScene, this.camera);
    r.render(this.outlineScene, this.camera);
    r.render(this.voidScene, this.camera);
    r.render(this.rimScene, this.camera);
    r.setScissorTest(false);
    r.clear();
  }

  private setFade(value: number) {
    this.beauty.uniforms.uFade.value = value;
    this.atmosphere.uniforms.uFade.value = value;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const item of this.disposables) item.dispose();
    this.renderer.dispose();
  }
}

const TIERS = {
  full: { detail: 36, wire: 260, bake: 2048, dpr: 1.5, budget: 2_400_000 },
  mid: { detail: 26, wire: 200, bake: 1536, dpr: 1.25, budget: 1_800_000 },
  lite: { detail: 18, wire: 140, bake: 1024, dpr: 1, budget: 1_200_000 },
} as const;

/** Pick a quality tier from the GPU string and screen size (the way unbelievablycrap serves a full and a lite scan). */
function detectTier(renderer: THREE.WebGLRenderer, mobile: boolean): keyof typeof TIERS {
  const forced = new URLSearchParams(location.search).get('tier');
  if (forced && forced in TIERS) return forced as keyof typeof TIERS;
  const gl = renderer.getContext();
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  const gpu = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : '';
  if (/swiftshader|llvmpipe|softpipe|software/i.test(gpu)) return 'lite';
  if (mobile || /intel\(r\) (hd|uhd) graphics [456]\d\d|mali-[gt][0-9]{2}\b|adreno \(tm\) [1-5]/i.test(gpu)) return 'mid';
  return 'full';
}

/** Half-width of the wordmark plane in planet radii; the glyphs cover ~56% of it. Keep in sync with vWordUv in bodyVertex (7.2 = 2× this, 1.8 = 2× this × 512/2048). */
const WORD_HALF_WIDTH = 3.6;
/** The planet's projection is enlarged by this before it is clamped to the word box, so its triangles also reach the box corners (M's and S's outer strokes). */
const SPREAD = 1.5;
