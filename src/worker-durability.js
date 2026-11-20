// Durability-aware planning worker.
//
// Two solvers run on the same terrain model:
//   exact        — augmented-state (node, durability) Pareto label search
//                  (src/durability.js solveDurability);
//   hierarchical — durability-blind coarse A*, then a corridor-restricted
//                  refinement with a full exact fallback.
//
// Cache contract (also surfaced in the UI): a cached entry is valid ONLY for
// the exact key it was computed under — equipment id, start, goal, the full
// ordered list of supply positions, and the starting durability. Moving a
// supply cache or changing gear changes the durability transition, so the key
// changes and the old entry is never reused. The cache stores no entry that is
// valid for one equipment state but not another.

import { WORLD, EQUIPMENT, DURABILITY } from './config.js';
import { heightAt, surfaceClassAt } from './terrain.js';
import { buildModel, buildProfile, solve } from './planner.js';
import { solveDurability, solveHierarchical, searchDurability } from './durability.js';
import {
  buildGraph, solveGraph, solveGraphHierarchical, enumerateSimplePaths,
  MUD_GATE, DIAMOND, MINIMAP_DCFG, MINIMAP_GEAR, DIAMOND_GATE_DCFG,
} from './minimap.js';

const model = buildModel({
  width: WORLD.width,
  depth: WORLD.depth,
  cell: WORLD.cell,
  spacing: 2,
  surfaceAt: surfaceClassAt,
  heightAt,
});

function cacheKey(payload) {
  const supplies = (payload.supplies || [])
    .map((s) => `${s.x},${s.z}`)
    .join('|');
  return [
    payload.equipment,
    `${payload.start.x},${payload.start.z}`,
    `${payload.goal.x},${payload.goal.z}`,
    `sup[${supplies}]`,
    `d${payload.startDurability ?? DURABILITY.start}`,
    payload.solver,
  ].join('::');
}

function summarizeRun(run) {
  if (!run.ok) return { ok: false, reason: run.reason, expanded: run.expanded ?? 0 };
  return {
    ok: true,
    path: run.path,
    edges: run.edges,
    cost: run.cost,
    totals: run.totals,
    expanded: run.expanded,
    relaxed: run.relaxed,
    peakLabels: run.peakLabels,
    finalDurability: run.finalDurability,
    debugEvents: run.debugEvents || [],
  };
}

function plan(payload) {
  const profile = buildProfile(EQUIPMENT[payload.equipment]);
  const supplies = payload.supplies || [];
  const startDurability = payload.startDurability ?? DURABILITY.start;
  const t0 = performance.now();

  // Durability-blind A* kept as the coarse reference line; it is also what the
  // hierarchical solver's first phase uses internally.
  const blind = solve(model, profile, payload.start, payload.goal, { heuristic: true });
  const t1 = performance.now();

  let exact;
  let hierarchical;
  if (payload.solver === 'exact') {
    exact = solveDurability(model, profile, payload.start, payload.goal, {
      supplies, startDurability,
    });
    hierarchical = null;
  } else if (payload.solver === 'hierarchical') {
    hierarchical = solveHierarchical(model, profile, payload.start, payload.goal, {
      supplies, startDurability, corridorInflation: 1, maxWidenings: 1,
    });
    exact = null;
  } else {
    // 'both' — the comparison view runs both and reports node counts side by side.
    exact = solveDurability(model, profile, payload.start, payload.goal, { supplies, startDurability });
    hierarchical = solveHierarchical(model, profile, payload.start, payload.goal, {
      supplies, startDurability, corridorInflation: 1, maxWidenings: 1,
    });
  }
  const t2 = performance.now();

  // The deliberately broken one-label-per-node run, for the debugger panel.
  const singleLabel = searchDurability(model, profile, payload.start, payload.goal, {
    supplies, startDurability, singleLabel: true,
  });
  const t3 = performance.now();

  return {
    equipment: payload.equipment,
    solver: payload.solver,
    start: payload.start,
    goal: payload.goal,
    supplies,
    startDurability,
    timings: {
      blindMs: Math.round(t1 - t0),
      solverMs: Math.round(t2 - t1),
      singleLabelMs: Math.round(t3 - t2),
    },
    blind: blind.ok ? {
      cost: blind.cost, expanded: blind.expanded, path: blind.path,
      edges: blind.edges, totals: blind.totals,
    } : { ok: false, reason: blind.reason },
    exact: exact ? summarizeRun(exact) : null,
    hierarchical: hierarchical ? {
      ...summarizeRun(hierarchical),
      fellBack: hierarchical.fellBack,
      fallbackReason: hierarchical.fallbackReason,
      coarseCost: hierarchical.coarseCost,
      coarsePath: hierarchical.coarsePath,
      trace: hierarchical.trace,
    } : null,
    singleLabel: summarizeRun(singleLabel),
  };
}

// ----------------------------------------------------- minimap debugger data
function minimapDebug() {
  const profile = buildProfile(MINIMAP_GEAR);
  const gMud = buildGraph(MUD_GATE);
  gMud.profile = profile;
  const gDiamond = buildGraph(DIAMOND);
  gDiamond.profile = profile;

  const mudRef = enumerateSimplePaths(gMud, MUD_GATE.start, MUD_GATE.goal, { dcfg: MINIMAP_DCFG });
  const mudExact = solveGraph(gMud, MUD_GATE.start, MUD_GATE.goal, { dcfg: MINIMAP_DCFG });
  const mudHier = solveGraphHierarchical(gMud, MUD_GATE.start, MUD_GATE.goal, { dcfg: MINIMAP_DCFG });

  const diamondExact = solveGraph(gDiamond, DIAMOND.start, DIAMOND.goal, { dcfg: DIAMOND_GATE_DCFG });
  const diamondSingle = solveGraph(gDiamond, DIAMOND.start, DIAMOND.goal, {
    dcfg: DIAMOND_GATE_DCFG, singleLabel: true,
  });
  const diamondJunction = enumerateSimplePaths(gDiamond, DIAMOND.start, 5, { dcfg: DIAMOND_GATE_DCFG });

  return {
    dcfg: MINIMAP_DCFG,
    gateDcfg: DIAMOND_GATE_DCFG,
    gear: MINIMAP_GEAR,
    mudGate: {
      spec: MUD_GATE,
      reference: { pathCount: mudRef.pathCount, optimumCost: mudRef.optimum.cost, optimumPath: mudRef.optimum.nodePath, visits: mudRef.visits },
      exact: { ok: mudExact.ok, cost: mudExact.cost, path: mudExact.nodePath, finalDurability: mudExact.finalDurability, expanded: mudExact.expanded },
      hierarchical: {
        ok: mudHier.ok,
        fellBack: mudHier.fellBack,
        fallbackReason: mudHier.fallbackReason,
        cost: mudHier.cost,
        path: mudHier.nodePath,
        coarsePath: mudHier.coarsePath,
        trace: mudHier.trace,
      },
    },
    diamond: {
      spec: DIAMOND,
      junctionLabels: diamondJunction.paths.map((p) => ({
        path: p.nodePath, cost: p.cost, durability: p.finalDurability,
      })),
      exact: { ok: diamondExact.ok, cost: diamondExact.cost, path: diamondExact.nodePath, finalDurability: diamondExact.finalDurability, peakLabels: diamondExact.peakLabels },
      singleLabel: {
        ok: diamondSingle.ok,
        reason: diamondSingle.reason,
        drops: diamondSingle.debugEvents,
      },
    },
  };
}

const cache = new Map();

self.onmessage = (ev) => {
  const msg = ev.data || {};
  try {
    if (msg.type === 'minimap-debug') {
      self.postMessage({ type: 'minimap', payload: minimapDebug() });
      return;
    }
    if (msg.type !== 'solve') return;
    const key = cacheKey(msg);
    let result = cache.get(key);
    let cacheHit = true;
    if (!result) {
      result = plan(msg);
      result.cacheKey = key;
      cache.set(key, result);
      cacheHit = false;
    }
    self.postMessage({ type: 'result', result: { ...result, cacheHit, cacheSize: cache.size } });
  } catch (err) {
    self.postMessage({ type: 'error', message: String((err && err.stack) || err) });
  }
};
