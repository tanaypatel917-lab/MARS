import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { ConvexGeometry } from 'three/addons/geometries/ConvexGeometry.js';

function hash(x: number, y: number, z: number) {
  let h = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return h - Math.floor(h);
}
const fade = (t: number) => t * t * (3 - 2 * t);
function valueNoise(x: number, y: number, z: number) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = fade(x - ix), fy = fade(y - iy), fz = fade(z - iz);
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  const c = (dx: number, dy: number, dz: number) => hash(ix + dx, iy + dy, iz + dz);
  return lerp(
    lerp(lerp(c(0, 0, 0), c(1, 0, 0), fx), lerp(c(0, 1, 0), c(1, 1, 0), fx), fy),
    lerp(lerp(c(0, 0, 1), c(1, 0, 1), fx), lerp(c(0, 1, 1), c(1, 1, 1), fx), fy), fz);
}
export function fbm(x: number, y: number, z: number, octaves = 4) {
  let value = 0, amplitude = .5;
  for (let i = 0; i < octaves; i++) {
    value += amplitude * (valueNoise(x, y, z) * 2 - 1);
    x = x * 2.03 + 8.1; y = y * 2.03 + 4.3; z = z * 2.03 + 1.7;
    amplitude *= .5;
  }
  return value;
}

/** A slightly irregular planet: a superellipsoid-shaped sphere with low-frequency relief, in the spirit of Guillaume's runtime stone builder. */
export function planetGeometry(detail: number) {
  const geometry = mergeVertices(new THREE.IcosahedronGeometry(1, detail), 1e-5);
  const position = geometry.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < position.count; i++) {
    v.fromBufferAttribute(position, i).normalize();
    const power = 2.3;
    const sx = Math.sign(v.x) * Math.pow(Math.abs(v.x), 2 / power);
    const sy = Math.sign(v.y) * Math.pow(Math.abs(v.y), 2 / power);
    const sz = Math.sign(v.z) * Math.pow(Math.abs(v.z), 2 / power);
    const shape = new THREE.Vector3(sx, sy, sz).normalize();
    const blend = v.clone().lerp(shape, .35).normalize();
    const relief = fbm(blend.x * 1.6 + 3.1, blend.y * 1.6, blend.z * 1.6, 3) * .045 + fbm(blend.x * 5 + 9, blend.y * 5, blend.z * 5, 3) * .012;
    blend.multiplyScalar(1 + relief);
    blend.x *= 1.0; blend.y *= 1.07; blend.z *= .985;
    position.setXYZ(i, blend.x, blend.y, blend.z);
  }
  geometry.computeVertexNormals();
  const uv = new Float32Array(position.count * 2);
  for (let i = 0; i < position.count; i++) {
    v.fromBufferAttribute(position, i).normalize();
    uv[i * 2] = Math.atan2(v.z, v.x) / (Math.PI * 2) + .5;
    uv[i * 2 + 1] = Math.asin(THREE.MathUtils.clamp(v.y, -1, 1)) / Math.PI + .5;
  }
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return geometry;
}

/** Sparse, irregular wireframe of the same body (a convex hull over seeded surface points), with a per-edge seed so lines can be revealed progressively. */
export function wireGeometry(points: number) {
  const base = planetGeometry(36);
  const position = base.attributes.position as THREE.BufferAttribute;
  const samples: THREE.Vector3[] = [];
  for (let i = 0; i < points; i++) {
    const index = Math.floor(hash(i * 1.37, i * .61, 7.3) * position.count);
    samples.push(new THREE.Vector3().fromBufferAttribute(position, index));
  }
  base.dispose();
  const hull = new ConvexGeometry(samples);
  const wire = new THREE.WireframeGeometry(hull);
  hull.dispose();
  const count = wire.attributes.position.count;
  const seed = new Float32Array(count);
  const normal = new Float32Array(count * 3);
  const p = wire.attributes.position;
  for (let i = 0; i < count; i++) {
    if (i % 2 === 0) {
      const jitter = hash(Math.round(p.getX(i) * 97 + p.getX(i + 1) * 31), Math.round(p.getY(i) * 57 + p.getY(i + 1) * 13), Math.round(p.getZ(i) * 71));
      const top = 1 - ((p.getY(i) + p.getY(i + 1)) * .5 + 1.1) / 2.2;
      const value = Math.min(1, top * .7 + jitter * .3);
      seed[i] = value; seed[i + 1] = value;
    }
    v.set(p.getX(i), p.getY(i), p.getZ(i)).normalize();
    normal[i * 3] = v.x; normal[i * 3 + 1] = v.y; normal[i * 3 + 2] = v.z;
  }
  wire.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
  wire.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  return wire;
}
const v = new THREE.Vector3();
