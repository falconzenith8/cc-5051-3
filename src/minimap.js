// Enumerable minimaps and their reference solutions.
//
// The main terrain is a continuous fine-grid world; the correctness arguments
// about durability states are easier to make on a tiny explicit graph where
// every simple path can be enumerated. A minimap is a weighted graph
// (nodes + adjacency list) where each edge declares its surface metres, so the
// same durability transition rules apply: mud wears the gear, scree is gated
// by remaining durability, and fatigue inflates the charged cost.
//
// Three maps:
//   MUD_GATE   — the hierarchical solver commits to a cheap mud corridor that
//                strips the gear; only the grass detour survives the scree gate.
//                The exact search and the brute-force enumeration agree; the
//                hierarchical search without fallback disagrees.
//   DIAMOND    — two branches reach the junction with the SAME arrival cost but
//                different remaining durability; the following scree road can
//                only be crossed with the durable label.
//   Both maps are small enough for enumerateSimplePaths() to list every path.

import { SURFACE, DURABILITY } from './config.js';
import { MinHeap } from './planner.js';

const EPS = 1e-9;
const CLASS_KEYS = ['grass', 'gravel', 'mud', 'costly'];

export function makeEdge(from, to, metresBySurface, length = null) {
  const surfaces = [0, 0, 0, 0, 0];
  let totalLen = 0;
  for (const [key, metres] of Object.entries(metresBySurface)) {
    surfaces[SURFACE[key]] = metres;
    totalLen += metres;
  }
  return { from, to, surfaces, length: length ?? totalLen };
}

// A minimap graph: { nodes: [{id,x,z}], edges: [{from,to,surfaces,length}] }.
// Edge lists are undirected; adjacency is built both ways.
export function buildGraph(spec) {
  const adj = new Map();
  for (const n of spec.nodes) adj.set(n.id, []);
  const undirected = [];
  for (const e of spec.edges) {
    undirected.push(e);
    undirected.push({ ...e, from: e.to, to: e.from, surfaces: e.surfaces, length: e.length });
  }
  for (const e of undirected) {
    if (!adj.has(e.from) || !adj.has(e.to)) {
      throw new Error(`edge references unknown node: ${e.from}->${e.to}`);
    }
    adj.get(e.from).push(e);
  }
  return { ...spec, adj, nodeCount: spec.nodes.length };
}

function wearOfEdge(edge, dcfg) {
  let wear = 0;
  for (let c = 0; c < 4; c++) {
    wear += edge.surfaces[c] * dcfg.wear[CLASS_KEYS[c]];
  }
  return wear;
}

function gatedEdge(edge, dcfg) {
  for (const cls of dcfg.gatedClasses) {
    if (edge.surfaces[cls] > 1e-9) return true;
  }
  return false;
}

function floorBucket(d, max) {
  return Math.max(0, Math.min(max, Math.floor(d + 1e-9)));
}

// Apply one edge transition. Returns null when the durability gate blocks it.
export function transition(graph, edge, dIn, supplies = [], dcfg = DURABILITY) {
  if (gatedEdge(edge, dcfg) && dIn < dcfg.gateThreshold) return null;
  let dOut = floorBucket(dIn - wearOfEdge(edge, dcfg), dcfg.max);
  const node = graph.nodes[edge.to];
  const supplied = supplies.some((s) => Math.hypot(node.x - s.x, node.z - s.z) <= dcfg.supplyRadius);
  if (supplied) dOut = dcfg.supplyRestore >= dcfg.max ? dcfg.max : floorBucket(dcfg.supplyRestore, dcfg.max);

  let base = 0;
  for (let c = 0; c < 4; c++) base += edge.surfaces[c] * graph.profile.base[c];
  const factor = 1 + dcfg.fatigue * (1 - dIn / dcfg.max);
  return {
    edge,
    durabilityIn: floorBucket(dIn, dcfg.max),
    durabilityOut: dOut,
    wear: wearOfEdge(edge, dcfg),
    gated: gatedEdge(edge, dcfg),
    supplied,
    chargedCost: base * factor,
    baseCost: base,
    factor,
  };
}

function dominates(a, b) {
  return a.g <= b.g + EPS && a.d >= b.d && (a.g < b.g - EPS || a.d > b.d);
}

// Exact augmented-state label search on an explicit graph. Same semantics as
// searchDurability in durability.js, but the neighbour set comes from the
// graph's adjacency list. singleLabel switches on the deliberately broken
// one-label-per-node rule for the debugger.
export function solveGraph(graph, startId, goalId, opts = {}) {
  const {
    supplies = [],
    startDurability = DURABILITY.start,
    singleLabel = false,
    dcfg = DURABILITY,
  } = opts;
  const stateKey = (id, d) => id * (dcfg.max + 1) + d;

  const labelsByNode = new Map();
  const recordByKey = new Map();
  const closed = new Set();
  // Dijkstra order (f == g): the cheapest label at every node expands first,
  // and equal-g labels break by insertion/key order so the lower-id mud branch
  // occupies the junction before the grass branch. That is exactly the order
  // under which "one label per node" first-arrival pruning looks harmless yet
  // later kills the only label a raised gate would have accepted.
  const heap = new MinHeap((a, b) => a.g - b.g || a.key - b.key);
  const debugEvents = [];
  let expanded = 0;
  let peakLabels = 1;

  const startD = floorBucket(startDurability, dcfg.max);
  const startKey = stateKey(startId, startD);
  const startLabel = { key: startKey, id: startId, d: startD, g: 0, prevKey: -1, edge: null };
  labelsByNode.set(startId, [startLabel]);
  recordByKey.set(startKey, startLabel);
  heap.push({ key: startKey, id: startId, d: startD, g: 0 });

  let goalKey = -1;
  while (heap.size) {
    const cur = heap.pop();
    if (closed.has(cur.key)) continue;
    closed.add(cur.key);
    expanded++;
    if (cur.id === goalId) { goalKey = cur.key; break; }

    for (const edge of graph.adj.get(cur.id)) {
      const step = transition(graph, edge, cur.d, supplies, dcfg);
      if (!step) continue;
      const ng = cur.g + step.chargedCost;
      const candidate = { g: ng, d: step.durabilityOut };
      let labels = labelsByNode.get(edge.to);
      if (!labels) { labels = []; labelsByNode.set(edge.to, labels); }
      if (labels.some((l) => dominates(l, candidate))) continue;

      if (singleLabel && labels.length && edge.to !== goalId) {
        // The buggy rule the debugger replays: one label slot per node, and the
        // first arrival occupies it forever. Every later state — even a more
        // durable one — is discarded at this node. A following gate can then
        // make the surviving label fail while the dropped one would have passed.
        const kept = labels[0];
        debugEvents.push({
          type: 'single-label-drop',
          node: edge.to,
          kept: { g: kept.g, d: kept.d },
          dropped: { g: ng, d: step.durabilityOut },
          atKey: cur.key,
        });
        continue;
      }

      const survivors = labels.filter((l) => !dominates(candidate, l));
      const key = stateKey(edge.to, candidate.d);
      const nl = { key, id: edge.to, d: candidate.d, g: candidate.g, prevKey: cur.key, edge: step };
      survivors.push(nl);
      labelsByNode.set(edge.to, survivors);
      recordByKey.set(key, nl);
      peakLabels = Math.max(peakLabels, survivors.length);
      heap.push({ key, id: edge.to, d: candidate.d, g: candidate.g });
    }
  }

  if (goalKey < 0) {
    return { ok: false, reason: 'unreachable', expanded, peakLabels, debugEvents };
  }

  const nodePath = [];
  const steps = [];
  const visited = new Set();
  let key = goalKey;
  const goalRecord = recordByKey.get(goalKey);
  const finalDurability = goalRecord.d;
  while (key !== -1 && !visited.has(key)) {
    visited.add(key);
    const rec = recordByKey.get(key);
    nodePath.push(rec.id);
    if (rec.edge) steps.push(rec.edge);
    key = rec.prevKey;
  }
  nodePath.reverse();
  steps.reverse();
  const cost = steps.reduce((a, s) => a + s.chargedCost, 0);
  const wear = steps.reduce((a, s) => a + s.wear, 0);
  return {
    ok: true,
    nodePath,
    steps,
    cost,
    wear,
    finalDurability,
    expanded,
    peakLabels,
    debugEvents,
  };
}

// ------------------------------------------------------------- brute force
// Enumerate every simple path from start to goal and apply the durability
// transition along each. The minimum charged cost among feasible paths is the
// reference optimum. Feasible only because the maps are tiny.
export function enumerateSimplePaths(graph, startId, goalId, opts = {}) {
  const { supplies = [], startDurability = DURABILITY.start, dcfg = DURABILITY, cap = 200000 } = opts;
  const results = [];
  let truncated = false;
  let visits = 0;

  function dfs(id, d, g, pathNodes, pathEdges, seen) {
    if (visits++ > cap) { truncated = true; return; }
    if (id === goalId) {
      results.push({ nodePath: [...pathNodes], steps: [...pathEdges], cost: g, finalDurability: d });
      return;
    }
    for (const edge of graph.adj.get(id)) {
      if (seen.has(edge.to)) continue;
      const step = transition(graph, edge, d, supplies, dcfg);
      if (!step) continue;
      seen.add(edge.to);
      pathEdges.push(step);
      pathNodes.push(edge.to);
      dfs(edge.to, step.durabilityOut, g + step.chargedCost, pathNodes, pathEdges, seen);
      pathNodes.pop();
      pathEdges.pop();
      seen.delete(edge.to);
    }
  }

  dfs(startId, floorBucket(startDurability, dcfg.max), 0, [startId], [], new Set([startId]));
  if (!results.length) {
    return { ok: false, reason: truncated ? 'enumeration-cap' : 'unreachable', paths: [], truncated, visits };
  }
  results.sort((a, b) => a.cost - b.cost || b.finalDurability - a.finalDurability);
  return {
    ok: true,
    paths: results,
    optimum: results[0],
    pathCount: results.length,
    visits,
    truncated,
  };
}

// ------------------------------------------------------------- hierarchical
// Durability-blind coarse layer: shortest base cost on the graph, then a
// durability-aware refinement restricted to the nodes the coarse path visits.
// On MUD_GATE the coarse path is the mud lane and its corridor cannot cross the
// scree gate; the function reports the failure and the caller falls back to the
// full exact label search.
function baseCostOfEdge(graph, edge) {
  let base = 0;
  for (let c = 0; c < 4; c++) base += edge.surfaces[c] * graph.profile.base[c];
  return base;
}

export function solveGraphHierarchical(graph, startId, goalId, opts = {}) {
  const { supplies = [], startDurability = DURABILITY.start, dcfg = DURABILITY } = opts;
  const dist = new Map();
  const prev = new Map();
  const heap = new MinHeap((a, b) => a.g - b.g || a.id - b.id);
  dist.set(startId, 0);
  heap.push({ id: startId, g: 0 });
  let coarseExpanded = 0;
  let coarsePath = null;

  while (heap.size) {
    const cur = heap.pop();
    if (cur.g > (dist.get(cur.id) ?? Infinity) + EPS) continue;
    coarseExpanded++;
    if (cur.id === goalId) {
      const p = [];
      let id = goalId;
      while (id !== undefined) { p.push(id); id = prev.get(id); }
      p.reverse();
      coarsePath = p;
      break;
    }
    for (const edge of graph.adj.get(cur.id)) {
      const ng = cur.g + baseCostOfEdge(graph, edge);
      if (ng + EPS < (dist.get(edge.to) ?? Infinity)) {
        dist.set(edge.to, ng);
        prev.set(edge.to, cur.id);
        heap.push({ id: edge.to, g: ng });
      }
    }
  }
  if (!coarsePath) return { ok: false, reason: 'coarse-unreachable', trace: [{ phase: 'coarse', ok: false }] };

  // Refine on the corridor (exact node set of the coarse path). The same label
  // search runs, but edges leaving the corridor are disallowed by construction:
  // adjacency is filtered to corridor nodes.
  const corridor = new Set(coarsePath);
  const sub = {
    ...graph,
    adj: new Map([...graph.adj].map(([id, edges]) => [
      id,
      corridor.has(id) ? edges.filter((e) => corridor.has(e.to)) : [],
    ])),
  };
  const refined = solveGraph(sub, startId, goalId, { supplies, startDurability, dcfg });
  const trace = [
    { phase: 'coarse', expanded: coarseExpanded, path: coarsePath, baseCost: dist.get(goalId) },
    { phase: 'refine-in-corridor', corridorSize: corridor.size, ok: refined.ok, reason: refined.ok ? null : refined.reason, expanded: refined.expanded },
  ];
  if (refined.ok) {
    return { ...refined, coarsePath, fellBack: false, trace };
  }

  // Fallback criterion: the corridor cannot produce a feasible durability path.
  const exact = solveGraph(graph, startId, goalId, { supplies, startDurability, dcfg });
  trace.push({ phase: 'full-exact-fallback', ok: exact.ok, expanded: exact.expanded, reason: exact.ok ? null : exact.reason });
  return {
    ...exact,
    coarsePath,
    fellBack: true,
    fallbackReason: refined.reason,
    trace,
  };
}

// ------------------------------------------------------------- the maps
// Edge metre tables. A pure-mud 1 m edge, a grass edge, a scree edge, etc.
const mud = (m) => ({ mud: m });
const grass = (m) => ({ grass: m });
const scree = (m) => ({ gravel: m });

// MUD_GATE: a cheap mud lane versus a grass detour, separated so the only
// choices are the two lanes. The lane joins a scree gate at node G.
//
//   S --m1-- A --m2-- B --m3-- J --scree-- G
//   |                         |
//   g1 -------- g2 -------- g3
//
// The mud lane is cheaper per metre but strips durability below the scree
// gate threshold; the grass lane arrives worn less and passes.
export const MUD_GATE = (() => {
  const nodes = [
    { id: 0, x: 0, z: 0, tag: 'S' },
    { id: 1, x: 1, z: 0, tag: 'A' },
    { id: 2, x: 2, z: 0, tag: 'B' },
    { id: 3, x: 3, z: 0, tag: 'J' },
    { id: 4, x: 4, z: 0, tag: 'G' },
    { id: 5, x: 1, z: 2, tag: 'd1' },
    { id: 6, x: 2, z: 2, tag: 'd2' },
    { id: 7, x: 3, z: 2, tag: 'd3' },
  ];
  const edges = [
    makeEdge(0, 1, mud(1)),
    makeEdge(1, 2, mud(1)),
    makeEdge(2, 3, mud(1)),
    makeEdge(3, 4, scree(1)),
    makeEdge(0, 5, grass(1)),
    makeEdge(5, 6, grass(1)),
    makeEdge(6, 7, grass(1)),
    makeEdge(7, 3, grass(1)),
  ];
  return { name: 'mud-gate', nodes, edges, start: 0, goal: 4 };
})();

// DIAMOND: S splits into an upper grass branch and a lower mud branch, both
// reaching junction J. The mud branch is strictly cheaper (the narrative: a
// cheap dirt road) but strips durability; the grass branch costs more and keeps
// the gear intact. From J the only way forward is a scree road to G. With a
// gate above the mud label's remaining durability, a one-label-per-node search
// that keeps the cheap mud label at J discards the durable grass label and
// fails — even though the exact Pareto search keeps both labels and succeeds.
export const DIAMOND = (() => {
  const nodes = [
    { id: 0, x: 0, z: 1, tag: 'S' },
    { id: 1, x: 1, z: 0, tag: 'u1' },
    { id: 2, x: 2, z: 0, tag: 'u2' },
    { id: 3, x: 1, z: 2, tag: 'l1' },
    { id: 4, x: 2, z: 2, tag: 'l2' },
    { id: 5, x: 3, z: 1, tag: 'J' },
    { id: 6, x: 4, z: 1, tag: 'G' },
  ];
  const edges = [
    makeEdge(0, 1, grass(1)),
    makeEdge(1, 2, grass(1)),
    makeEdge(2, 5, grass(1)),
    makeEdge(0, 3, mud(1)),
    makeEdge(3, 4, mud(1)),
    makeEdge(4, 5, mud(1)),
    makeEdge(5, 6, scree(1)),
  ];
  return { name: 'diamond', nodes, edges, start: 0, goal: 6 };
})();

// Tuned durability configuration for the minimap gear. Mud is cheap per metre
// (mud base < grass base) but wears the gear hard; scree demands a threshold.
export const MINIMAP_DCFG = {
  max: 100,
  start: 100,
  wear: { grass: 0.5, gravel: 2, mud: 28, costly: 4 },
  gateThreshold: 25,
  gatedClasses: [1, 3],
  fatigue: 0,
  supplyRestore: 100,
  supplyRadius: 1.1,
};

// Gear profile for the minimap: mud is the cheap surface, grass is middling,
// scree is dear. fatigue is off in MINIMAP_DCFG so arrival costs are clean.
export const MINIMAP_GEAR = {
  name: '小地图装备',
  cost: { grass: 1, gravel: 3, mud: 0.8, costly: 6 },
  grade: { up: 0, down: 0 },
  maxGrade: 99,
};

// A durability configuration in which the DIAMOND's scree gate sits strictly
// between the two junction labels: the mud label (d=16) is blocked, the grass
// label (d=97) passes. Used to prove the single-label pruning makes the goal
// unreachable even though the exact Pareto search keeps both labels and succeeds.
export const DIAMOND_GATE_DCFG = { ...MINIMAP_DCFG, gateThreshold: 25 };

// A lower gate that both junction labels can cross. The single-label rule still
// keeps only the cheap mud label, so it returns a sub-optimal route: the exact
// search would have taken the same mud branch (it is cheapest when the gate is
// open), but the point is the surviving label set is provably incomplete.
export const DIAMOND_LOWGATE_DCFG = { ...MINIMAP_DCFG, gateThreshold: 10 };

// The input the hierarchical solver gets wrong on MUD_GATE. Recorded as a
// runnable fixture: coarse A* on base cost chooses the mud lane; its corridor
// cannot cross the scree gate; the fallback criterion must reject it and run
// the full exact search, which matches the brute-force reference.
export const HIERARCHICAL_FAILURE_FIXTURE = {
  map: 'mud-gate',
  dcfg: MINIMAP_DCFG,
  coarseChoice: 'mud-lane',
  reason: 'durability-gate',
  note: '粗层只按基础代价选泥路；泥路把耐久磨到门限以下，碎石门不可越。',
};

// Runtime fallback predicate. Given the hierarchical refine result and the
// exact optimum, decide whether the hierarchical answer must be rejected.
// This is the executable form of the recorded failing input: any blocked
// corridor, or any answer whose cost exceeds the exact optimum, triggers the
// full-state fallback.
export function shouldFallback(hierarchicalResult, exactResult) {
  if (!hierarchicalResult || !hierarchicalResult.ok) return { fallback: true, why: 'corridor-unreachable' };
  if (!exactResult || !exactResult.ok) return { fallback: false, why: 'no-exact-reference' };
  const gap = hierarchicalResult.cost - exactResult.cost;
  if (gap > 1e-6) return { fallback: true, why: `suboptimal-gap ${gap.toFixed(4)}` };
  return { fallback: false, why: 'matches-exact' };
}
