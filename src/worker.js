import { WORLD, EQUIPMENT, SURFACE } from './config.js';
import { heightAt, surfaceClassAt } from './terrain.js';
import {
  buildModel, buildProfile, solve, solveWith, evaluateCoarseEdge,
  verifyHeuristic, reintegratePath, evaluateEdge,
} from './planner.js';

// The heavy lattice is identical for every equipment choice, so build it once.
const model = buildModel({
  width: WORLD.width,
  depth: WORLD.depth,
  cell: WORLD.cell,
  spacing: 2,
  surfaceAt: surfaceClassAt,
  heightAt,
});

function endpointSkim(edge, model) {
  // True when both endpoints sit on cheap grass yet the edge physically crosses
  // expensive or impassable cells: the case a node-only colour check would miss.
  const c0 = model.classAt(edge.from.x, edge.from.z);
  const c1 = model.classAt(edge.to.x, edge.to.z);
  const bothCheap = (c0 === 0 || c0 === 1) && (c1 === 0 || c1 === 1);
  const crossedHeavy = edge.surfaces[2] + edge.surfaces[3] > 0.05;
  return bothCheap && crossedHeavy;
}

// Sweep sampled lattice edges and count how many would be mispriced by a model
// that only looks at the surface under each endpoint node. This is a property
// of the terrain and the integrator, independent of the route chosen.
function thinFeatureSurvey(profile) {
  let checked = 0;
  let endpointBlind = 0;
  let worstMiss = 0;
  const stride = 3;
  for (let iz = 0; iz < model.nodeNz; iz += stride) {
    for (let ix = 0; ix < model.nodeNx; ix += stride) {
      for (const [ox, oz] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
        const jz = iz + oz;
        const jx = ix + ox;
        if (jx < 0 || jz < 0 || jx >= model.nodeNx || jz >= model.nodeNz) continue;
        const ax = ix * model.spacing + model.cell * 0.5;
        const az = iz * model.spacing + model.cell * 0.5;
        const bx = jx * model.spacing + model.cell * 0.5;
        const bz = jz * model.spacing + model.cell * 0.5;
        const cl = model.classAt(ax, az);
        const cr = model.classAt(bx, bz);
        // Only edges whose endpoints are cheap grass/gravel but that still cross
        // expensive or blocked fine cells. These are exactly the ones a node
        // sampler would get wrong.
        const cheapEnds = (cl === SURFACE.grass || cl === SURFACE.gravel)
          && (cr === SURFACE.grass || cr === SURFACE.gravel);
        if (!cheapEnds) continue;
        const e = evaluateEdge(model, profile, ax, az, bx, bz);
        checked++;
        const crossedHeavy = (e.ok && (e.surfaces[SURFACE.mud] + e.surfaces[SURFACE.costly]) > 0.05)
          || (!e.ok && e.reason === 'impassable');
        if (crossedHeavy) {
          endpointBlind++;
          if (e.ok) worstMiss = Math.max(worstMiss, e.cost);
        }
      }
    }
  }
  return { checked, endpointBlind, worstMiss };
}

// Run the same start/goal with the naive node-colour model, then price both
// routes under the honest fine integrator. If the fine model is doing its job,
// the naively-chosen route costs more when priced correctly.
function naiveModelComparison(profile, start, goal, fineCost, finePath) {
  const coarse = solveWith(model, profile, start, goal, { heuristic: true }, evaluateCoarseEdge);
  if (!coarse.ok) return null;
  let honest = 0;
  for (let i = 0; i < coarse.path.length - 1; i++) {
    const e = evaluateEdge(model, profile, coarse.path[i].x, coarse.path[i].z, coarse.path[i + 1].x, coarse.path[i + 1].z);
    if (!e.ok) return null;
    honest += e.cost;
  }
  let divergence = 0;
  for (const p of coarse.path) {
    let best = Infinity;
    for (const q of finePath) best = Math.min(best, Math.hypot(p.x - q.x, p.z - q.z));
    divergence += best;
  }
  divergence /= coarse.path.length;
  return {
    believed: coarse.cost,
    honest,
    fine: fineCost,
    detour: divergence,
    underpriced: honest - coarse.cost,
  };
}

function summarize(equipmentKey, start, goal) {
  const equipment = EQUIPMENT[equipmentKey];
  const profile = buildProfile(equipment);
  const t0 = performance.now();
  const astar = solve(model, profile, start, goal, { heuristic: true });
  const t1 = performance.now();
  if (!astar.ok) {
    return { ok: false, equipment: equipmentKey, start, goal, reason: astar.reason, solveMs: t1 - t0 };
  }
  const dijkstra = solve(model, profile, start, goal, { heuristic: false });
  const t2 = performance.now();
  const reintegrated = reintegratePath(model, profile, astar.path, 0.05);
  const t3 = performance.now();
  const heuristic = verifyHeuristic(model, profile, 5000);

  const skimmed = astar.edges.filter((e) => endpointSkim(e, model)).length;
  // How far the "one colour per node" model would have priced this same route.
  // Positive => fine integration caught cost the clcass-per-node model missed.
  const survey = thinFeatureSurvey(profile);
  const naiveModel = naiveModelComparison(profile, start, goal, astar.cost, astar.path);

  return {
    ok: true,
    equipment: equipmentKey,
    start,
    goal,
    solveMs: Math.round(t1 - t0),
    verifyMs: Math.round(t3 - t2),
    astar: {
      cost: astar.cost,
      totals: astar.totals,
      expanded: astar.expanded,
      path: astar.path,
      edges: astar.edges,
    },
    dijkstra: {
      cost: dijkstra.ok ? dijkstra.cost : null,
      expanded: dijkstra.ok ? dijkstra.expanded : null,
    },
    reintegrated,
    heuristic: {
      checked: heuristic.checked,
      worstViolation: heuristic.worstViolation,
      consistent: heuristic.consistent,
    },
    skimmed,
    naiveModel,
    survey,
  };
}

const cache = new Map();

self.onmessage = (ev) => {
  const { type, equipment, start, goal } = ev.data || {};
  if (type !== 'solve') return;
  try {
    const key = `${equipment}|${start.x},${start.z}|${goal.x},${goal.z}`;
    let result = cache.get(key);
    if (!result) {
      result = summarize(equipment, start, goal);
      cache.set(key, result);
    }
    self.postMessage({ type: 'result', result });
  } catch (err) {
    self.postMessage({ type: 'error', equipment, message: String(err && err.stack || err) });
  }
};
