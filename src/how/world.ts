import * as THREE from 'three';
import * as shader from '../shaders';
import { steleGeometry, steleUniforms, steleVertexChunk, steleVertexShader, seamFragment } from './stele';
import { Landscape } from './landscape';
import { LivePasses, type PassIndex } from './passes';

/**
 * The /how world, v5: one fractured Martian stele at the origin over a fog-tinted colonised plain. The camera orbits it as the
 * title carousel turns; hovering lifts a facet and lights its seam; opening explodes the facets (vertex shader) around a glowing
 * core where a screen materialises with the current move's live render pass.
 */
export interface WorldState {
  time: number;
  /** Smoothed carousel position 0..4. */
  position: number;
  /** Which pass the screen shows, and how far the crossfade from the previous one has run. */
  pass: PassIndex; blend: number;
  pointer: { x: number; y: number };
  /** Smoothed pointer for the screen tilt and camera parallax. */
  tilt: { x: number; y: number };
  facet: number; lift: number;
  explode: number; reveal: number; core: number;
  fade: number;
  /** 1 = the stone has not formed yet (noise-discard), 0 = whole. */
  spawn: number;
}
export interface Hit { facet: number; point: THREE.Vector3; screen: boolean; distance: number }

const RADIUS = 5.6;
const YAW_PER_MOVE = .62;
const LOOK = new THREE.Vector3(0, .2, 0);

const screenFragment = /* glsl */`
precision highp float;
uniform sampler2D tPass;uniform float uReveal;uniform float uTime;uniform float uFog3;uniform vec3 uFog;
varying vec2 vUv;
${shader.noise}
void main(){
  float n=vnoise(vec3(vUv*7.,uTime*.25))*.5+vnoise(vec3(vUv*19.,-uTime*.4))*.5;
  float edge=uReveal*1.25-.12;
  if(n>edge)discard;
  vec3 c=texture2D(tPass,vUv).rgb;
  float rim=smoothstep(edge-.09,edge,n);
  c=mix(c,vec3(1.,.9,.8),rim*.85);
  float vig=smoothstep(.9,.35,length(vUv-.5));
  c*=.72+.28*vig;
  gl_FragColor=vec4(c,1.);
}`;
const withoutTime = (u: ReturnType<typeof steleUniforms>) => { const { uTime: _t, ...rest } = u; return rest; };
const screenVertex = /* glsl */`varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`;

export class HowWorld {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(34, 1, .1, 600);
  readonly landscape: Landscape;
  readonly passes: LivePasses;
  readonly facetCount: number;
  private readonly raycaster = new THREE.Raycaster();
  private readonly key = new THREE.Vector3(-.62, .5, .6).normalize();
  private readonly stele: THREE.Mesh;
  private readonly seams: THREE.LineSegments;
  private readonly screen: THREE.Mesh;
  private readonly core: THREE.Sprite;
  private readonly steleMaterial: THREE.ShaderMaterial;
  private readonly seamMaterial: THREE.ShaderMaterial;
  private readonly screenMaterial: THREE.ShaderMaterial;
  private readonly facetOfFace: Uint16Array;
  private readonly disposables: { dispose(): void }[] = [];
  private readonly mobile: boolean;

  constructor(canvas: HTMLCanvasElement, mobile: boolean) {
    this.mobile = mobile;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setClearColor(0x050407, 1);
    const detail = mobile ? 22 : 36;

    // terrain bake for the stele's beauty pass (same as home)
    const bake = new THREE.WebGLRenderTarget(mobile ? 1024 : 2048, mobile ? 512 : 1024, { type: THREE.HalfFloatType, depthBuffer: false, wrapS: THREE.RepeatWrapping, wrapT: THREE.ClampToEdgeWrapping, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    const quad = new THREE.PlaneGeometry(2, 2);
    const bakeMaterial = new THREE.ShaderMaterial({ vertexShader: shader.fullscreenVertex, fragmentShader: shader.bakeFragment, depthTest: false, depthWrite: false });
    const bakeScene = new THREE.Scene(); bakeScene.add(new THREE.Mesh(quad, bakeMaterial));
    this.renderer.setRenderTarget(bake); this.renderer.render(bakeScene, this.camera); this.renderer.setRenderTarget(null);
    bakeMaterial.dispose(); this.disposables.push(bake, quad);

    const stele = steleGeometry(detail);
    this.facetCount = stele.facetCount; this.facetOfFace = stele.facetOfFace;
    this.disposables.push(stele.body, stele.seams);
    this.steleMaterial = new THREE.ShaderMaterial({ vertexShader: steleVertexShader(shader.bodyVertex), fragmentShader: shader.beautyFragment, uniforms: {
      uMorph: { value: 0 }, uWordScale: { value: 1 }, uBox: { value: new THREE.Vector2(1, 1) }, tWord: { value: null }, uSpawn: { value: 0 },
      uTime: { value: 0 }, uFade: { value: 1 }, uGrowth: { value: 1 }, uContour: { value: new THREE.Vector4() }, tTerrain: { value: bake.texture },
      uTexel: { value: new THREE.Vector2(1 / bake.width, 1 / bake.height) }, uKey: { value: this.key }, ...withoutTime(steleUniforms()) } });
    this.stele = new THREE.Mesh(stele.body, this.steleMaterial);
    this.stele.frustumCulled = false;
    this.scene.add(this.stele);

    const declaresFacet = steleVertexChunk.includes('varying float vFacet');
    this.seamMaterial = new THREE.ShaderMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: `${steleVertexChunk}${declaresFacet ? '' : 'varying float vFacet;'}varying vec3 vN;void main(){vec3 n=normal;vec3 p=steleDisplace(position,n);vFacet=aFacet;vN=normalize(normalMatrix*n);gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.);}`,
      fragmentShader: seamFragment, uniforms: { ...steleUniforms(), uSeam: { value: .1 } } });
    this.seams = new THREE.LineSegments(stele.seams, this.seamMaterial);
    this.seams.frustumCulled = false;
    this.scene.add(this.seams);

    // the core: warm light inside the stone, only when it is open
    const glow = document.createElement('canvas'); glow.width = glow.height = 256;
    const ctx = glow.getContext('2d')!;
    const grad = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
    grad.addColorStop(0, 'rgba(255,226,200,1)'); grad.addColorStop(.25, 'rgba(255,170,120,.55)'); grad.addColorStop(.6, 'rgba(120,40,24,.18)'); grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad; ctx.fillRect(0, 0, 256, 256);
    const glowTexture = new THREE.CanvasTexture(glow);
    const coreMaterial = new THREE.SpriteMaterial({ map: glowTexture, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0 });
    this.core = new THREE.Sprite(coreMaterial); this.core.position.set(0, .15, 0); this.core.scale.setScalar(0); this.core.renderOrder = 1;
    this.scene.add(this.core); this.disposables.push(glowTexture, coreMaterial);

    // the screen: the move's live pass, materialising through noise
    this.passes = new LivePasses(this.renderer, mobile);
    this.screenMaterial = new THREE.ShaderMaterial({ vertexShader: screenVertex, fragmentShader: screenFragment, side: THREE.DoubleSide, uniforms: {
      tPass: { value: this.passes.texture }, uReveal: { value: 0 }, uTime: { value: 0 }, uFog3: { value: 0 }, uFog: { value: new THREE.Color() } } });
    const screenGeometry = new THREE.PlaneGeometry(mobile ? 1.5 : 2.1, mobile ? .94 : 1.3125);
    this.screen = new THREE.Mesh(screenGeometry, this.screenMaterial); this.screen.position.set(0, .15, 0); this.screen.visible = false; this.screen.renderOrder = 2;
    this.scene.add(this.screen); this.disposables.push(screenGeometry, this.screenMaterial, this.steleMaterial, this.seamMaterial);

    this.landscape = new Landscape(this.scene, mobile);
    this.resize();
  }

  resize() {
    const ratio = Math.min(devicePixelRatio || 1, this.mobile ? 1.5 : 2);
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(innerWidth, innerHeight, false);
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
  }

  /** Facet under the normalised pointer (−1..1), or the screen when open. */
  pick(x: number, y: number, open: boolean): Hit | null {
    this.raycaster.setFromCamera(new THREE.Vector2(x, y), this.camera);
    if (open) {
      const screen = this.raycaster.intersectObject(this.screen, false)[0];
      if (screen) return { facet: -1, point: screen.point, screen: true, distance: screen.distance };
      return null;
    }
    const hit = this.raycaster.intersectObject(this.stele, false)[0];
    if (!hit || hit.faceIndex == null) return null;
    return { facet: this.facetOfFace[hit.faceIndex], point: hit.point, screen: false, distance: hit.distance };
  }

  render(state: WorldState) {
    const yaw = state.position * YAW_PER_MOVE + state.tilt.x * .05;
    const height = .6 + state.tilt.y * .18 + Math.sin(state.position * Math.PI * .5) * .25;
    this.camera.position.set(Math.sin(yaw) * RADIUS, height, Math.cos(yaw) * RADIUS);
    this.camera.lookAt(LOOK);
    this.camera.rotateZ(-state.tilt.x * .004);

    const u = this.steleMaterial.uniforms;
    u.uTime.value = state.time; u.uFade.value = state.fade; u.uSpawn.value = state.spawn;
    u.uFacet.value = state.facet; u.uLift.value = state.lift; u.uExplode.value = state.explode;
    const s = this.seamMaterial.uniforms;
    s.uTime.value = state.time; s.uFacet.value = state.facet; s.uLift.value = state.lift; s.uExplode.value = state.explode;
    s.uSeam.value = (.06 + state.explode * .18) * (1 - state.spawn);
    this.stele.rotation.y = Math.sin(state.time * .05) * .04;
    this.seams.rotation.copy(this.stele.rotation);

    const core = state.core;
    (this.core.material as THREE.SpriteMaterial).opacity = core * (.55 + Math.sin(state.time * 1.7) * .06) * (1 - state.reveal * .45);
    this.core.scale.setScalar(core * (this.mobile ? 1.4 : 1.9));

    const visible = state.reveal > .001;
    this.screen.visible = visible;
    if (visible) {
      this.passes.render(state.pass, state.time, state.pointer, state.blend);
      this.screenMaterial.uniforms.uReveal.value = state.reveal;
      this.screenMaterial.uniforms.uTime.value = state.time;
      this.screen.rotation.set(-state.tilt.y * .16, yaw + state.tilt.x * .22, 0);
      this.screen.position.y = .15 + Math.sin(state.time * .8) * .02;
    }

    this.landscape.update(state.time, this.camera, this.key);
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.passes.dispose(); this.landscape.dispose();
    for (const d of this.disposables) d.dispose();
    this.renderer.dispose();
  }
}
