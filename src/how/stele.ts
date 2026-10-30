import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { planetGeometry, shardPoint } from '../geometry';

/**
 * The stele: the /how v5 hero, an upright fractured Martian stone. The shard body is cut into a handful of large facets
 * (the half-space planes that shaped it, the broadest cracked in two), each triangle owned by exactly one facet and facets
 * never sharing vertices, so the vertex shader can lift one facet on hover and fly every facet apart on click without
 * touching the CPU. Every facet is a closed chunk — outer skin, cleaved underside, side walls — so it reads as a thick
 * piece of stone once it leaves the body rather than a sheet.
 */
export interface Stele {
  body: THREE.BufferGeometry;
  /** Hairline cracks: every edge between two facets, once per side, carrying that side's attributes so they travel with their facet. */
  seams: THREE.BufferGeometry;
  facetCount: number;
  /** face index → facet id, for raycast hits (hit.faceIndex). */
  facetOfFace: Uint16Array;
}

/** Bounding box of the stele in object units: width × height × depth. */
const SIZE = new THREE.Vector3(1.0, 1.7, .9);
/** Facets smaller than this share of the surface are folded into the neighbour they touch most. */
const MIN_FACET_SHARE = .015;
/** Facets broader than this share of the surface are cracked in two. */
const SPLIT_SHARE = .11;
const MAX_FACETS = 18;
/** Seam lines sit a hair above the surface so they never z-fight with the body. */
const SEAM_OFFSET = .004;
/** Laplacian passes that take the tessellation zigzag out of the crack lines (and the chunk outlines, which are snapped to them). */
const SEAM_RELAX = 6;
/** Largest relaxation move, as a fraction of the local edge length (a vertex crossing its neighbour triangle would flip it). */
const SEAM_MAX_MOVE = .4;
/** Chunk thickness at the centre of a facet, in object units; it thins toward the edges. */
const THICK = [.10, .08];

const hash = (k: number) => { const x = Math.sin(k * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
type Owner = THREE.Vector3 & { facet?: { n: THREE.Vector3 } };

export function steleGeometry(detail: number): Stele {
  const indexed = planetGeometry(detail, 'shard');
  const index = indexed.index!;
  const pos = indexed.attributes.position as THREE.BufferAttribute;
  const faceCount = index.count / 3;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), d = new THREE.Vector3();
  const triangle = (f: number) => { a.fromBufferAttribute(pos, index.getX(f * 3)); b.fromBufferAttribute(pos, index.getX(f * 3 + 1)); c.fromBufferAttribute(pos, index.getX(f * 3 + 2)); };

  // 1 · owner per triangle: the half-space plane that cut it, read at the face centroid in the shard's own frame
  const owners: THREE.Vector3[] = [];
  const ownerOf = new Int32Array(faceCount);
  const faceArea = new Float32Array(faceCount);
  for (let f = 0; f < faceCount; f++) {
    triangle(f);
    d.copy(a).add(b).add(c).divideScalar(3).normalize();
    const owner = (shardPoint(d) as Owner).facet!.n;
    let k = owners.indexOf(owner);
    if (k < 0) { k = owners.length; owners.push(owner); }
    ownerOf[f] = k;
    faceArea[f] = b.sub(a).cross(c.sub(a)).length() * .5;
  }

  // 2 · edge adjacency; fold slivers into the neighbour they share the longest boundary with
  const edgeFaces = new Map<number, number[]>();
  const edgeKey = (i: number, j: number) => Math.min(i, j) * pos.count + Math.max(i, j);
  for (let f = 0; f < faceCount; f++) for (let e = 0; e < 3; e++) {
    const key = edgeKey(index.getX(f * 3 + e), index.getX(f * 3 + (e + 1) % 3));
    const list = edgeFaces.get(key); if (list) list.push(f); else edgeFaces.set(key, [f]);
  }
  const area = new Float64Array(64);
  for (let f = 0; f < faceCount; f++) area[ownerOf[f]] += faceArea[f];
  const total = area.reduce((s, x) => s + x, 0);
  const alive = new Set<number>(); for (let k = 0; k < owners.length; k++) if (area[k] > 0) alive.add(k);
  const boundary = () => { const m = new Map<number, number>(); for (const faces of edgeFaces.values()) { if (faces.length !== 2) continue; const p = ownerOf[faces[0]], q = ownerOf[faces[1]]; if (p === q) continue; m.set(p * 64 + q, (m.get(p * 64 + q) ?? 0) + 1); m.set(q * 64 + p, (m.get(q * 64 + p) ?? 0) + 1); } return m; };
  const foldSlivers = () => {
    for (;;) {
      let smallest = -1;
      for (const k of alive) if (smallest < 0 || area[k] < area[smallest]) smallest = k;
      if (smallest < 0 || (area[smallest] / total >= MIN_FACET_SHARE && alive.size <= MAX_FACETS)) break;
      const shared = boundary();
      let best = -1, bestLen = -1;
      for (const k of alive) { if (k === smallest) continue; const len = shared.get(smallest * 64 + k) ?? 0; if (len > bestLen) { bestLen = len; best = k; } }
      if (best < 0) break;
      for (let f = 0; f < faceCount; f++) if (ownerOf[f] === smallest) ownerOf[f] = best;
      area[best] += area[smallest]; area[smallest] = 0; alive.delete(smallest);
    }
  };
  foldSlivers();

  // 3 · crack the broadest faces in two along a seeded, slightly wandering line through their centre
  const fracture = (k: number, salt: number) => {
    const centre = new THREE.Vector3(), normal = new THREE.Vector3(); let w = 0;
    for (let f = 0; f < faceCount; f++) if (ownerOf[f] === k) { triangle(f); d.copy(a).add(b).add(c).divideScalar(3); centre.addScaledVector(d, faceArea[f]); normal.addScaledVector(b.sub(a).cross(c.sub(a)).normalize(), faceArea[f]); w += faceArea[f]; }
    centre.divideScalar(w); normal.normalize();
    const seed = new THREE.Vector3(Math.sin(salt * 2.3 + 1), Math.cos(salt * 1.7 + .4), Math.sin(salt * 3.1 + 2));
    const cut = seed.sub(normal.clone().multiplyScalar(seed.dot(normal))).normalize(), along = normal.clone().cross(cut);
    const side = owners.length; owners.push(cut); alive.add(side); let moved = 0;
    for (let f = 0; f < faceCount; f++) if (ownerOf[f] === k) { triangle(f); d.copy(a).add(b).add(c).divideScalar(3).sub(centre); if (d.dot(cut) + Math.sin(d.dot(along) * 9 + salt) * .035 > 0) { ownerOf[f] = side; moved += faceArea[f]; } }
    area[side] = moved; area[k] -= moved;
  };
  [...alive].filter(k => area[k] / total > SPLIT_SHARE).sort((p, q) => area[q] - area[p]).forEach((k, i) => { if (alive.size < MAX_FACETS) fracture(k, i + 1); });
  foldSlivers();
  const remap = new Map<number, number>(); [...alive].sort((p, q) => area[q] - area[p]).forEach((k, i) => remap.set(k, i));
  const facetCount = remap.size;
  const facetOf = new Uint16Array(faceCount);
  for (let f = 0; f < faceCount; f++) facetOf[f] = remap.get(ownerOf[f])!;

  // 4 · stand it up and fit the box: the shard is long along x, so z by π/2 makes it tall; the worn flank then goes to the back
  indexed.rotateZ(Math.PI / 2); indexed.rotateY(Math.PI / 2);
  indexed.computeBoundingBox();
  const box = indexed.boundingBox!, ext = box.getSize(new THREE.Vector3()), mid = box.getCenter(new THREE.Vector3());
  indexed.translate(-mid.x, -mid.y, -mid.z);
  indexed.scale(SIZE.x / ext.x, SIZE.y / ext.y, SIZE.z / ext.z);

  // 5 · per-facet centroid (area-weighted), mean normal, radius and seed
  const skin = indexed.toNonIndexed();
  const bp = skin.attributes.position as THREE.BufferAttribute, bn = skin.attributes.normal as THREE.BufferAttribute, buv = skin.attributes.uv as THREE.BufferAttribute;
  const centroid = Array.from({ length: facetCount }, () => new THREE.Vector3());
  const meanN = Array.from({ length: facetCount }, () => new THREE.Vector3());
  const weight = new Float64Array(facetCount), radius = new Float64Array(facetCount);
  for (let f = 0; f < faceCount; f++) {
    a.fromBufferAttribute(bp, f * 3); b.fromBufferAttribute(bp, f * 3 + 1); c.fromBufferAttribute(bp, f * 3 + 2);
    d.copy(a).add(b).add(c).divideScalar(3);
    const n = b.sub(a).cross(c.sub(a)); const w = n.length(); n.normalize();
    centroid[facetOf[f]].addScaledVector(d, w); meanN[facetOf[f]].addScaledVector(n, w); weight[facetOf[f]] += w;
  }
  for (let k = 0; k < facetCount; k++) { centroid[k].divideScalar(weight[k] || 1); meanN[k].normalize(); }
  const tangential = (k: number, p: THREE.Vector3) => { d.copy(p).sub(centroid[k]); return d.addScaledVector(meanN[k], -d.dot(meanN[k])).length(); };
  for (let v = 0; v < bp.count; v++) { const k = facetOf[Math.floor(v / 3)]; radius[k] = Math.max(radius[k], tangential(k, a.fromBufferAttribute(bp, v))); }
  const rand = Array.from({ length: facetCount }, (_, k) => hash(k * 1.37 + 2.1));
  const thick = rand.map(r => THICK[0] + r * THICK[1]);
  /** How deep the cleaved underside sits below a skin point: full thickness at the centre, about half at the rim. */
  const depth = (k: number, p: THREE.Vector3) => thick[k] * (.5 + .5 * (1 - Math.min(1, tangential(k, p) / (radius[k] || 1))));

  // 6 · crack runs: chain the edges between each pair of facets into polylines and relax the tessellation zigzag out of them
  //     (junctions where three facets meet stay put); the skin's boundary vertices snap to the relaxed lines
  const crack = new Map<number, number[]>();
  for (const [key, faces] of edgeFaces) {
    if (faces.length !== 2) continue;
    const p = facetOf[faces[0]], q = facetOf[faces[1]];
    if (p === q) continue;
    const pair = Math.min(p, q) * 64 + Math.max(p, q);
    const list = crack.get(pair); if (list) list.push(key); else crack.set(pair, [key]);
  }
  const relaxed = new Map<number, THREE.Vector3>();
  const runs: number[][] = [];
  for (const keys of crack.values()) {
    const next = new Map<number, number[]>();
    const link = (i: number, j: number) => { const l = next.get(i); if (l) l.push(j); else next.set(i, [j]); };
    for (const key of keys) { const i = Math.floor(key / pos.count), j = key % pos.count; link(i, j); link(j, i); }
    const used = new Set<number>();
    const walk = (start: number) => { const run = [start]; let prev = -1, at = start; for (;;) { const options = (next.get(at) ?? []).filter(x => x !== prev && !used.has(edgeKey(at, x))); if (!options.length) break; const to = options[0]; used.add(edgeKey(at, to)); run.push(to); prev = at; at = to; if (to === start) break; } return run; };
    const pairRuns: number[][] = [];
    for (const [i, l] of next) if (l.length !== 2) for (let r = 0; r < l.length; r++) { const run = walk(i); if (run.length > 1) pairRuns.push(run); }
    for (const [i] of next) { const run = walk(i); if (run.length > 1) pairRuns.push(run); }
    for (const run of pairRuns) {
      const closed = run[0] === run[run.length - 1];
      const points = run.map(i => new THREE.Vector3().fromBufferAttribute(pos, i));
      for (let it = 0; it < SEAM_RELAX; it++) {
        const smooth = points.map((p, k) => { if (!closed && (k === 0 || k === points.length - 1)) return p.clone(); const prev = points[(k - 1 + points.length) % points.length], nxt = points[(k + 1) % points.length]; return p.clone().lerp(prev.clone().add(nxt).multiplyScalar(.5), .5); });
        smooth.forEach((p, k) => points[k].copy(p));
      }
      // cap the move at a fraction of the local edge length so no skin triangle beside the crack turns inside out
      run.forEach((i, k) => {
        const orig = a.fromBufferAttribute(pos, i), prev = run[(k - 1 + run.length) % run.length], nxt = run[(k + 1) % run.length];
        const edge = (b.fromBufferAttribute(pos, prev).distanceTo(orig) + c.fromBufferAttribute(pos, nxt).distanceTo(orig)) * .5;
        const move = points[k].clone().sub(orig), len = move.length(), cap = edge * SEAM_MAX_MOVE;
        if (len > cap) points[k].copy(orig).addScaledVector(move, cap / len);
        relaxed.set(i, points[k]);
      });
      runs.push(run);
    }
  }
  for (let v = 0; v < bp.count; v++) { const r = relaxed.get(index.getX(v)); if (r) bp.setXYZ(v, r.x, r.y, r.z); }
  // the rare sliver the snap still turns inside out gets its winding restored so it is not culled into a hole
  for (let f = 0; f < faceCount; f++) {
    a.fromBufferAttribute(bp, f * 3); b.fromBufferAttribute(bp, f * 3 + 1).sub(a); c.fromBufferAttribute(bp, f * 3 + 2).sub(a);
    if (b.cross(c).dot(d.fromBufferAttribute(bn, f * 3)) >= 0) continue;
    for (const attr of [bp, bn, buv, index]) {
      const n = attr.itemSize, i1 = (f * 3 + 1) * n, i2 = (f * 3 + 2) * n, arr = attr.array as ArrayLike<number> & { [i: number]: number };
      for (let j = 0; j < n; j++) { const t = arr[i1 + j]; arr[i1 + j] = arr[i2 + j]; arr[i2 + j] = t; }
    }
  }
  const corner = (f: number, i: number) => { for (let v = f * 3; v < f * 3 + 3; v++) if (index.getX(v) === i) return v; return -1; };

  // 7 · the chunks: skin + cleaved underside + side walls along the crack runs, all carrying their facet's attributes
  const P: number[] = [], N: number[] = [], UV: number[] = [], F: number[] = [];
  const vertex = (k: number, p: THREE.Vector3, n: THREE.Vector3, u: number, v: number) => { P.push(p.x, p.y, p.z); N.push(n.x, n.y, n.z); UV.push(u, v); F.push(k); };
  const inner = new THREE.Vector3(), down = new THREE.Vector3(), q0 = new THREE.Vector3(), q1 = new THREE.Vector3(), q2 = new THREE.Vector3(), q3 = new THREE.Vector3(), wn = new THREE.Vector3();
  /** A skin vertex carried down to the cleaved underside: along a blend of its own normal and the facet's, so curved facets stay closed. */
  const underside = (k: number, v: number, out = inner) => { a.fromBufferAttribute(bp, v); const h = depth(k, a); down.fromBufferAttribute(bn, v).lerp(meanN[k], .5).normalize(); return out.copy(a).addScaledVector(down, -h); };
  for (let f = 0; f < faceCount; f++) {
    const k = facetOf[f];
    for (const v of [f * 3, f * 3 + 2, f * 3 + 1]) { vertex(k, underside(k, v), d.copy(meanN[k]).negate(), buv.getX(v), buv.getY(v)); }
  }
  const skinFaces = faceCount, underFaces = faceCount;
  const wallOf: number[] = [];
  for (const run of runs) for (let s = 0; s + 1 < run.length; s++) {
    const key = edgeKey(run[s], run[s + 1]);
    for (const f of edgeFaces.get(key)!) {
      const k = facetOf[f], v0 = corner(f, run[s]), v1 = corner(f, run[s + 1]);
      if (v0 < 0 || v1 < 0) continue;
      q0.fromBufferAttribute(bp, v0); q1.fromBufferAttribute(bp, v1);
      underside(k, v1, q2); underside(k, v0, q3);
      // the wall faces away from the skin triangle: outward = edge (in the triangle's winding order) × facet normal
      const forward = (v1 - f * 3) === (v0 - f * 3 + 1) % 3;
      const out = d.copy(forward ? q1 : q0).sub(forward ? q0 : q1).cross(meanN[k]);
      const flip = wn.copy(q1).sub(q0).cross(a.copy(q3).sub(q0)).dot(out) < 0;
      const quad = flip ? [q0, q3, q2, q0, q2, q1] : [q0, q1, q2, q0, q2, q3];
      const u = (buv.getX(v0) + buv.getX(v1)) * .5, w = (buv.getY(v0) + buv.getY(v1)) * .5;
      // per-triangle normals (the quad may twist where undersides cross); emitted with both windings so a
      // concave crack run on a wrapped facet can never open a hole — the back copy is culled
      const tri = (p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3) => {
        wn.copy(p1).sub(p0).cross(a.copy(p2).sub(p0)).normalize();
        vertex(k, p0, wn, u, w); vertex(k, p1, wn, u, w); vertex(k, p2, wn, u, w);
      };
      tri(quad[0], quad[1], quad[2]); tri(quad[3], quad[4], quad[5]);
      tri(quad[2], quad[1], quad[0]); tri(quad[5], quad[4], quad[3]);
      wallOf.push(k, k, k, k);
    }
  }
  const extra = new THREE.BufferGeometry();
  extra.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  extra.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  extra.setAttribute('uv', new THREE.Float32BufferAttribute(UV, 2));
  const body = mergeGeometries([skin, extra], false)!;
  skin.dispose(); extra.dispose(); indexed.dispose();
  const facetOfFace = new Uint16Array(skinFaces + underFaces + wallOf.length);
  facetOfFace.set(facetOf, 0); facetOfFace.set(facetOf, skinFaces); facetOfFace.set(wallOf, skinFaces + underFaces);
  const vertexCount = body.attributes.position.count;
  const aFacet = new Float32Array(vertexCount), aRand = new Float32Array(vertexCount), aCentroid = new Float32Array(vertexCount * 3), aFacetN = new Float32Array(vertexCount * 3);
  for (let v = 0; v < vertexCount; v++) {
    const k = facetOfFace[Math.floor(v / 3)];
    aFacet[v] = k; aRand[v] = rand[k]; centroid[k].toArray(aCentroid, v * 3); meanN[k].toArray(aFacetN, v * 3);
  }
  body.setAttribute('aFacet', new THREE.BufferAttribute(aFacet, 1));
  body.setAttribute('aRand', new THREE.BufferAttribute(aRand, 1));
  body.setAttribute('aCentroid', new THREE.BufferAttribute(aCentroid, 3));
  body.setAttribute('aFacetN', new THREE.BufferAttribute(aFacetN, 3));
  body.setAttribute('aTarget', new THREE.BufferAttribute(new Float32Array(vertexCount * 3), 3));
  body.setAttribute('aDelay', new THREE.BufferAttribute(new Float32Array(vertexCount), 1));
  body.computeBoundingSphere();

  // 8 · seams: each crack segment once per side, lifted a hair along the skin normal
  const sp: number[] = [], sn: number[] = [], su: number[] = [], sf: number[] = [], sr: number[] = [], sc: number[] = [], sfn: number[] = [];
  const emit = (f: number, v: number) => {
    a.fromBufferAttribute(bp, v); b.fromBufferAttribute(bn, v); a.addScaledVector(b, SEAM_OFFSET);
    sp.push(a.x, a.y, a.z); sn.push(b.x, b.y, b.z); su.push(buv.getX(v), buv.getY(v));
    const k = facetOf[f]; sf.push(k); sr.push(rand[k]); sc.push(centroid[k].x, centroid[k].y, centroid[k].z); sfn.push(meanN[k].x, meanN[k].y, meanN[k].z);
  };
  for (const run of runs) for (let s = 0; s + 1 < run.length; s++) for (const f of edgeFaces.get(edgeKey(run[s], run[s + 1]))!) {
    const v0 = corner(f, run[s]), v1 = corner(f, run[s + 1]);
    if (v0 >= 0 && v1 >= 0) { emit(f, v0); emit(f, v1); }
  }
  const seams = new THREE.BufferGeometry();
  seams.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3));
  seams.setAttribute('normal', new THREE.Float32BufferAttribute(sn, 3));
  seams.setAttribute('uv', new THREE.Float32BufferAttribute(su, 2));
  seams.setAttribute('aFacet', new THREE.Float32BufferAttribute(sf, 1));
  seams.setAttribute('aRand', new THREE.Float32BufferAttribute(sr, 1));
  seams.setAttribute('aCentroid', new THREE.Float32BufferAttribute(sc, 3));
  seams.setAttribute('aFacetN', new THREE.Float32BufferAttribute(sfn, 3));
  seams.setAttribute('aTarget', new THREE.BufferAttribute(new Float32Array(sf.length * 3), 3));
  seams.setAttribute('aDelay', new THREE.BufferAttribute(new Float32Array(sf.length), 1));
  seams.computeBoundingSphere();
  return { body, seams, facetCount, facetOfFace };
}

export const steleUniforms = () => ({ uFacet: { value: -1 }, uExplode: { value: 0 }, uLift: { value: 0 }, uTime: { value: 0 }, uCam: { value: new THREE.Vector3(0, 0, 1) } });

/**
 * GPU displacement of one facet. Hover: the facet rides out along its mean normal by uLift*.06 (uLift is tweened by the page;
 * a smoothstep keeps the first and last frames soft). Shatter: the chunk shrinks a little about its centroid, tumbles about a
 * seeded axis (mostly tangent, so flat chunks turn over rather than spin like plates) and drifts out along its mean normal; the
 * tumble lags the separation slightly so chunks clear each other before they turn. A slow zero-g bob keeps the cloud alive at
 * rest. The normal is tumbled with the chunk. Writes vFacet for the fragment stage.
 */
export const steleVertexChunk = /* glsl */`
attribute float aFacet;attribute vec3 aCentroid;attribute vec3 aFacetN;attribute float aRand;
uniform float uFacet;uniform float uExplode;uniform float uLift;uniform float uTime;uniform vec3 uCam;
varying float vFacet;
mat3 steleRotation(vec3 k,float a){float c=cos(a),s=sin(a),t=1.-c;
 return mat3(t*k.x*k.x+c,t*k.x*k.y+s*k.z,t*k.x*k.z-s*k.y, t*k.x*k.y-s*k.z,t*k.y*k.y+c,t*k.y*k.z+s*k.x, t*k.x*k.z+s*k.y,t*k.y*k.z-s*k.x,t*k.z*k.z+c);}
vec3 steleDisplace(vec3 p,inout vec3 n){
 vFacet=aFacet;
 float hot=step(abs(aFacet-uFacet),.5);
 float l=clamp(uLift,0.,1.);float lift=hot*l*l*(3.-2.*l)*.06;
 float e=clamp(uExplode,0.,1.);
 if(e<=0.)return p+aFacetN*lift;
 float turn=smoothstep(.06,1.,e);
 vec3 r=vec3(sin(aRand*6.2831+1.3),cos(aRand*4.17+.7),sin(aRand*9.31+2.9));
 vec3 axis=normalize(cross(aFacetN,r)+aFacetN*(aRand-.5)*.5);
 float angle=aRand*2.4*turn+sin(uTime*(.25+aRand*.35)+aRand*9.)*e*.07;
 mat3 R=steleRotation(axis,angle);
 n=R*n;
 vec3 q=R*((p-aCentroid)*(1.-e*.12));
 float bob=sin(uTime*(.6+aRand)+aRand*6.)*e*.08;
 float facing=smoothstep(.15,.85,dot(aFacetN,uCam));
 vec3 lat=aCentroid-uCam*dot(aCentroid,uCam);lat=length(lat)>.02?normalize(lat):vec3(1.,0.,0.);
 vec3 push=aFacetN*e*(.62+aRand*.45)+lat*facing*e*(.8+aRand*.3);push.y*=.6;
 return aCentroid+q+aFacetN*lift+push+vec3(0.,1.,0.)*bob+axis*bob*.35;}
`;

/** Splices the chunk into src/shaders.ts bodyVertex: the facet displacement runs before the wordmark morph, which is zero on /how. */
export function steleVertexShader(base: string) {
  const declare = 'attribute float aDelay;', place = 'vec3 pe=position*s;', normal = 'vec3 ne=normalize(normal/s);';
  if (!base.includes(declare) || !base.includes(place) || !base.includes(normal)) throw new Error('steleVertexShader: bodyVertex markers not found');
  return base
    .replace(declare, declare + steleVertexChunk)
    .replace(place, 'vec3 nrm=normal;vec3 pe=steleDisplace(position,nrm)*s;')
    .replace(normal, 'vec3 ne=normalize(nrm/s);');
}

/**
 * Hairline crack lines. Ivory at uSeam (0–.15 is the intended range, 0 hides them), fading as the line turns edge-on; the
 * hovered facet's edges go white-hot with uLift. Pair with the vertex shader above, transparent, depthWrite off (additive reads best).
 */
export const seamFragment = /* glsl */`
uniform float uSeam;uniform float uFacet;uniform float uLift;varying float vFacet;varying vec3 vNormal;varying vec3 vView;
void main(){vec3 n=normalize(vNormal);float facing=abs(dot(n,normalize(-vView)));
 float hot=step(abs(vFacet-uFacet),.5)*clamp(uLift,0.,1.);
 float base=uSeam*(.3+.7*facing);float glow=hot*(.4+.6*facing);
 vec3 c=mix(vec3(.93,.89,.82),mix(vec3(1.,.88,.7),vec3(1.),facing)*1.5,hot);
 gl_FragColor=vec4(c,clamp(base+glow,0.,1.));}
`;
