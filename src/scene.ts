import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import * as shader from './shaders';

const smooth = (a: number, b: number, x: number) => THREE.MathUtils.smoothstep(x, a, b);
function random(seed: number) {
  let value = seed;
  return () => { value = (Math.imul(value, 1664525) + 1013904223) >>> 0; return value / 4294967296; };
}

export class MarsScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly camera = new THREE.PerspectiveCamera(40, 1, .1, 250);
  private readonly scene = new THREE.Scene();
  private readonly composer: EffectComposer;
  private readonly bloom: UnrealBloomPass;
  private readonly grade: ShaderPass;
  private readonly materials: THREE.ShaderMaterial[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly planet: THREE.Mesh;
  private readonly atmosphere: THREE.Mesh;
  private readonly ring: THREE.Mesh;
  private readonly particles: THREE.Mesh;
  private readonly terrain: THREE.Mesh;
  private readonly sky: THREE.Mesh;
  private readonly stars: THREE.Points;
  private readonly starMaterial: THREE.PointsMaterial;
  private aspect = 1;
  private readonly center = new THREE.Vector3();
  private readonly edge = new THREE.Vector3();
  private disposed = false;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setClearColor(0x05040a);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.camera.position.set(0, 0, 8);
    const plane = new THREE.PlaneGeometry(2, 2);
    this.geometries.push(plane);
    this.sky = this.mesh(plane, shader.fullscreenVertex, shader.skyFragment, {
      uArrival: { value: 0 }, uTime: { value: 0 }, uAspect: { value: 1 },
    });
    (this.sky.material as THREE.ShaderMaterial).depthTest = false;
    (this.sky.material as THREE.ShaderMaterial).depthWrite = false;
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -10;
    const globe = new THREE.SphereGeometry(3.1, 160, 96);
    this.geometries.push(globe);
    this.planet = this.mesh(globe, shader.planetVertex, shader.planetFragment, { uTime: { value: 0 }, uMars: { value: 0 } });
    this.atmosphere = this.mesh(plane, shader.fullscreenVertex, shader.atmosphereFragment, {
      uCenter: { value: new THREE.Vector2() }, uRadius: { value: .4 }, uAspect: { value: 1 }, uOpacity: { value: 1 }, uTime: { value: 0 },
    }, true);
    this.atmosphere.frustumCulled = false;
    this.atmosphere.renderOrder = 3;
    (this.atmosphere.material as THREE.ShaderMaterial).depthTest = false;

    const torus = new THREE.TorusGeometry(2.18, .007, 8, 360);
    this.geometries.push(torus);
    this.ring = this.mesh(torus, shader.ringVertex, shader.ringFragment, { uTime: { value: 0 }, uOpacity: { value: 1 }, uPhase: { value: 0 } }, true);
    this.ring.position.x = 1.78;
    this.ring.rotation.x = .82;
    this.ring.rotation.z = -.25;

    const quad = new THREE.PlaneGeometry(1, 1);
    const instanced = new THREE.InstancedBufferGeometry();
    instanced.index = quad.index;
    instanced.attributes.position = quad.attributes.position;
    instanced.attributes.uv = quad.attributes.uv;
    const rng = random(42);
    const count = window.innerWidth < 800 ? 2400 : 10000;
    const seeds = new Float32Array(count * 3);
    for (let i = 0; i < seeds.length; i++) seeds[i] = rng();
    instanced.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 3));
    instanced.instanceCount = count;
    this.geometries.push(quad, instanced);
    this.particles = this.mesh(instanced, shader.particleVertex, shader.particleFragment, {
      uTime: { value: 0 }, uProgress: { value: 0 }, uPhase: { value: 0 }, uOpacity: { value: 0 },
    }, true);
    this.particles.frustumCulled = false;
    (this.particles.material as THREE.ShaderMaterial).blending = THREE.AdditiveBlending;

    const terrain = new THREE.PlaneGeometry(180, 145, 240, 170);
    terrain.rotateX(-Math.PI / 2);
    terrain.translate(0, 0, -50);
    this.geometries.push(terrain);
    this.terrain = this.mesh(terrain, shader.terrainVertex, shader.terrainFragment, { uOpacity: { value: 0 } }, true);
    this.terrain.frustumCulled = false;
    (this.terrain.material as THREE.ShaderMaterial).side = THREE.DoubleSide;

    const positions = new Float32Array(500 * 3);
    for (let i = 0; i < 500; i++) {
      positions[i * 3] = (rng() - .5) * 80;
      positions[i * 3 + 1] = (rng() - .5) * 48;
      positions[i * 3 + 2] = -25 - rng() * 30;
    }
    const starGeometry = new THREE.BufferGeometry();
    starGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.geometries.push(starGeometry);
    this.starMaterial = new THREE.PointsMaterial({ size: .024, color: 0x8a87aa, transparent: true, opacity: .36, depthWrite: false });
    this.stars = new THREE.Points(starGeometry, this.starMaterial);
    this.scene.add(this.stars);

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(512, 320), .24, .6, .38);
    this.composer.addPass(this.bloom);
    this.grade = new ShaderPass({ uniforms: { tDiffuse: { value: null }, uTime: { value: 0 } }, vertexShader: shader.fullscreenVertex, fragmentShader: shader.gradeFragment });
    this.composer.addPass(this.grade);
    this.resize();
  }

  private mesh(geometry: THREE.BufferGeometry, vertexShader: string, fragmentShader: string, uniforms: Record<string, THREE.IUniform>, transparent = false) {
    const material = new THREE.ShaderMaterial({ vertexShader, fragmentShader, uniforms, transparent, depthWrite: !transparent });
    this.materials.push(material);
    const mesh = new THREE.Mesh(geometry, material);
    this.scene.add(mesh);
    return mesh;
  }

  resize() {
    const width = window.innerWidth;
    const height = window.innerHeight;
    const ratio = Math.min(window.devicePixelRatio || 1, 1.5, Math.sqrt(2_200_000 / (width * height)));
    this.aspect = width / height;
    this.camera.aspect = this.aspect;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(width, height);
    this.composer.setPixelRatio(ratio);
    this.composer.setSize(width, height);
    this.bloom.setSize(Math.round(width * ratio * .5), Math.round(height * ratio * .5));
  }

  render(progress: number, time: number) {
    if (this.disposed) return;
    const ringIn = smooth(.33, .43, progress);
    const ringOut = 1 - smooth(.60, .70, progress);
    const arrival = smooth(.76, .88, progress);
    const phase = Math.min(3, Math.floor(THREE.MathUtils.clamp((progress - .4) / .2, 0, .999) * 4));
    this.camera.position.set(0, arrival * 3.2, 8 + arrival * 6);
    this.camera.lookAt(0, arrival * 6.4, -arrival * 30);
    this.camera.updateMatrixWorld();
    const planetVisibility = (1 - smooth(.26, .37, progress)) + smooth(.65, .74, progress) * (1 - arrival);
    this.planet.visible = planetVisibility > .02;
    this.planet.position.set(THREE.MathUtils.lerp(3.15, 2.4, smooth(.64, .76, progress)), -1.9, -2 + smooth(.65, .77, progress) * 3.2);
    if (this.aspect < 1) this.planet.position.set(2.4, -3.3, -3);
    this.planet.rotation.y = time * .008;
    const scale = 1 - ringIn * .8 * ringOut;
    this.planet.scale.setScalar(scale);
    const planetMaterial = this.planet.material as THREE.ShaderMaterial;
    planetMaterial.uniforms.uTime.value = time;
    planetMaterial.uniforms.uMars.value = smooth(.64, .77, progress);
    this.planet.updateMatrixWorld();
    this.center.copy(this.planet.position).project(this.camera);
    this.edge.copy(this.planet.position).add(new THREE.Vector3(3.1 * scale, 0, 0)).project(this.camera);
    const atmosphere = (this.atmosphere.material as THREE.ShaderMaterial).uniforms;
    atmosphere.uCenter.value.set(this.center.x * .5 + .5, this.center.y * .5 + .5);
    atmosphere.uRadius.value = Math.abs(this.edge.x - this.center.x) * .5 * this.aspect;
    atmosphere.uAspect.value = this.aspect;
    atmosphere.uTime.value = time;
    atmosphere.uOpacity.value = this.planet.visible ? planetVisibility * (1 - arrival) : 0;
    this.atmosphere.visible = this.planet.visible && arrival < .9;

    this.ring.visible = ringIn * ringOut > .001;
    const ringUniforms = (this.ring.material as THREE.ShaderMaterial).uniforms;
    ringUniforms.uTime.value = time;
    ringUniforms.uOpacity.value = ringIn * ringOut * .8;
    ringUniforms.uPhase.value = phase;
    this.ring.rotation.z = -.25 + time * .008;
    const particleUniforms = (this.particles.material as THREE.ShaderMaterial).uniforms;
    particleUniforms.uTime.value = time;
    particleUniforms.uProgress.value = progress;
    particleUniforms.uPhase.value = phase;
    particleUniforms.uOpacity.value = smooth(.16, .25, progress) * (1 - smooth(.61, .71, progress)) * .85;
    this.particles.visible = particleUniforms.uOpacity.value > .001;
    this.starMaterial.opacity = .30 * (1 - arrival * .85) * (1 - ringIn * ringOut * .7);
    this.terrain.visible = arrival > .001;
    (this.terrain.material as THREE.ShaderMaterial).uniforms.uOpacity.value = arrival;
    const skyUniforms = (this.sky.material as THREE.ShaderMaterial).uniforms;
    skyUniforms.uArrival.value = arrival;
    skyUniforms.uAspect.value = this.aspect;
    skyUniforms.uTime.value = time;
    this.grade.uniforms.uTime.value = time;
    this.composer.render();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const material of this.materials) material.dispose();
    for (const geometry of this.geometries) geometry.dispose();
    this.starMaterial.dispose();
    this.bloom.dispose();
    this.grade.dispose();
    this.composer.dispose();
    this.renderer.dispose();
  }
}
