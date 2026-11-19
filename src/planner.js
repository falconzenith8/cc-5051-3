// Edge integration and A* / Dijkstra search.
//
// Design notes that the UI and the tests both rely on:
//
// * The planner nodes are a coarse lattice (2 m). The *cost* of an edge is not
//   decided by the colour under its endpoints. The edge is rasterised through
//   the fine truth grid (0.2 m) with a supercover traversal, and every cell the
//   segment touches contributes its exact crossed length. A 0.4 m wide mud strip
//   therefore costs something even when both endpoints are grass.
// * Height interpolation is exact: the continuous height field is sampled along
//   the same edge, and slope is the central difference of that same field along
//   the travel direction. Diagonal edges use the same code path as orthogonal
//   edges, so sqrt(2) length and slope are charged consistently.
// * Impassable and merely expensive are distinct surface classes. Impassable
//   cells make an edge invalid; expensive cells keep it finite.
// * The heuristic is min-per-metre-cost * straight-line distance. Base cost is
//   >= minBase on every surface and the grade multiplier is >= 1, so h is
//   admissible and consistent (h(n) <= c(n,m) + h(m)). No weight inflation is
//   used; Dijkstra with h=0 is available as an independent reference.

import { SURFACE } from './config.js';

const EPS = 1e-9;

export function buildProfile(equipment) {
  const base = new Float64Array(5);
  base[SURFACE.grass] = equipment.cost.grass;
  base[SURFACE.gravel] = equipment.cost.gravel;
  base[SURFACE.mud] = equipment.cost.mud;
  base[SURFACE.costly] = equipment.cost.costly;
  base[SURFACE.impassable] = Infinity;
  let minBase = Infinity;
  for (let i = 0; i < 4; i++) minBase = Math.min(minBase, base[i]);
  return {
    base,
    minBase,
    up: equipment.grade.up,
    down: equipment.grade.down,
    maxGrade: equipment.maxGrade,
  };
}

export function buildModel({ width, depth, cell, spacing, surfaceAt, heightAt }) {
  const nx = Math.round(width / cell);
  const nz = Math.round(depth / cell);
  const classes = new Uint8Array(nx * nz);
  for (let j = 0; j < nz; j++) {
    const z = (j + 0.5) * cell;
    for (let i = 0; i < nx; i++) {
      classes[j * nx + i] = surfaceAt((i + 0.5) * cell, z);
    }
  }
  return {
    width, depth, cell, spacing,
    nx, nz, classes,
    nodeNx: Math.floor((width - cell) / spacing) + 1,
    nodeNz: Math.floor((depth - cell) / spacing) + 1,
    heightAt,
    classAt(x, z) {
      const i = Math.min(nx - 1, Math.max(0, Math.floor(x / cell)));
      const j = Math.min(nz - 1, Math.max(0, Math.floor(z / cell)));
      return classes[j * nx + i];
    },
  };
}

// Visit every fine cell the segment touches, in order, with its exact crossed
// length. Cells touched only at a corner are reported with length 0; they still
// take part in the impassability check, which closes the diagonal "slip through
// a corner" loophole.
function traverseCells(model, ax, az, bx, bz, visit) {
  const { cell, nx, nz } = model;
  const dx = bx - ax;
  const dz = bz - az;
  const len = Math.hypot(dx, dz);
  if (len < EPS) return len;

  let ix = Math.min(nx - 1, Math.max(0, Math.floor(ax / cell)));
  let iz = Math.min(nz - 1, Math.max(0, Math.floor(az / cell)));
  const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
  const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0;
  const tDeltaX = stepX === 0 ? Infinity : cell / Math.abs(dx);
  const tDeltaZ = stepZ === 0 ? Infinity : cell / Math.abs(dz);
  let tMaxX = stepX === 0 ? Infinity
    : stepX > 0 ? ((ix + 1) * cell - ax) / Math.abs(dx) : (ax - ix * cell) / Math.abs(dx);
  let tMaxZ = stepZ === 0 ? Infinity
    : stepZ > 0 ? ((iz + 1) * cell - az) / Math.abs(dz) : (az - iz * cell) / Math.abs(dz);

  let t = 0;
  let guard = 0;
  while (guard++ < nx + nz + 8) {
    const tNext = Math.min(tMaxX, tMaxZ, 1);
    visit(ix, iz, t, tNext, (tNext - t) * len);
    if (tNext >= 1 - 1e-12) break;

    if (Math.abs(tMaxX - tMaxZ) < 1e-9) {
      // Exact corner crossing: the segment touches both side cells at a point.
      const sx = Math.min(nx - 1, Math.max(0, ix + stepX));
      const sz = Math.min(nz - 1, Math.max(0, iz + stepZ));
      visit(sx, iz, tNext, tNext, 0);
      visit(ix, sz, tNext, tNext, 0);
      ix = sx;
      iz = sz;
      tMaxX += tDeltaX;
      tMaxZ += tDeltaZ;
    } else if (tMaxX < tMaxZ) {
      ix = Math.min(nx - 1, Math.max(0, ix + stepX));
      tMaxX += tDeltaX;
    } else {
      iz = Math.min(nz - 1, Math.max(0, iz + stepZ));
      tMaxZ += tDeltaZ;
    }
    t = tNext;
  }
  return len;
}

const GRADE_PROBES = [1 / 6, 1 / 2, 5 / 6];

export function evaluateEdge(model, profile, ax, az, bx, bz) {
  const dx = bx - ax;
  const dz = bz - az;
  const len = Math.hypot(dx, dz);
  if (len < EPS) return { ok: false, reason: 'zero-length' };
  const ux = dx / len;
  const uz = dz / len;

  const surfaces = [0, 0, 0, 0, 0];
  let cost = 0;
  let baseCost = 0;
  let upExtra = 0;
  let downExtra = 0;
  let steepest = 0;
  let blocked = null;
  let costlyMetres = 0;

  traverseCells(model, ax, az, bx, bz, (ix, iz, t0, t1, segLen) => {
    const cls = model.classes[iz * model.nx + ix];
    if (cls === SURFACE.impassable) {
      blocked = 'impassable';
      return;
    }
    if (segLen <= 0) return;
    surfaces[cls] += segLen;
    if (cls === SURFACE.costly) costlyMetres += segLen;

    const base = profile.base[cls];
    const mid = (t0 + t1) * 0.5;
    // Probe the same slope a few times inside the cell so a narrow steep lip is
    // not missed by a single midpoint sample.
    for (const f of GRADE_PROBES) {
      const tt = t0 + (t1 - t0) * f;
      const px = ax + dx * tt;
      const pz = az + dz * tt;
      const g = (model.heightAt(px + ux * 0.1, pz + uz * 0.1)
        - model.heightAt(px - ux * 0.1, pz - uz * 0.1)) / 0.2;
      if (Math.abs(g) > profile.maxGrade + 1e-9) blocked = 'too-steep';
      steepest = Math.max(steepest, Math.abs(g));
      const factor = g >= 0 ? 1 + profile.up * g : 1 + profile.down * -g;
      const c = (segLen / GRADE_PROBES.length) * base * factor;
      cost += c;
      baseCost += (segLen / GRADE_PROBES.length) * base;
      if (g >= 0) upExtra += (segLen / GRADE_PROBES.length) * base * profile.up * g;
      else downExtra += (segLen / GRADE_PROBES.length) * base * profile.down * -g;
    }
  });

  if (blocked) return { ok: false, reason: blocked };
  return {
    ok: true,
    length: len,
    cost,
    baseCost,
    upExtra,
    downExtra,
    slopeExtra: cost - baseCost,
    steepest,
    costlyMetres,
    surfaces,
    from: { x: ax, z: az },
    to: { x: bx, z: bz },
  };
}

// ------------------------------------------------------------------ heap
class MinHeap {
  constructor(cmp) { this.a = []; this.cmp = cmp; }
  get size() { return this.a.length; }
  push(v) {
    const a = this.a;
    a.push(v);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.cmp(a[p], a[i]) <= 0) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && this.cmp(a[l], a[m]) < 0) m = l;
        if (r < a.length && this.cmp(a[r], a[m]) < 0) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

const NEIGHBOURS = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [1, -1], [-1, 1], [-1, -1],
];

function snapNode(model, p) {
  const ix = Math.round((p.x - model.cell * 0.5) / model.spacing);
  const iz = Math.round((p.z - model.cell * 0.5) / model.spacing);
  return {
    ix: Math.min(model.nodeNx - 1, Math.max(0, ix)),
    iz: Math.min(model.nodeNz - 1, Math.max(0, iz)),
  };
}

// Nodes are offset by half a fine cell so axis-aligned edges run through cell
// interiors. Placing them exactly on the 0.2 m lattice (2.0 is a multiple of
// 0.2) would make those edges graze cell borders, where which side owns the
// length is an arbitrary tie — an avoidable sampling artefact.
const nodeX = (model, ix) => ix * model.spacing + model.cell * 0.5;
const nodeZ = (model, iz) => iz * model.spacing + model.cell * 0.5;

export function solve(model, profile, start, goal, opts = {}) {
  return solveWith(model, profile, start, goal, opts, evaluateEdge);
}

// Same search loop, pluggable edge pricing. Used by the tests to run a
// deliberately naive "one surface colour per node" model and show that it both
// finds a different route and misprices it. The app always uses evaluateEdge.
// Deliberately naive edge model: one surface sample per node, straight-line
// height difference for slope. It exists so the tests (and the UI's honesty
// panel) can show what would be missed if the fine lattice were not traversed.
export function evaluateCoarseEdge(model, profile, ax, az, bx, bz) {
  const dx = bx - ax;
  const dz = bz - az;
  const len = Math.hypot(dx, dz);
  if (len < EPS) return { ok: false, reason: 'zero-length' };
  const cls = model.classAt(ax, az);
  if (cls === SURFACE.impassable) return { ok: false, reason: 'impassable' };
  const g = (model.heightAt(bx, bz) - model.heightAt(ax, az)) / len;
  if (Math.abs(g) > profile.maxGrade + 1e-9) return { ok: false, reason: 'too-steep' };
  const factor = g >= 0 ? 1 + profile.up * g : 1 + profile.down * -g;
  const base = profile.base[cls];
  return {
    ok: true,
    length: len,
    cost: len * base * factor,
    baseCost: len * base,
    upExtra: g >= 0 ? len * base * profile.up * g : 0,
    downExtra: g < 0 ? len * base * profile.down * -g : 0,
    slopeExtra: len * base * (factor - 1),
    steepest: Math.abs(g),
    costlyMetres: cls === SURFACE.costly ? len : 0,
    surfaces: [cls === 0 ? len : 0, cls === 1 ? len : 0, cls === 2 ? len : 0, cls === 3 ? len : 0, 0],
    from: { x: ax, z: az },
    to: { x: bx, z: bz },
  };
}

export function solveWith(model, profile, start, goal, opts, edgeFn) {
  const useHeuristic = opts.heuristic !== false;
  const goalNode = snapNode(model, goal);
  const startNode = snapNode(model, start);
  if (model.classAt(nodeX(model, startNode.ix), nodeZ(model, startNode.iz)) === SURFACE.impassable) {
    return { ok: false, reason: 'start-impassable' };
  }
  if (model.classAt(nodeX(model, goalNode.ix), nodeZ(model, goalNode.iz)) === SURFACE.impassable) {
    return { ok: false, reason: 'goal-impassable' };
  }

  const n = model.nodeNx * model.nodeNz;
  const gScore = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const edgeOf = new Array(n);
  const startId = startNode.iz * model.nodeNx + startNode.ix;
  const goalId = goalNode.iz * model.nodeNx + goalNode.ix;
  const gx = nodeX(model, goalNode.ix);
  const gz = nodeZ(model, goalNode.iz);

  const h = (ix, iz) => {
    if (!useHeuristic) return 0;
    return profile.minBase * Math.hypot(nodeX(model, ix) - gx, nodeZ(model, iz) - gz);
  };

  const heap = new MinHeap((a, b) => a.f - b.f || a.h - b.h || a.id - b.id);
  gScore[startId] = 0;
  heap.push({ id: startId, ix: startNode.ix, iz: startNode.iz, f: h(startNode.ix, startNode.iz), h: h(startNode.ix, startNode.iz) });
  let expanded = 0;
  let found = false;

  while (heap.size) {
    const cur = heap.pop();
    if (closed[cur.id]) continue;
    closed[cur.id] = 1;
    expanded++;
    if (cur.id === goalId) { found = true; break; }

    for (const [ox, oz] of NEIGHBOURS) {
      const nx2 = cur.ix + ox;
      const nz2 = cur.iz + oz;
      if (nx2 < 0 || nz2 < 0 || nx2 >= model.nodeNx || nz2 >= model.nodeNz) continue;
      const nid = nz2 * model.nodeNx + nx2;
      if (closed[nid]) continue;
      const ax = nodeX(model, cur.ix);
      const az = nodeZ(model, cur.iz);
      const bx = nodeX(model, nx2);
      const bz = nodeZ(model, nz2);
      const e = edgeFn(model, profile, ax, az, bx, bz);
      if (!e.ok) continue;
      const tentative = gScore[cur.id] + e.cost;
      if (tentative + 1e-9 < gScore[nid]) {
        gScore[nid] = tentative;
        prev[nid] = cur.id;
        edgeOf[nid] = e;
        const hh = h(nx2, nz2);
        heap.push({ id: nid, ix: nx2, iz: nz2, f: tentative + hh, h: hh });
      }
    }
  }

  if (!found) return { ok: false, reason: 'unreachable', expanded };

  const path = [];
  const edges = [];
  let id = goalId;
  while (id !== -1) {
    const iz = Math.floor(id / model.nodeNx);
    const ix = id - iz * model.nodeNx;
    path.push({ x: nodeX(model, ix), z: nodeZ(model, iz) });
    if (prev[id] !== -1) edges.push(edgeOf[id]);
    id = prev[id];
  }
  path.reverse();
  edges.reverse();

  const totals = { surfaces: [0, 0, 0, 0, 0], baseCost: 0, upExtra: 0, downExtra: 0, costlyMetres: 0 };
  let cost = 0;
  for (const e of edges) {
    cost += e.cost;
    totals.baseCost += e.baseCost;
    totals.upExtra += e.upExtra;
    totals.downExtra += e.downExtra;
    totals.costlyMetres += e.costlyMetres;
    for (let i = 0; i < 5; i++) totals.surfaces[i] += e.surfaces[i];
  }

  return {
    ok: true,
    path,
    edges,
    cost,
    totals,
    expanded,
    start: { x: nodeX(model, startNode.ix), z: nodeZ(model, startNode.iz) },
    goal: { x: gx, z: gz },
  };
}

// Independent recomputation of a path's cost with a different sampling rate.
// Used by the UI verification panel and the tests: if the edge integration is
// genuinely distance/surface/slope based, sampling at 0.05 m and at 0.1 m must
// agree up to the fine-cell boundary effect, and both must agree with the
// planner's summed edge cost.
export function reintegratePath(model, profile, path, step = 0.05) {
  let cost = 0;
  let baseCost = 0;
  let upExtra = 0;
  let downExtra = 0;
  const surfaces = [0, 0, 0, 0, 0];
  let worstGap = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i];
    const b = path[i + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dz);
    if (len === 0) continue;
    const ux = dx / len;
    const uz = dz / len;
    const n = Math.max(1, Math.ceil(len / step));
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) / n;
      const px = a.x + dx * t;
      const pz = a.z + dz * t;
      const cls = model.classAt(px, pz);
      if (cls === SURFACE.impassable) return { ok: false, reason: 'crosses-impassable' };
      const dl = len / n;
      const base = profile.base[cls];
      const g = (model.heightAt(px + ux * 0.05, pz + uz * 0.05)
        - model.heightAt(px - ux * 0.05, pz - uz * 0.05)) / 0.1;
      worstGap = Math.max(worstGap, Math.abs(g));
      const factor = g >= 0 ? 1 + profile.up * g : 1 + profile.down * -g;
      const c = dl * base * factor;
      cost += c;
      baseCost += dl * base;
      if (g >= 0) upExtra += dl * base * profile.up * g;
      else downExtra += dl * base * profile.down * -g;
      surfaces[cls] += dl;
    }
  }
  return { ok: true, cost, baseCost, upExtra, downExtra, surfaces, steepest: worstGap };
}

export function verifyHeuristic(model, profile, samples = 2000, seed = 12345) {
  let s = seed >>> 0;
  const rnd = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const gx = nodeX(model, model.nodeNx - 1);
  const gz = nodeZ(model, model.nodeNz - 1);
  let worst = -Infinity;
  let checked = 0;
  for (let k = 0; k < samples; k++) {
    const ix = Math.floor(rnd() * model.nodeNx);
    const iz = Math.floor(rnd() * model.nodeNz);
    const [ox, oz] = NEIGHBOURS[Math.floor(rnd() * NEIGHBOURS.length)];
    const jx = ix + ox;
    const jz = iz + oz;
    if (jx < 0 || jz < 0 || jx >= model.nodeNx || jz >= model.nodeNz) continue;
    const e = evaluateEdge(model, profile, nodeX(model, ix), nodeZ(model, iz), nodeX(model, jx), nodeZ(model, jz));
    if (!e.ok) continue;
    const h1 = profile.minBase * Math.hypot(nodeX(model, ix) - gx, nodeZ(model, iz) - gz);
    const h2 = profile.minBase * Math.hypot(nodeX(model, jx) - gx, nodeZ(model, jz) - gz);
    worst = Math.max(worst, h1 - (e.cost + h2));
    checked++;
  }
  return { checked, worstViolation: worst, consistent: worst <= 1e-9 };
}
