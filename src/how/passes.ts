import * as THREE from 'three';
import * as shader from '../shaders';
import { planetGeometry, wireGeometry } from '../geometry';

/**
 * The five live render passes shown on the screen inside the opened stele. Each pass is a small self-contained scene on
 * black, lit by the same drifting key as the rest of the site, rendered every frame into a 16:10 render target. A move
 * change crossfades: while `blend` < 1 the previous pass keeps living in a second target and a fullscreen quad mixes it over.
 */
export type PassIndex = 0 | 1 | 2 | 3 | 4; // the loop · observe · evaluate · refine · ascend

interface Pointer { x: number; y: number }
interface Pass {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  /** `elapsed` is the time since this pass became the current one. */
  update(time: number, elapsed: number, pointer: Pointer): void;
}

const ASPECT = 1.6;
const KEY = new THREE.Vector3(-.62, .5, .6);
const clamp01 = (t: number) => Math.min(1, Math.max(0, t));
const easeInOut = (t: number) => { t = clamp01(t); return t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; };
const easeOut = (t: number) => 1 - Math.pow(1 - clamp01(t), 3);
/** Lusion's cubic-bezier(.35,0,0,1) feel: slow in, long settle. */
const settle = (t: number) => 1 - Math.pow(1 - clamp01(t), 4);

export class LivePasses {
  /** Display-ready colour (the shaders gamma-encode themselves): sample it raw in a ShaderMaterial, or render it through a renderer whose outputColorSpace is linear. */
  readonly texture: THREE.Texture;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly out: THREE.WebGLRenderTarget;
  private readonly prev: THREE.WebGLRenderTarget;
  private readonly passes: Pass[] = [];
  private readonly key = KEY.clone().normalize();
  private readonly beauty: THREE.ShaderMaterial[] = [];
  private readonly disposables: { dispose(): void }[] = [];
  private readonly fadeScene = new THREE.Scene();
  private readonly fadeMaterial: THREE.ShaderMaterial;
  private readonly savedClear = new THREE.Color();
  private readonly pointer = { x: 0, y: 0 };
  private readonly enteredAt = [0, 0, 0, 0, 0];
  private current: PassIndex | null = null;
  private previous: PassIndex | null = null;
  private lastTime = -1;

  constructor(renderer: THREE.WebGLRenderer, mobile: boolean) {
    this.renderer = renderer;
    const width = mobile ? 512 : 768, height = mobile ? 320 : 480;
    const rt = () => new THREE.WebGLRenderTarget(width, height, { depthBuffer: true, stencilBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false });
    this.out = rt(); this.prev = rt();
    this.texture = this.out.texture;
    this.disposables.push(this.out, this.prev);
    const detail = mobile ? 22 : 36;
    const rand = seeded(7.3);

    // terrain bake shared by every beauty-shaded body (the screen is small; half the world's resolution is plenty)
    const bake = new THREE.WebGLRenderTarget(mobile ? 512 : 1024, mobile ? 256 : 512, { type: THREE.HalfFloatType, depthBuffer: false, wrapS: THREE.RepeatWrapping, wrapT: THREE.ClampToEdgeWrapping, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    const quad = new THREE.PlaneGeometry(2, 2);
    const bakeMaterial = new THREE.ShaderMaterial({ vertexShader: shader.fullscreenVertex, fragmentShader: shader.bakeFragment, depthTest: false, depthWrite: false });
    const bakeScene = new THREE.Scene(); bakeScene.add(new THREE.Mesh(quad, bakeMaterial));
    const bakeCamera = new THREE.PerspectiveCamera();
    const saved = renderer.getRenderTarget();
    renderer.setRenderTarget(bake); renderer.render(bakeScene, bakeCamera); renderer.setRenderTarget(saved);
    bakeMaterial.dispose(); this.disposables.push(bake, quad);

    const morph = () => ({ uMorph: { value: 0 }, uWordScale: { value: 1 }, uBox: { value: new THREE.Vector2(1, 1) }, tWord: { value: null }, uSpawn: { value: 0 } });
    const beautyMaterial = () => {
      const m = new THREE.ShaderMaterial({ vertexShader: shader.bodyVertex, fragmentShader: shader.beautyFragment, uniforms: {
        ...morph(), uTime: { value: 0 }, uFade: { value: 1 }, uGrowth: { value: 1 }, uContour: { value: new THREE.Vector4() }, tTerrain: { value: bake.texture },
        uTexel: { value: new THREE.Vector2(1 / bake.width, 1 / bake.height) }, uKey: { value: this.key } } });
      this.beauty.push(m); this.disposables.push(m); return m;
    };
    const body = (geometry: THREE.BufferGeometry) => {
      geometry.setAttribute('aTarget', new THREE.BufferAttribute(new Float32Array(geometry.attributes.position.count * 3), 3));
      geometry.setAttribute('aDelay', new THREE.BufferAttribute(new Float32Array(geometry.attributes.position.count), 1));
      this.disposables.push(geometry); return geometry;
    };
    const camera = (x: number, y: number, z: number) => { const c = new THREE.PerspectiveCamera(30, ASPECT, .1, 60); c.position.set(x, y, z); c.lookAt(0, 0, 0); return c; };
    const dpr = width / 768 * 1.3;

    // 0 · the loop: the home page's Mars, slowly turning under the drifting key, blue limb from the back-facing shell
    {
      const scene = new THREE.Scene();
      const planetGeo = body(planetGeometry(detail, 'planet'));
      const shellGeo = planetGeo.clone().scale(1.03, 1.03, 1.03); this.disposables.push(shellGeo);
      const atmosphere = new THREE.ShaderMaterial({ vertexShader: shader.bodyVertex, fragmentShader: shader.atmosphereFragment, uniforms: { ...morph(), uFade: { value: 1 }, uKey: { value: this.key } }, transparent: true, side: THREE.BackSide, depthWrite: false, blending: THREE.AdditiveBlending });
      this.disposables.push(atmosphere);
      const planet = new THREE.Mesh(planetGeo, beautyMaterial());
      const shell = new THREE.Mesh(shellGeo, atmosphere); shell.renderOrder = 1;
      const group = new THREE.Group(); group.add(planet, shell); scene.add(group);
      this.passes[0] = { scene, camera: camera(0, 0, 5.7), update: (time, _elapsed, pointer) => {
        group.rotation.set(.18 - pointer.y * .07, time * .045 + pointer.x * .1, -.08);
        group.position.set(pointer.x * .04, pointer.y * .03, 0);
      } };
    }

    // 1 · observe: the trace field, a flattened cloud of runs, turning; the pointer tilts it
    {
      const scene = new THREE.Scene();
      const count = mobile ? 900 : 2000;
      const geometry = traceGeometry(count, rand); this.disposables.push(geometry);
      const material = tracesMaterial(count, dpr); this.disposables.push(material);
      material.uniforms.uFall.value = 1;
      const field = new THREE.Points(geometry, material); field.frustumCulled = false; field.scale.setScalar(.56);
      const tilt = new THREE.Group(); tilt.add(field); scene.add(tilt);
      this.passes[1] = { scene, camera: camera(0, 0, 7.2), update: (time, elapsed, pointer) => {
        material.uniforms.uTime.value = time;
        const arrive = settle(elapsed / 2.2);
        field.rotation.y = time * .06 + (1 - arrive) * .6;
        field.scale.setScalar(.56 * (.86 + .14 * arrive));
        tilt.rotation.set(.42 + pointer.y * .28, 0, -pointer.x * .22);
      } };
    }

    // 2 · evaluate: the glass with the engraved eval; the pass set streams through it, is scored, and the fails are flung
    {
      const scene = new THREE.Scene();
      const glassGeo = new THREE.PlaneGeometry(2.8, 1.7, 1, 1); this.disposables.push(glassGeo);
      const evalTex = evalTexture(); this.disposables.push(evalTex);
      const glass = new THREE.ShaderMaterial({ vertexShader: shader.glassVertex, fragmentShader: shader.glassFragment, uniforms: { uTime: { value: 0 }, uEngrave: { value: 0 }, tText: { value: evalTex }, uFade: { value: 1 } }, transparent: true, depthWrite: false, side: THREE.DoubleSide });
      this.disposables.push(glass);
      const sieve = new THREE.Mesh(glassGeo, glass);
      const count = mobile ? 600 : 1400;
      const geometry = traceGeometry(count, rand); this.disposables.push(geometry);
      const material = tracesMaterial(count, dpr); this.disposables.push(material);
      const set = new THREE.Points(geometry, material); set.frustumCulled = false; set.scale.setScalar(.26); set.position.set(1.0, -.1, 0); set.renderOrder = 2;
      const stream = new THREE.Group(); stream.add(set);
      const frame = new THREE.Group(); frame.rotation.y = .38; frame.add(sieve, stream); scene.add(frame);
      const cam = camera(0, .25, 4.9);
      const T = 6.5;
      this.passes[2] = { scene, camera: cam, update: (time, elapsed, pointer) => {
        glass.uniforms.uTime.value = time;
        glass.uniforms.uEngrave.value = settle((elapsed - .25) / 1.6);
        frame.rotation.y = .38 + pointer.x * .08; frame.rotation.x = -pointer.y * .05;
        const p = ((elapsed + T * .32) % T) / T;
        // fall in behind the glass, cross it, get scored at the crossing, then the pass set sinks away and the cycle restarts
        stream.position.z = THREE.MathUtils.lerp(-2.6, 1.9, p);
        set.rotation.y = time * .25;
        const u = material.uniforms;
        u.uTime.value = time;
        u.uFall.value = clamp01(p / .22);
        u.uScore.value = THREE.MathUtils.smoothstep(p, .5, .7);
        u.uSink.value = THREE.MathUtils.smoothstep(p, .86, .98);
      } };
    }

    // 3 · refine: the slab, whose terrain grows in over six seconds while a contour ring surveys its surface
    {
      const scene = new THREE.Scene();
      const slabGeo = body(planetGeometry(detail, 'shard'));
      const material = beautyMaterial();
      const slab = new THREE.Mesh(slabGeo, material); slab.scale.set(1.5, .55, 1.1); scene.add(slab);
      const contour = new THREE.Vector3();
      this.passes[3] = { scene, camera: camera(0, 1.5, 5.5), update: (time, elapsed, pointer) => {
        material.uniforms.uGrowth.value = easeInOut((elapsed - .2) / 6);
        const a = time * .55;
        contour.set(Math.cos(a), .25 + Math.sin(a * .7) * .3, Math.sin(a)).normalize();
        material.uniforms.uContour.value.set(contour.x, contour.y, contour.z, .42 * settle(elapsed / 1.5));
        slab.rotation.set(.25 - pointer.y * .06, time * .05 + pointer.x * .08, 0);
      } };
    }

    // 4 · ascend: the incumbent shard with a wire candidate orbiting; every ~5 s the candidate flies in, merges with a flash, and a new one is drawn
    {
      const scene = new THREE.Scene();
      const shardGeo = body(planetGeometry(detail, 'shard'));
      const material = beautyMaterial();
      const incumbent = new THREE.Mesh(shardGeo, material); incumbent.scale.setScalar(1.08); scene.add(incumbent);
      const wireGeo = wireGeometry(mobile ? 160 : 260, 'shard'); this.disposables.push(wireGeo);
      const wire = new THREE.ShaderMaterial({ vertexShader: shader.wireVertex, fragmentShader: shader.wireFragment, uniforms: { uReveal: { value: 1 }, uOpacity: { value: .85 }, uDissolve: { value: 0 } }, transparent: true, depthWrite: false });
      this.disposables.push(wire);
      const candidate = new THREE.LineSegments(wireGeo, wire); scene.add(candidate);
      const flash = new THREE.ShaderMaterial({ vertexShader: shader.fullscreenVertex, fragmentShader: 'uniform float uFlash;void main(){gl_FragColor=vec4(vec3(.93,.89,.82)*uFlash,uFlash);}', uniforms: { uFlash: { value: 0 } }, transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending });
      this.disposables.push(flash);
      const flashQuad = new THREE.Mesh(quad, flash); flashQuad.frustumCulled = false; flashQuad.renderOrder = 3; scene.add(flashQuad);
      const orbit = new THREE.Vector3();
      const T = 5.2, MERGE = .72;
      this.passes[4] = { scene, camera: camera(0, .45, 7.0), update: (time, elapsed, pointer) => {
        incumbent.rotation.set(.18 - pointer.y * .06, time * .06 + pointer.x * .08, -.08);
        const p = (elapsed % T) / T;
        const a = time * .62;
        orbit.set(Math.cos(a) * 1.75, Math.sin(a * .7) * .42, Math.sin(a) * .95);
        const since = p >= MERGE ? (p - MERGE) * T : -1; // seconds since the merge, −1 before it
        const reborn = since >= .7;
        const approach = reborn ? 0 : easeInOut((p - .5) / (MERGE - .5));
        candidate.position.copy(orbit).multiplyScalar(1 - approach);
        candidate.scale.setScalar(THREE.MathUtils.lerp(.7, 1.08, approach));
        candidate.rotation.set(THREE.MathUtils.lerp(.1, .18, approach), THREE.MathUtils.lerp(time * .22, incumbent.rotation.y, approach), -.08 * approach);
        const u = wire.uniforms;
        u.uDissolve.value = since < 0 || reborn ? 0 : Math.min(1, since / .45);
        u.uOpacity.value = since < 0 || reborn ? .85 : .85 * (1 - clamp01(since / .4));
        u.uReveal.value = reborn ? easeOut((since - .7) / .7) : 1;
        const burst = since < 0 ? 0 : Math.exp(-since * 6.5);
        flash.uniforms.uFlash.value = burst * .22;
        material.uniforms.uFade.value = 1 + burst * .55;
      } };
    }

    this.fadeMaterial = new THREE.ShaderMaterial({ vertexShader: shader.fullscreenVertex, fragmentShader: 'uniform sampler2D tPrev;uniform float uBlend;varying vec2 vUv;void main(){vec4 p=texture2D(tPrev,vUv);gl_FragColor=vec4(p.rgb,p.a*(1.-uBlend));}', uniforms: { tPrev: { value: this.prev.texture }, uBlend: { value: 1 } }, transparent: true, depthTest: false, depthWrite: false });
    const fadeQuad = new THREE.Mesh(quad, this.fadeMaterial); fadeQuad.frustumCulled = false; this.fadeScene.add(fadeQuad);
    this.disposables.push(this.fadeMaterial);
  }

  /** The pass to crossfade from while `blend` < 1. */
  setPrevious(index: PassIndex) { this.previous = index; }

  /** Renders pass `index` into `texture` (mixed with the previous pass by `blend`); leaves the renderer's target and clear state as it found them. */
  render(index: PassIndex, time: number, pointer: Pointer, blend: number) {
    const r = this.renderer;
    if (index !== this.current) { this.current = index; this.enteredAt[index] = time; }
    const dt = this.lastTime < 0 ? 0 : Math.min(.1, Math.max(0, time - this.lastTime)); this.lastTime = time;
    const k = 1 - Math.exp(-dt * 6);
    this.pointer.x += (pointer.x - this.pointer.x) * k; this.pointer.y += (pointer.y - this.pointer.y) * k;
    const drift = time * .05;
    this.key.set(-.62 + Math.sin(drift) * .25, .5 + Math.cos(drift * .7) * .12, .6).normalize();
    for (const m of this.beauty) m.uniforms.uTime.value = time;

    const savedTarget = r.getRenderTarget(), savedAutoClear = r.autoClear, savedScissor = r.getScissorTest(), savedAlpha = r.getClearAlpha();
    r.getClearColor(this.savedClear);
    r.setScissorTest(false); r.setClearColor(0x000000, 0); r.autoClear = true;
    const fading = blend < 1 && this.previous !== null && this.previous !== index;
    if (fading) this.draw(this.previous!, time, this.prev);
    this.draw(index, time, this.out);
    if (fading) {
      this.fadeMaterial.uniforms.uBlend.value = clamp01(blend);
      r.autoClear = false; r.setRenderTarget(this.out); r.render(this.fadeScene, this.passes[index].camera);
    }
    r.setRenderTarget(savedTarget); r.setScissorTest(savedScissor); r.setClearColor(this.savedClear, savedAlpha); r.autoClear = savedAutoClear;
  }

  private draw(index: PassIndex, time: number, target: THREE.WebGLRenderTarget) {
    const pass = this.passes[index];
    pass.update(time, time - this.enteredAt[index], this.pointer);
    this.renderer.setRenderTarget(target);
    this.renderer.render(pass.scene, pass.camera);
  }

  dispose() { for (const d of this.disposables) d.dispose(); }
}

/** Deterministic randoms so the field looks the same on every load (and in screenshots). */
function seeded(seed: number) { let s = Math.floor(seed * 1e6) % 2147483647 || 1; return () => (s = (s * 48271) % 2147483647) / 2147483647; }
/** Log-normal latency in ms around 560; the 800 ms gate passes roughly three quarters. */
const latency = (i: number) => { const h = (k: number) => { const x = Math.sin(k * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); }; const u = Math.max(1e-4, h(i)), w = h(i * 1.7 + 9.2); const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(6.2831853 * w); return Math.round(Math.min(2400, Math.max(120, Math.exp(6.33 + z * .42)))); };

function traceGeometry(count: number, rand: () => number) {
  const geometry = new THREE.BufferGeometry();
  const dirs = new Float32Array(count * 3), lands = new Float32Array(count * 3), tangents = new Float32Array(count * 3), seeds = new Float32Array(count), ms = new Float32Array(count), index = new Float32Array(count), born = new Float32Array(count);
  const d = new THREE.Vector3(), t = new THREE.Vector3(), up = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    const u = rand() * 2 - 1, a = rand() * Math.PI * 2, s = Math.sqrt(1 - u * u);
    d.set(s * Math.cos(a), u * .55, s * Math.sin(a)).normalize().toArray(dirs, i * 3);
    d.clone().multiplyScalar(1.6 + Math.pow(rand(), .6) * 1.1).toArray(lands, i * 3);
    t.crossVectors(d, Math.abs(u) < .9 ? up.set(0, 1, 0) : up.set(1, 0, 0)).normalize().toArray(tangents, i * 3);
    seeds[i] = rand(); ms[i] = latency(i); index[i] = i;
  }
  geometry.setAttribute('position', new THREE.BufferAttribute(lands.slice(), 3));
  geometry.setAttribute('aDir', new THREE.BufferAttribute(dirs, 3)); geometry.setAttribute('aLand', new THREE.BufferAttribute(lands, 3));
  geometry.setAttribute('aTangent', new THREE.BufferAttribute(tangents, 3)); geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
  geometry.setAttribute('aMs', new THREE.BufferAttribute(ms, 1)); geometry.setAttribute('aIndex', new THREE.BufferAttribute(index, 1)); geometry.setAttribute('aBorn', new THREE.BufferAttribute(born, 1));
  return geometry;
}
function tracesMaterial(count: number, dpr: number) {
  return new THREE.ShaderMaterial({ vertexShader: shader.tracesVertex, fragmentShader: shader.tracesFragment, uniforms: { uFall: { value: 0 }, uScore: { value: 0 }, uSink: { value: 0 }, uTime: { value: 0 }, uDpr: { value: dpr }, uRadius: { value: 0 }, uCount: { value: count }, uThreshold: { value: 800 } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
}

/** The eval, engraved into the glass; redrawn once Commit Mono is available. */
function evalTexture() {
  const c = document.createElement('canvas'); c.width = 1024; c.height = 640;
  const g = c.getContext('2d')!;
  const texture = new THREE.CanvasTexture(c); texture.flipY = true;
  const draw = () => {
    g.fillStyle = '#000'; g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = '#fff'; g.font = "400 34px 'Commit Mono', monospace"; g.textBaseline = 'top';
    ["// evals/triage.ts", "export default eval('triage', ({ out, ref, ms }) =>", "  out.label === ref.label &&", "  out.owner in ref.team &&", "  ms < 800,", ")"].forEach((line, i) => g.fillText(line, 70, 120 + i * 60));
    texture.needsUpdate = true;
  };
  draw();
  if (typeof document !== 'undefined' && 'fonts' in document) document.fonts.load("400 34px 'Commit Mono'").then(draw).catch(() => {});
  return texture;
}
