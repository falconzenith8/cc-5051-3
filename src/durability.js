// Durability-aware routing.
//
// Two solvers live here, on the same terrain model as src/planner.js:
//
//   solveDurability  — exact augmented-state search. A state is (node, d) where
//                      d is remaining gear durability; Pareto-optimal labels per
//                      node keep every (cost, durability) pair that is not
//                      dominated. Dominance is the only pruning, so a cheap path
//                      that arrives worn is never deleted by a dearer-in-fact
//                      shorter path.
//   solveHierarchical— coarse base-cost path first, then a durability-aware
//                      refinement restricted to a corridor around the coarse
//                      line. The coarse layer cannot see the durability gate,
//                      so it can commit to a corridor that the gear cannot finish;
//                      the fallback widens the corridor and finally runs the full
//                      exact search.
//
// Both solvers price edges with evaluateDurabilityEdge: mud costs little but
// strips durability, and the lost durability is repaid later as a fatigue
// surcharge plus a hard gate on scree (gravel/costly) edges.

import { SURFACE, DURABILITY } from './config.js';
import {
  evaluateEdge, solve as plannerSolve, MinHeap, NEIGHBOURS, snapNode, nodeX, nodeZ,
} from './planner.js';

const EPS = 1e-9;

function wearTable(dcfg) {
  return [
    dcfg.wear.grass,
    dcfg.wear.gravel,
    dcfg.wear.mud,
    dcfg.wear.costly,
    0,
  ];
}

// Floor to an integer bucket. Flooring is deliberately conservative: the
// search never believes it has more durability than the continuous transition
// would give it, so a gate decision can never be optimistic.
export function bucket(d, max = DURABILITY.max) {
  return Math.max(0, Math.min(max, Math.floor(d + 1e-9)));
}

function supplyAt(model, ix, iz, supplies, dcfg) {
  if (!supplies.length) return null;
  const x = nodeX(model, ix);
  const z = nodeZ(model, iz);
  for (const s of supplies) {
    if (Math.hypot(x - s.x, z - s.z) <= dcfg.supplyRadius) return s;
  }
  return null;
}

// One physical edge plus its durability transition.
//   entry durability dIn  -> wear from every crossed fine cell -> dOut,
//   with a supply cache on the destination node restoring the gear to full.
// The fatigue multiplier uses the entry durability; edges are ~2 m, so the
// within-edge change is small and the state semantics stay a clean transition.
export function evaluateDurabilityEdge(model, profile, ax, az, bx, bz, dIn, supplies, dcfg = DURABILITY) {
  const e = evaluateEdge(model, profile, ax, az, bx, bz);
  if (!e.ok) return e;

  let gated = false;
  for (const cls of dcfg.gatedClasses) {
    if (e.surfaces[cls] > 1e-6) { gated = true; break; }
  }
  if (gated && dIn < dcfg.gateThreshold) {
    return { ok: false, reason: 'durability-gate', gated: true, durabilityIn: dIn, base: e };
  }

  const wear = wearTable(dcfg);
  let totalWear = 0;
  for (let c = 0; c < 4; c++) totalWear += e.surfaces[c] * wear[c];
  let dOut = bucket(dIn - totalWear, dcfg.max);

  const destIx = Math.round((bx - model.cell * 0.5) / model.spacing);
  const destIz = Math.round((bz - model.cell * 0.5) / model.spacing);
  const supply = supplyAt(model, destIx, destIz, supplies, dcfg);
  const supplied = Boolean(supply);
  if (supplied) dOut = dcfg.supplyRestore >= dcfg.max ? dcfg.max : bucket(dcfg.supplyRestore, dcfg.max);

  const factor = 1 + dcfg.fatigue * (1 - dIn / dcfg.max);
  return {
    ...e,
    ok: true,
    durabilityIn: bucket(dIn, dcfg.max),
    durabilityOut: dOut,
    wear: totalWear,
    gated,
    supplied,
    supplyId: supply ? supply.id : null,
    factor,
    chargedCost: e.cost * factor,
  };
}

function labelDominates(a, b) {
  // a is cheaper or equal AND reaches with at least as much durability.
  return a.g <= b.g + EPS && a.d >= b.d && (a.g < b.g - EPS || a.d > b.d);
}

// Core augmented-state label-correcting search. When singleLabel is true it
// keeps only the cheapest label per node — the deliberately broken pruning the
// debugger uses to show why an early state discard destroys optimality.
export function searchDurability(model, profile, start, goal, opts = {}) {
  const {
    supplies = [],
    startDurability = DURABILITY.start,
    singleLabel = false,
    allowed = null,       // Set of node ids the search may enter (hierarchical corridor)
    dcfg = DURABILITY,
    neighbors = NEIGHBOURS,
  } = opts;
  const stateKey = (id, d) => id * (dcfg.max + 1) + d;

  const goalNode = snapNode(model, goal);
  const startNode = snapNode(model, start);
  const startId = startNode.iz * model.nodeNx + startNode.ix;
  const goalId = goalNode.iz * model.nodeNx + goalNode.ix;
  const gx = nodeX(model, goalNode.ix);
  const gz = nodeZ(model, goalNode.iz);

  if (allowed && !allowed.has(startId)) return { ok: false, reason: 'corridor-misses-start', expanded: 0 };
  if (allowed && !allowed.has(goalId)) return { ok: false, reason: 'corridor-misses-goal', expanded: 0 };

  const h = (ix, iz) =>
    profile.minBase * Math.hypot(nodeX(model, ix) - gx, nodeZ(model, iz) - gz);

  // labelsByNode: id -> array of live labels { key, d, g, prevKey, edge }
  const labelsByNode = new Map();
  const recordByKey = new Map();
  const closed = new Set();
  const heap = new MinHeap((a, b) => a.f - b.f || a.h - b.h || a.key - b.key);
  const debugEvents = [];
  let peakLabels = 1;
  let expanded = 0;
  let relaxed = 0;

  const startD = bucket(startDurability, dcfg.max);
  const startKey = stateKey(startId, startD);
  const startLabel = { key: startKey, id: startId, d: startD, g: 0, prevKey: -1, edge: null };
  labelsByNode.set(startId, [startLabel]);
  recordByKey.set(startKey, startLabel);
  heap.push({ key: startKey, id: startId, ix: startNode.ix, iz: startNode.iz, d: startD, g: 0,
    f: h(startNode.ix, startNode.iz), h: h(startNode.ix, startNode.iz) });

  let goalKey = -1;

  while (heap.size) {
    const cur = heap.pop();
    if (closed.has(cur.key)) continue;
    closed.add(cur.key);
    expanded++;
    if (cur.id === goalId) { goalKey = cur.key; break; }

    for (const [ox, oz] of neighbors) {
      const nx2 = cur.ix + ox;
      const nz2 = cur.iz + oz;
      if (nx2 < 0 || nz2 < 0 || nx2 >= model.nodeNx || nz2 >= model.nodeNz) continue;
      const nid = nz2 * model.nodeNx + nx2;
      if (allowed && !allowed.has(nid)) continue;

      const ax = nodeX(model, cur.ix);
      const az = nodeZ(model, cur.iz);
      const bx = nodeX(model, nx2);
      const bz = nodeZ(model, nz2);
      const e = evaluateDurabilityEdge(model, profile, ax, az, bx, bz, cur.d, supplies, dcfg);
      if (!e.ok) continue;

      const ng = cur.g + e.chargedCost;
      const candidate = { g: ng, d: e.durabilityOut };
      let labels = labelsByNode.get(nid);
      if (!labels) { labels = []; labelsByNode.set(nid, labels); }

      if (labels.some((l) => labelDominates(l, candidate))) continue;

      if (singleLabel && labels.length && nid !== goalId) {
        // The buggy rule the debugger replays: one label slot per node, and the
        // first arrival occupies it forever. Every later state — even a more
        // durable one — is discarded at this node. A following gate can then
        // make the surviving label fail while the dropped one would have passed.
        const kept = labels[0];
        debugEvents.push({
          type: 'single-label-drop',
          node: nid, ix: nx2, iz: nz2,
          kept: { g: kept.g, d: kept.d },
          dropped: { g: ng, d: e.durabilityOut },
          atKey: cur.key,
        });
        continue;
      }

      // Correct rule: insert, then drop every existing label the new one dominates.
      const survivors = labels.filter((l) => !labelDominates(candidate, l));
      const key = stateKey(nid, candidate.d);
      const nl = { key, id: nid, d: candidate.d, g: candidate.g, prevKey: cur.key, edge: e };
      survivors.push(nl);
      labelsByNode.set(nid, survivors);
      recordByKey.set(key, nl);
      peakLabels = Math.max(peakLabels, survivors.length);
      heap.push({ key, id: nid, ix: nx2, iz: nz2, d: candidate.d, g: candidate.g,
        f: candidate.g + h(nx2, nz2), h: h(nx2, nz2) });
      relaxed++;
    }
  }

  if (goalKey < 0) {
    return {
      ok: false, reason: allowed ? 'unreachable-in-corridor' : 'unreachable',
      expanded, relaxed, peakLabels, debugEvents,
    };
  }

  const path = [];
  const edges = [];
  let key = goalKey;
  const finalDurability = recordByKey.get(goalKey).d;
  const visitedStates = new Set();
  while (key !== -1 && !visitedStates.has(key)) {
    visitedStates.add(key);
    const rec = recordByKey.get(key);
    const iz = Math.floor(rec.id / model.nodeNx);
    const ix = rec.id - iz * model.nodeNx;
    path.push({ x: nodeX(model, ix), z: nodeZ(model, iz) });
    if (rec.edge) edges.push(rec.edge);
    key = rec.prevKey;
  }
  path.reverse();
  edges.reverse();

  const totals = summarizeEdges(edges);
  return {
    ok: true,
    path,
    edges,
    cost: totals.cost,
    totals,
    expanded,
    relaxed,
    peakLabels,
    finalDurability,
    debugEvents,
    start: { x: nodeX(model, startNode.ix), z: nodeZ(model, startNode.iz) },
    goal: { x: gx, z: gz },
  };
}

function summarizeEdges(edges) {
  const surfaces = [0, 0, 0, 0, 0];
  let cost = 0;
  let baseCost = 0;
  let wear = 0;
  let length = 0;
  let supplied = 0;
  for (const e of edges) {
    cost += e.chargedCost;
    baseCost += e.cost;
    wear += e.wear;
    length += e.length;
    if (e.supplied) supplied++;
    for (let i = 0; i < 5; i++) surfaces[i] += e.surfaces[i];
  }
  return { cost, baseCost, wear, length, surfaces, suppliesUsed: supplied };
}

// Convenience wrapper with the exact-search defaults the app uses.
export function solveDurability(model, profile, start, goal, opts = {}) {
  return searchDurability(model, profile, start, goal, { singleLabel: false, ...opts });
}

// ------------------------------------------------------------- hierarchical
// Phase 1 ignores durability entirely: a plain A* on physical cost gives the
// coarse corridor. Phase 2 re-runs the exact (node, d) search but only on nodes
// inside a metric corridor around that coarse line. A corridor that the gear
// cannot traverse is widened, and the last resort is the unrestricted exact
// search.
export function solveHierarchical(model, profile, start, goal, opts = {}) {
  const {
    supplies = [],
    startDurability = DURABILITY.start,
    corridorInflation = 1,
    maxWidenings = 2,
    coarseSolve = null,   // injectable for tests; defaults to durability-blind A*
    dcfg = DURABILITY,
    neighbors = NEIGHBOURS,
  } = opts;

  const trace = [];
  let coarse;
  if (coarseSolve) {
    coarse = coarseSolve(model, profile, start, goal);
  } else {
    coarse = plannerSolve(model, profile, start, goal, { heuristic: true });
  }
  if (!coarse.ok) return { ok: false, reason: coarse.reason, trace, expanded: 0 };
  trace.push({ phase: 'coarse', expanded: coarse.expanded, cost: coarse.cost });

  let inflation = corridorInflation;
  let last = null;
  for (let pass = 0; pass <= maxWidenings; pass++) {
    const allowed = corridorNodes(model, coarse.path, inflation, neighbors);
    const refined = searchDurability(model, profile, start, goal, {
      supplies, startDurability, allowed, dcfg, neighbors,
    });
    trace.push({
      phase: pass === 0 ? 'refine' : 'refine-widened',
      inflation,
      expanded: refined.expanded,
      ok: refined.ok,
      reason: refined.ok ? null : refined.reason,
      corridorSize: allowed.size,
    });
    if (refined.ok) {
      return {
        ...refined,
        coarseCost: coarse.cost,
        coarsePath: coarse.path,
        corridorInflation: inflation,
        fellBack: false,
        trace,
      };
    }
    last = refined;
    inflation += 1;
  }

  // Final fallback: the exact search over the whole lattice.
  const exact = searchDurability(model, profile, start, goal, {
    supplies, startDurability, dcfg, neighbors,
  });
  trace.push({
    phase: 'full-exact-fallback',
    expanded: exact.expanded,
    ok: exact.ok,
    reason: exact.ok ? null : exact.reason,
  });
  if (!exact.ok) return { ...exact, trace, fellBack: true, fallbackReason: last && last.reason };
  return {
    ...exact,
    coarseCost: coarse.cost,
    coarsePath: coarse.path,
    corridorInflation: inflation - 1,
    fellBack: true,
    fallbackReason: last && last.reason,
    trace,
  };
}

// Topological corridor: every node within `inflation` lattice steps of a node
// the coarse polyline passes through. Inflation 0 is the coarse line itself;
// each widening adds one lattice layer. A detour behind a wall is only reached
// by the full-lattice fallback, never by corridor inflation.
export function corridorNodes(model, coarsePath, inflation, neighborOffsets = NEIGHBOURS) {
  const onLine = new Set();
  const idAt = (ix, iz) => iz * model.nodeNx + ix;
  for (const p of coarsePath) {
    const ix = Math.round((p.x - model.cell * 0.5) / model.spacing);
    const iz = Math.round((p.z - model.cell * 0.5) / model.spacing);
    onLine.add(idAt(
      Math.min(model.nodeNx - 1, Math.max(0, ix)),
      Math.min(model.nodeNz - 1, Math.max(0, iz)),
    ));
  }
  const allowed = new Set(onLine);
  let frontier = [...onLine];
  for (let layer = 0; layer < inflation; layer++) {
    const next = [];
    for (const id of frontier) {
      const iz = Math.floor(id / model.nodeNx);
      const ix = id - iz * model.nodeNx;
      for (const [ox, oz] of neighborOffsets) {
        const jx = ix + ox;
        const jz = iz + oz;
        if (jx < 0 || jz < 0 || jx >= model.nodeNx || jz >= model.nodeNz) continue;
        const nid = idAt(jx, jz);
        if (!allowed.has(nid)) { allowed.add(nid); next.push(nid); }
      }
    }
    frontier = next;
  }
  return allowed;
}
