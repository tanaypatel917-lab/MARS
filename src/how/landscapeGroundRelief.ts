/**
 * Fine relief of the Martian ground under the /how stele: impact craters (a raised rim around a sunk bowl, with a faint ejecta
 * apron), low anisotropic dune ripples and a couple of faults — gently curving escarpments where the plain steps down a unit or
 * two. Pure arithmetic on (x, z), imported by nothing but `heightAt` (which adds it to the dune heights) and the ground
 * dressing, so the terrain mesh, the boulders and the tyre tracks all agree on where the ground is. Zero within r < 18 so
 * the plain under the stele stays a clean stage; cheap enough to run per terrain vertex (~33k calls at startup).
 */

/** Craters: [x, z, radius, rim height, bowl depth]. 30 … 160 units out on the dune flanks, none within reach of r < 20. */
export const CRATERS: readonly (readonly [number, number, number, number, number])[] = [
  [20, -33, 6, .7, 1.6],
  [-48, -36, 9, 1, 2.4],
  [70, 25, 7, .8, 1.8],
  [-62, 23, 12, 1.2, 3],
  [19, 57, 5, .5, 1.2],
  [-39, 53, 8, .9, 2],
  [79, -36, 9, .9, 2],
  [-97, -17, 17, 1.2, 3],
  [95, 51, 10, .9, 2.2],
  [-6, -88, 9, 1, 2.4],
  [109, 27, 18, 1.1, 2.6],
  [34, -113, 8, .8, 2],
];

/** Faults: [direction angle, offset, curve amplitude, curve wavelength, along-line centre, half length, step height]. */
const FAULTS: readonly (readonly [number, number, number, number, number, number, number])[] = [
  [.55, 44, 7, 130, 10, 55, 1.6],
  [-1.2, -62, 5, 110, -20, 45, 1.2],
];

const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const hash = (x: number, z: number) => { const h = Math.sin(x * 127.1 + z * 311.7) * 43758.5453; return h - Math.floor(h); };
/** 2-D value noise in 0 … 1. */
function noise(x: number, z: number) {
  const ix = Math.floor(x), iz = Math.floor(z);
  let fx = x - ix, fz = z - iz; fx = fx * fx * (3 - 2 * fx); fz = fz * fz * (3 - 2 * fz);
  const a = hash(ix, iz), b = hash(ix + 1, iz), c = hash(ix, iz + 1), d = hash(ix + 1, iz + 1);
  return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
}

/** Additive height detail (world units) at (x, z). 0 within r < 18. */
export function groundRelief(x: number, z: number): number {
  const r = Math.hypot(x, z);
  if (r < 18) return 0;
  const gate = smooth(18, 26, r);
  let h = 0;

  // craters: a flat-floored bowl, a rim peaking just inside the radius with a crisp inner scarp and a long outer apron
  for (let i = 0; i < CRATERS.length; i++) {
    const c = CRATERS[i], dx = x - c[0], dz = z - c[1], R = c[2];
    if (Math.abs(dx) > R * 1.9 || Math.abs(dz) > R * 1.9) continue;
    const d = Math.hypot(dx, dz) / R;
    if (d > 1.9) continue;
    const wobble = 1 + (noise(dx * .5 / R * 3 + i * 7.1, dz * .5 / R * 3) - .5) * .16;
    const dd = d * wobble;
    const bowl = -c[4] * (1 - smooth(.45, .96, dd));
    const rim = c[3] * (dd < 1 ? smooth(.6, 1, dd) : 1 - smooth(1, 1.5, dd) * (1 - .12 * (1 - smooth(1.5, 1.9, dd))));
    h += bowl + rim;
  }

  // dune ripples: short anisotropic waves (crest-to-crest ≈ 2.8 u) whose direction drifts with a slow noise, amplitude ≤ .25
  const drift = noise(x * .012 + 4.2, z * .012) * 1.2;
  const u = x * Math.cos(drift) + z * Math.sin(drift);
  const ripple = Math.sin(u * 2.25 + noise(x * .09, z * .09 + 2.3) * 3.2);
  h += ripple * .17 * (.4 + .6 * noise(x * .03 + 9.1, z * .03 - 3.7));

  // faults: a step across a gently curving line, fading out along its length
  for (let i = 0; i < FAULTS.length; i++) {
    const f = FAULTS[i], ca = Math.cos(f[0]), sa = Math.sin(f[0]);
    const along = -x * sa + z * ca, across = x * ca + z * sa - f[1] - Math.sin(along / f[3] * 6.2832 + i) * f[2];
    const reach = 1 - smooth(f[5] * .7, f[5], Math.abs(along - f[4]));
    if (reach <= 0) continue;
    h += f[6] * (smooth(-1.1, 1.1, across) - .5) * reach;
  }

  return h * gate;
}
