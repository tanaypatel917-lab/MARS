import * as THREE from 'three';
import * as shader from './shaders';
import { planetGeometry, wireGeometry } from './geometry';

export type Pass = 'wireframe' | 'observe' | 'evaluate' | 'refine' | 'beauty';
/** A panel's inner viewport in CSS pixels, measured from the top-left of the page. */
export interface PanelView { pass: Pass; x: number; y: number; w: number; h: number }
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
  spin: number;
  light: number;
  horizon: number;
  word: number;
  panels: PanelView[];
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
  private disposed = false;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.autoClear = false;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    const mobile = Math.min(innerWidth, innerHeight) < 700;
    const body = planetGeometry(mobile ? 22 : 36);
    const wire = wireGeometry(mobile ? 160 : 260);
    const shell = body.clone().scale(1.03, 1.03, 1.03);
    const quad = new THREE.PlaneGeometry(2, 2);
    this.disposables.push(body, wire, shell, quad);
    const material = (fragmentShader: string, uniforms: Record<string, THREE.IUniform> = {}, extra: THREE.ShaderMaterialParameters = {}) => {
      const m = new THREE.ShaderMaterial({ vertexShader: shader.bodyVertex, fragmentShader, uniforms, ...extra });
      this.disposables.push(m);
      return m;
    };
    const mesh = (geometry: THREE.BufferGeometry, m: THREE.Material, scene: THREE.Scene, track = true) => {
      const object = new THREE.Mesh(geometry, m);
      scene.add(object);
      if (track) this.bodies.push(object);
      return object;
    };
    this.wire = new THREE.ShaderMaterial({ vertexShader: shader.wireVertex, fragmentShader: shader.wireFragment, uniforms: { uReveal: { value: 1 }, uOpacity: { value: 1 } }, transparent: true, depthWrite: false });
    this.transmission = material(shader.transmissionFragment, { uTime: { value: 0 }, uRect: { value: new THREE.Vector4() } });
    const bake = new THREE.WebGLRenderTarget(mobile ? 1024 : 2048, mobile ? 512 : 1024, { type: THREE.HalfFloatType, depthBuffer: false, wrapS: THREE.RepeatWrapping, wrapT: THREE.ClampToEdgeWrapping, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    const bakeMaterial = new THREE.ShaderMaterial({ vertexShader: shader.fullscreenVertex, fragmentShader: shader.bakeFragment, depthTest: false, depthWrite: false });
    const bakeScene = new THREE.Scene();
    bakeScene.add(new THREE.Mesh(quad, bakeMaterial));
    this.renderer.setRenderTarget(bake);
    this.renderer.render(bakeScene, this.camera);
    this.renderer.setRenderTarget(null);
    bakeMaterial.dispose();
    this.disposables.push(bake);
    this.beauty = material(shader.beautyFragment, { uTime: { value: 0 }, uFade: { value: 1 }, tTerrain: { value: bake.texture }, uTexel: { value: new THREE.Vector2(1 / bake.width, 1 / bake.height) }, uKey: { value: this.key } });
    this.atmosphere = material(shader.atmosphereFragment, { uFade: { value: 1 }, uKey: { value: this.key } }, { transparent: true, side: THREE.BackSide, depthWrite: false, blending: THREE.AdditiveBlending });
    this.disposables.push(this.wire);
    const wireScene = new THREE.Scene();
    const lines = new THREE.LineSegments(wire, this.wire);
    wireScene.add(lines);
    this.bodies.push(lines);
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
      evaluate: this.single(body, material(shader.normalFragment), mesh),
      refine: refineScene,
      beauty: beautyScene,
    };
    const maskMaterial = new THREE.ShaderMaterial({ vertexShader: shader.bodyVertex, fragmentShader: shader.maskFragment });
    this.disposables.push(maskMaterial);
    mesh(body, maskMaterial, this.maskScene);
    this.mask = new THREE.WebGLRenderTarget(2, 2, { depthBuffer: true, format: THREE.RGBAFormat });
    this.disposables.push(this.mask);
    this.outline = new THREE.ShaderMaterial({
      vertexShader: shader.fullscreenVertex, fragmentShader: shader.outlineFragment, transparent: true, depthTest: false, depthWrite: false,
      uniforms: { tMask: { value: this.mask.texture }, uTexel: { value: new THREE.Vector2() }, uCenter: { value: new THREE.Vector2(.5, .5) }, uReveal: { value: 1 }, uOpacity: { value: 1 } },
    });
    this.disposables.push(this.outline);
    mesh(quad, this.outline, this.outlineScene, false).frustumCulled = false;
    this.voidMaterial = new THREE.ShaderMaterial({ vertexShader: shader.fullscreenVertex, fragmentShader: shader.voidFragment, depthTest: false, depthWrite: false,
      uniforms: { uPointer: { value: new THREE.Vector2(.5, .5) }, uAspect: { value: 1 }, uTime: { value: 0 }, uLight: { value: 0 }, uHorizon: { value: 0 }, uWord: { value: 0 }, tWord: { value: null } } });
    this.disposables.push(this.voidMaterial);
    mesh(quad, this.voidMaterial, this.voidScene, false).frustumCulled = false;
    this.resize();
  }

  private single(geometry: THREE.BufferGeometry, m: THREE.Material, mesh: (g: THREE.BufferGeometry, m: THREE.Material, s: THREE.Scene) => THREE.Mesh) {
    const scene = new THREE.Scene();
    mesh(geometry, m, scene);
    return scene;
  }

  resize() {
    const width = innerWidth, height = innerHeight;
    this.ratio = Math.min(devicePixelRatio || 1, 1.5, Math.sqrt(2_400_000 / (width * height)));
    this.renderer.setPixelRatio(this.ratio);
    this.renderer.setSize(width, height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    const portrait = width / height < 1;
    const fraction = portrait ? .78 * (width / height) : .64;
    const halfAngle = Math.atan(Math.tan(THREE.MathUtils.degToRad(15)) * fraction);
    this.camera.position.set(0, 0, 1.07 / Math.sin(halfAngle));
    this.camera.lookAt(0, 0, 0);
    this.camera.updateMatrixWorld();
    const w = Math.round(width * this.ratio), h = Math.round(height * this.ratio);
    this.mask.setSize(w, h);
    this.outline.uniforms.uTexel.value.set(1 / w, 1 / h);
  }

  render(state: FrameState) {
    if (this.disposed) return;
    const r = this.renderer;
    const drift = state.time * .05;
    this.key.set(-.62 + Math.sin(drift) * .25, .5 + Math.cos(drift * .7) * .12, .6).normalize();
    const spin = state.time * .04 + state.spin;
    const scale = 1 - state.settle * .14;
    for (const body of this.bodies) {
      body.rotation.set(.18 - state.pointer.y * .10, spin + state.pointer.x * .12, -.08);
      body.position.set(state.pointer.x * .03, state.settle * .16 + state.pointer.y * .02, 0);
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
    this.wire.uniforms.uReveal.value = state.wireReveal;
    this.wire.uniforms.uOpacity.value = state.wireOpacity;

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
      r.render(this.passes.beauty, this.camera);
    }
    if (state.rimGhost > .001 && state.beautyFade < .001) { this.setFade(state.rimGhost); r.render(this.rimScene, this.camera); }
    if (state.wireOpacity > .001 && state.wireReveal > 0) r.render(this.passes.wireframe, this.camera);
    const height = innerHeight;
    for (const panel of state.panels) {
      if (panel.w < 2 || panel.h < 2) continue;
      this.scissor.set(Math.round(panel.x * this.ratio), Math.round((height - panel.y - panel.h) * this.ratio), Math.round(panel.w * this.ratio), Math.round(panel.h * this.ratio));
      r.setScissorTest(true);
      r.setScissor(this.scissor);
      r.setClearColor(PASS_BACKGROUND[panel.pass], 1);
      r.clear(true, true, false);
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
    r.setScissorTest(false);
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
