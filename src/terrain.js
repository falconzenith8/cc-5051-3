// Synthetic terrain shared by the renderer and the planner. There is exactly
// one height field and one surface classification; the planner, the mesh and
// the walking character all read from these functions so nothing can drift.

import { WORLD, SURFACE } from './config.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smoothstep = (t) => {
  t = clamp(t, 0, 1);
  return t * t * (3 - 2 * t);
};

// ---------------------------------------------------------------- value noise
function hash2(ix, iz) {
  let h = Math.imul(ix, 374761393) + Math.imul(iz, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}

function valueNoise(x, z) {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const u = fx * fx * (3 - 2 * fx);
  const v = fz * fz * (3 - 2 * fz);
  const a = hash2(ix, iz);
  const b = hash2(ix + 1, iz);
  const c = hash2(ix, iz + 1);
  const d = hash2(ix + 1, iz + 1);
  return (a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v) * 2 - 1;
}

// -------------------------------------------------------------- route geometry
function distToSegment(px, pz, ax, az, bx, bz) {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz;
  let t = len2 ? ((px - ax) * dx + (pz - az) * dz) / len2 : 0;
  t = clamp(t, 0, 1);
  return Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
}

export function distToPolyline(x, z, pts) {
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const d = distToSegment(x, z, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
    if (d < best) best = d;
  }
  return best;
}

// The gravel wash is the long, gentle eastern crossover. Its polyline is also
// carved into the height field, so it is both a cheap surface and a low-gradient
// corridor: the ATV's natural line, but a detour for everything else.
export const GRAVEL_PATH = [
  [40, 174], [66, 163], [96, 157], [128, 152], [158, 144],
  [182, 132], [197, 117], [202, 100], [199, 82], [190, 62],
  [177, 42], [162, 26], [151, 14],
];

// Mud belt across the southern basin. Broad in the east, with a single narrow
// ford in the west.
const MUD_PATH = [
  [-6, 139], [40, 141], [80, 140], [120, 137], [160, 134], [196, 131],
];

// Thin costs-like strip: a 0.7 m seam of broken rubble that cuts across the
// eastern corridor. It is walkable/expensive, never impassable. Its job is to
// stay visible to the cost integrator even though node spacing is 2 m.
const RUBBLE_SEAM = [
  [150, 120], [172, 110], [190, 98], [202, 84],
];

// Walkable but very expensive boulder field between the two crossings.
export const COSTLY_FIELD = { x: 126, z: 96, rx: 20, rz: 13 };

// ---------------------------------------------------------------- rock features
export const OUTCROPS = [
  { x: 30, z: 120, rx: 7, rz: 5 },
  { x: 96, z: 60, rx: 6, rz: 9 },
  { x: 196, z: 156, rx: 12, rz: 8 },
  { x: 78, z: 40, rx: 9, rz: 6 },
  { x: 224, z: 40, rx: 7, rz: 7 },
];

function seededRocks() {
  const rocks = [];
  let s = 0x51f3a2b7;
  const rnd = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
  let guard = 0;
  while (rocks.length < 38 && guard++ < 600) {
    const x = 14 + rnd() * (WORLD.width - 28);
    const z = 14 + rnd() * (WORLD.depth - 28);
    const r = 0.8 + rnd() * 1.5;
    if (Math.hypot(x - WORLD.start.x, z - WORLD.start.z) < 10) continue;
    if (Math.hypot(x - WORLD.goal.x, z - WORLD.goal.z) < 10) continue;
    if (distToPolyline(x, z, GRAVEL_PATH) < 7) continue;
    if (distToPolyline(x, z, MUD_PATH) < 6) continue;
    if (distToPolyline(x, z, RUBBLE_SEAM) < 6) continue;
    if (rocks.some((q) => Math.hypot(q.x - x, q.z - z) < q.r + r + 3)) continue;
    rocks.push({ x, z, r });
  }
  return rocks;
}

export const SMALL_ROCKS = seededRocks();

// --------------------------------------------------------------------- height
// Barbell ridge between the southern start basin and the northern goal shelf.
// West of x~100 it is narrow and high (short, steep crossing); east of x~165 it
// is wide and low (long, gentle crossing).
export function ridgeParams(x) {
  const t = smoothstep((x - 96) / 70);
  return {
    crestZ: 104 + 2.2 * Math.sin(x * 0.03),
    width: 7.0 + 30 * t,
    amp: 11.5 - 4.4 * t,
  };
}

export function heightAt(x, z) {
  let h =
    1.6 * Math.sin(x * 0.052 + 1.1) +
    1.3 * Math.cos(z * 0.058 - 0.6) +
    0.7 * Math.sin((x * 0.8 + z * 0.6) * 0.048);
  h += 0.7 * valueNoise(x * 0.045, z * 0.045);
  h += 0.28 * valueNoise(x * 0.11, z * 0.11);

  const r = ridgeParams(x);
  const q = z - r.crestZ;
  h += r.amp * Math.exp(-(q * q) / (r.width * r.width));

  // Carve the gravel wash into a shallow, flatter valley.
  const dG = distToPolyline(x, z, GRAVEL_PATH);
  h -= 2.4 * Math.exp(-(dG * dG) / (19 * 19));

  return h + 0.3;
}

// -------------------------------------------------------------------- surface
function mudHalfWidth(x) {
  const ford = 3.6 * Math.exp(-(((x - 66) / 8) ** 2));
  const base = 4.6 - 1.6 * smoothstep((x - 130) / 60);
  return Math.max(1.0, base - ford);
}

export function surfaceClassAt(x, z) {
  for (const o of OUTCROPS) {
    const dx = (x - o.x) / o.rx;
    const dz = (z - o.z) / o.rz;
    if (dx * dx + dz * dz <= 1) return SURFACE.impassable;
  }
  for (const r of SMALL_ROCKS) {
    const dx = x - r.x;
    const dz = z - r.z;
    if (dx * dx + dz * dz <= r.r * r.r) return SURFACE.impassable;
  }

  const b = COSTLY_FIELD;
  const bq = ((x - b.x) / b.rx) ** 2 + ((z - b.z) / b.rz) ** 2;
  if (bq <= 1) return SURFACE.costly;

  if (distToPolyline(x, z, RUBBLE_SEAM) <= 0.35) return SURFACE.costly;

  if (distToPolyline(x, z, MUD_PATH) <= mudHalfWidth(x)) return SURFACE.mud;

  if (distToPolyline(x, z, GRAVEL_PATH) <= 3.6) return SURFACE.gravel;

  return SURFACE.grass;
}
