import * as THREE from 'three';
import { fbm } from '../geometry';
import { groundRelief } from './landscapeGroundRelief';

/**
 * Shape of the colonised Martian landscape under the /how stele — the one place its heights are defined, so the terrain mesh,
 * the colony, the ground detail and the sky all agree on where the land is.
 *
 * Camera convention: the stele is at the origin, the camera orbits at radius ~5.6, height ~.6, looking at (0,.2,0), fov 34.
 * The plain lies BASE below the stele and falls DROP further toward the horizon, so from that camera the far terrain dissolves
 * ~55 % down the frame and the nearest ridges rise to just under the stele's base.
 */
/** Fog tint per move (loop, observe, evaluate, refine, ascend); the page tweens `Landscape.fog` between them. */
export const FOG = ['#3a3220', '#1d3838', '#2f4433', '#3a1a12', '#2a0c0e'];
export const EXTENT = 440;
/** Level of the plain under the stele; the land falls DROP further toward the horizon. */
export const BASE = -9, DROP = 12;
/** Relief (above the local base) at or below which the terrain is a flat glossy pool. */
export const POOL = 1.05;
/** Haze density at ground level (exp(-d²k)); the terrain is fully dissolved ~140 units out. Thins with altitude (see FOG_SCALE_HEIGHT). */
export const FOG_K = 1 / (100 * 100);
/** Height (above BASE) over which the dust fog thins by e, so tall masts, moons and distant mesas poke out of it. */
export const FOG_SCALE_HEIGHT = 34;
/** Elevation (unit direction y) of the sky's horizon, matched to where the far terrain dissolves. */
export const HORIZON = -.16;

/**
 * Height of the landscape at (x, z): the gently falling base plus dune relief — long ridged dunes (1 − |fbm|, so the crests are
 * sharp and the basins between them broad) with finer facets on the crests — flattened into a plain near the stele; everything at
 * or below the pool level is clamped flat so the basins become pools. Craters, ripples and faults come from ./landscapeGroundRelief.
 * `relief <= POOL` means the point is on a pool.
 */
export function heightAt(x: number, z: number) {
  const r = Math.hypot(x, z);
  const base = BASE - DROP * THREE.MathUtils.smoothstep(r, 10, 150);
  const ridged = 1 - Math.abs(fbm(x * .0165 + 3.1, z * .0135, 1.7, 3)) * 4.5;
  const crest = Math.max(ridged, 0) ** 1.8;
  let relief = (crest * 7.4 + fbm(x * .07, z * .07 + 9, 4.2, 3) * 1.4 * (.3 + crest)) * THREE.MathUtils.smoothstep(r, 6, 17);
  relief = Math.max(relief + groundRelief(x, z), POOL);
  return { y: base + relief, relief };
}

/** True where the land is dry (not a pool) and roughly level — where a structure can stand. */
export function isLand(x: number, z: number, margin = .5) { return heightAt(x, z).relief > POOL + margin; }

/** Nearest dry, level site to (x, z): walks outward from the stele until it leaves the pools. Returns [x, y, z]. */
export function siteOnLand(x: number, z: number, margin = .5): [number, number, number] {
  for (let k = 0; k < 16; k++) { const h = heightAt(x, z); if (h.relief > POOL + margin) return [x, h.y, z]; const r = Math.hypot(x, z) || 1; x += x / r * 2.5; z += z / r * 2.5; }
  const h = heightAt(x, z); return [x, h.y, z];
}

/** Slope-free up vector approximation of the terrain normal at (x, z) (central differences). */
export function normalAt(x: number, z: number, e = .6) {
  const n = new THREE.Vector3(heightAt(x - e, z).y - heightAt(x + e, z).y, 2 * e, heightAt(x, z - e).y - heightAt(x, z + e).y);
  return n.normalize();
}

/** Deterministic pseudo-random sequence for placing detail reproducibly. */
export function seeded(seed: number) { let s = seed % 2147483647 || 1; return () => { s = (s * 16807) % 2147483647; return s / 2147483647; }; }
