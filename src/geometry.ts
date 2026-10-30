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

interface Facet { n: THREE.Vector3; d: number }
/** Elongation of the shard: a flat-ish meteorite, longer than it is tall. */
const STRETCH = new THREE.Vector3(1.06, .76, .84);
const SEED = 7.3;
let facets: Facet[] | undefined;
let fractures: Facet[] | undefined;
function planes(count: number, salt: number, near: number, far: number) {
  const out: Facet[] = [];
  for (let k = 0; k < count; k++) {
    const u = hash(k * 1.1 + salt, SEED, 3.3) * 2 - 1, a = hash(k * 2.7 + salt, SEED, 9.1) * Math.PI * 2, s = Math.sqrt(1 - u * u);
    out.push({ n: new THREE.Vector3(s * Math.cos(a), u, s * Math.sin(a)), d: near + hash(k * 3.9 + salt, SEED, 1.7) * (far - near) });
  }
  return out;
}

/**
 * The hero body is a fractured Martian shard rather than a sphere: the radial intersection of ~16 random half-spaces gives
 * large flat facets with sharp ridges, the underside is worn back toward a rounded form, three fracture grooves cut across
 * the facets and low-frequency fbm adds wear. Evaluated radially so a tessellated sphere maps onto it one-to-one.
 */
export function shardPoint(dir: THREE.Vector3, out = new THREE.Vector3()) {
  facets ??= planes(16, 0, .78, .98);
  fractures ??= planes(3, 40, -.25, .25);
  let r = 10, best = facets[0];
  for (const f of facets) {
    const k = dir.dot(f.n);
    if (k > 1e-3) { const t = f.d / k; if (t < r) { r = t; best = f; } }
  }
  r = Math.min(r, 1.25);
  const worn = fade(THREE.MathUtils.clamp((-.05 - dir.y) / .6, 0, 1));
  r = THREE.MathUtils.lerp(r, .9, worn * .55);
  out.copy(dir).multiplyScalar(r);
  for (const f of fractures) {
    const g = Math.exp(-Math.pow(out.dot(f.n) - f.d, 2) / .0012);
    r *= 1 - .05 * g * (1 - worn);
  }
  r *= 1 + fbm(dir.x * 2.2 + 3.1, dir.y * 2.2, dir.z * 2.2, 3) * .03 + fbm(dir.x * 7 + 9, dir.y * 7, dir.z * 7, 3) * .008;
  out.copy(dir).multiplyScalar(r).multiply(STRETCH);
  (out as THREE.Vector3 & { facet?: Facet }).facet = best;
  return out;
}

/** The shard as a tessellated sphere remapped onto shardPoint, with normals pulled toward the owning facet so ridges stay crisp. */
export function planetGeometry(detail: number) {
  const geometry = mergeVertices(new THREE.IcosahedronGeometry(1, detail), 1e-5);
  const position = geometry.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3(), p = new THREE.Vector3();
  const owners: THREE.Vector3[] = [];
  for (let i = 0; i < position.count; i++) {
    v.fromBufferAttribute(position, i).normalize();
    shardPoint(v, p);
    owners.push((p as THREE.Vector3 & { facet?: Facet }).facet!.n);
    position.setXYZ(i, p.x, p.y, p.z);
  }
  geometry.computeVertexNormals();
  const normal = geometry.attributes.normal as THREE.BufferAttribute;
  const n = new THREE.Vector3(), f = new THREE.Vector3();
  for (let i = 0; i < position.count; i++) {
    n.fromBufferAttribute(normal, i);
    f.copy(owners[i]).divide(STRETCH).normalize();
    v.fromBufferAttribute(position, i).divide(STRETCH).normalize();
    const worn = fade(THREE.MathUtils.clamp((-.05 - v.y) / .6, 0, 1));
    n.lerp(f, .6 * (1 - worn)).normalize();
    normal.setXYZ(i, n.x, n.y, n.z);
  }
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
      const top = 1 - ((p.getY(i) + p.getY(i + 1)) * .5 + .95) / 1.9;
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
