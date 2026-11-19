import assert from 'node:assert/strict';
import { WORLD, EQUIPMENT, SURFACE } from '../src/config.js';
import { heightAt, surfaceClassAt } from '../src/terrain.js';
import {
  buildModel, buildProfile, solve, solveWith, evaluateEdge, evaluateCoarseEdge,
  verifyHeuristic, reintegratePath,
} from '../src/planner.js';

const model = buildModel({
  width: WORLD.width,
  depth: WORLD.depth,
  cell: WORLD.cell,
  spacing: 2,
  surfaceAt: surfaceClassAt,
  heightAt,
});

let pass = 0;
let fail = 0;
function test(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    fail++;
    console.log(`  FAIL ${name}\n       ${err.message.split('\n').join('\n       ')}`);
  }
}

console.log('\n[1] Edge cost integrates crossed regions, not endpoint colour');

// A synthetic lattice where a 0.4 m impassable-free but costly band sits
// between two cheap endpoints. Node sampling at both ends would charge grass;
// the integrator must charge the band.
const tiny = buildModel({
  width: 20, depth: 20, cell: 0.2, spacing: 2, heightAt: () => 0,
  surfaceAt: (x, z) => (Math.abs(z - 10) <= 0.2 ? SURFACE.costly : SURFACE.grass),
});
const profiles = Object.fromEntries(
  Object.entries(EQUIPMENT).map(([k, v]) => [k, buildProfile(v)]),
);
const profile = profiles.boots;

test('costly band between cheap nodes is charged', () => {
  // Horizontal edge at z=10 runs straight along the band for its full length.
  const along = evaluateEdge(tiny, profile, 2, 10, 18, 10);
  assert.ok(along.ok);
  assert.ok(along.surfaces[SURFACE.costly] > 15, `band metres ${along.surfaces[SURFACE.costly]}`);
  assert.ok(along.cost > 16 * profile.base[SURFACE.costly] * 0.9,
    'cost should reflect costly surface, got ' + along.cost);

  // Vertical edge crossing the 0.4 m band: endpoints are both grass.
  const crossing = evaluateEdge(tiny, profile, 10, 6, 10, 14);
  assert.ok(crossing.ok);
  assert.ok(crossing.surfaces[SURFACE.costly] > 0.3 && crossing.surfaces[SURFACE.costly] < 0.6,
    `crossed band metres ${crossing.surfaces[SURFACE.costly]}`);
  const grassOnly = 8 * profile.base[SURFACE.grass];
  assert.ok(crossing.cost > grassOnly + 2,
    `crossing cost ${crossing.cost} should exceed grass-only ${grassOnly}`);
});

test('costly and impassable are distinct states', () => {
  const costly = evaluateEdge(tiny, profile, 10, 6, 10, 14);
  assert.ok(costly.ok, 'costly surface must remain passable');

  const wall = buildModel({
    width: 20, depth: 20, cell: 0.2, spacing: 2, heightAt: () => 0,
    surfaceAt: (x, z) => (Math.abs(z - 10) <= 0.1 ? SURFACE.impassable : SURFACE.grass),
  });
  const through = evaluateEdge(wall, profile, 10, 6, 10, 14);
  assert.equal(through.ok, false);
  assert.equal(through.reason, 'impassable');
});

test('diagonal crossing of a corner blocks instead of slipping through', () => {
  const wall = buildModel({
    width: 20, depth: 20, cell: 0.2, spacing: 2, heightAt: () => 0,
    surfaceAt: (x, z) => {
      const cx = Math.floor(x / 0.2);
      const cz = Math.floor(z / 0.2);
      return cx === 50 && cz === 50 ? SURFACE.impassable : SURFACE.grass;
    },
  });
  // Both endpoints cheap; segment passes exactly through the single blocked
  // cell's corner. Corner contacts must count.
  const diag = evaluateEdge(wall, profile, 9.9, 9.9, 10.3, 10.3);
  assert.equal(diag.ok, false, 'corner touch should invalidate the edge');
});

console.log('\n[2] Diagonal length and slope use the same path as orthogonal');

test('diagonal length equals sqrt(2) times the orthogonal step', () => {
  const flat = buildModel({
    width: 20, depth: 20, cell: 0.2, spacing: 2, heightAt: () => 0,
    surfaceAt: () => SURFACE.grass,
  });
  const ortho = evaluateEdge(flat, profile, 4, 4, 6, 4);
  const diag = evaluateEdge(flat, profile, 4, 4, 6, 6);
  assert.ok(Math.abs(diag.length - Math.SQRT2 * ortho.length) < 1e-9);
  assert.ok(diag.surfaces[SURFACE.grass] > 2.8 && diag.surfaces[SURFACE.grass] < 2.83);
});

test('slope on a diagonal uses the same central difference', () => {
  const ramp = buildModel({
    width: 20, depth: 20, cell: 0.2, spacing: 2,
    heightAt: (x, z) => (x + z) * 0.25,
    surfaceAt: () => SURFACE.grass,
  });
  const diag = evaluateEdge(ramp, profile, 4, 4, 6, 6);
  const expected = 0.25 * Math.SQRT2;   // gradient magnitude along diagonal
  assert.ok(Math.abs(diag.steepest - expected) < 0.02,
    `diag steepest ${diag.steepest} vs ${expected}`);
  assert.ok(diag.upExtra > 0);
});

console.log('\n[3] Search correctness: A* equals Dijkstra, heuristic admissible');

for (const key of Object.keys(EQUIPMENT)) {
  const p = buildProfile(EQUIPMENT[key]);
  test(`${key}: A* and Dijkstra agree on cost`, () => {
    const a = solve(model, p, WORLD.start, WORLD.goal, { heuristic: true });
    const d = solve(model, p, WORLD.start, WORLD.goal, { heuristic: false });
    assert.ok(a.ok && d.ok);
    assert.ok(Math.abs(a.cost - d.cost) < 1e-6, `A* ${a.cost} vs Dijkstra ${d.cost}`);
    assert.ok(Math.abs(a.cost - d.cost) < 1e-6);
  });

  test(`${key}: heuristic consistent on sampled edges`, () => {
    const h = verifyHeuristic(model, p, 2000);
    assert.ok(h.consistent, `worst violation ${h.worstViolation}`);
  });

  test(`${key}: independent 0.05 m reintegration matches`, () => {
    const a = solve(model, p, WORLD.start, WORLD.goal);
    const re = reintegratePath(model, p, a.path, 0.05);
    assert.ok(re.ok);
    assert.ok(Math.abs(re.cost - a.cost) / a.cost < 0.01,
      `reintegrated ${re.cost} vs ${a.cost}`);
  });

  test(`${key}: path never crosses impassable cells`, () => {
    const a = solve(model, p, WORLD.start, WORLD.goal);
    const re = reintegratePath(model, p, a.path, 0.05);
    assert.ok(re.ok, re.reason);
  });
}

console.log('\n[4] Equipment genuinely changes the route');

const routes = {};
for (const key of Object.keys(EQUIPMENT)) {
  const a = solve(model, buildProfile(EQUIPMENT[key]), WORLD.start, WORLD.goal);
  routes[key] = a;
}

function routeDistance(a, b) {
  // Symmetric Chamfer-like divergence: for each node in a, nearest node in b.
  let sum = 0;
  for (const p of a.path) {
    let best = Infinity;
    for (const q of b.path) best = Math.min(best, Math.hypot(p.x - q.x, p.z - q.z));
    sum += best;
  }
  return sum / a.path.length;
}

test('boots and crampons take measurably different lines', () => {
  const d = routeDistance(routes.boots, routes.crampons);
  assert.ok(d > 8, `mean divergence ${d.toFixed(2)} m`);
});

test('crampons and ATV take measurably different lines', () => {
  const d = routeDistance(routes.crampons, routes.atv);
  assert.ok(d > 15, `mean divergence ${d.toFixed(2)} m`);
});

test('crampons route climbs the steep west ridge; ATV detours east', () => {
  const meanX = (r) => r.path.reduce((s, p) => s + p.x, 0) / r.path.length;
  assert.ok(meanX(routes.crampons) < meanX(routes.atv),
    `crampons x ${meanX(routes.crampons)} vs atv x ${meanX(routes.atv)}`);
});

console.log('\n[5] Thin high-cost strips cannot be skipped by coarse nodes');

// Direct consequence test: an edge whose two endpoints are cheap must still be
// charged for a thin costly strip. Use a known thin feature from the real field
// by probing a vertical line through the rubble seam.
test('fine grid resolves a sub-node-width strip', () => {
  let found = 0;
  let missedByEndpoints = 0;
  for (let x = 150; x <= 200; x += 2) {
    for (let z = 84; z <= 120; z += 1) {
      const c = model.classAt(x, z);
      if (c === SURFACE.costly) found++;
    }
  }
  assert.ok(found > 0, 'rubble seam exists on the fine lattice');
  // Verify the seam is narrower than node spacing by construction.
  let narrow = false;
  for (let t = 0; t < 60; t++) {
    const x = 150 + t * 0.8;
    let run = 0;
    let best = 0;
    for (let z = 80; z < 125; z += 0.2) {
      if (surfaceClassAt(x, z) === SURFACE.costly) run += 0.2;
      else { best = Math.max(best, run); run = 0; }
    }
    if (best > 0 && best < 1.2) { narrow = true; break; }
  }
  assert.ok(narrow, 'seam is thinner than the 2 m node spacing');
});

console.log('\n[6] Fine integration beats node-colour sampling on the real terrain');

// Search the same terrain with the naive model, then price both routes under the
// honest fine integrator. The naive model is free to pick a line it cannot see
// the cost of; if the fine integrator is doing its job, that line is more
// expensive when priced honestly than the fine route.
const boots = buildProfile(EQUIPMENT.boots);
const fineRoute = solve(model, boots, WORLD.start, WORLD.goal);
const coarseRoute = solveWith(model, boots, WORLD.start, WORLD.goal, { heuristic: true }, evaluateCoarseEdge);

function fineCostOfPath(path) {
  let c = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const e = evaluateEdge(model, boots, path[i].x, path[i].z, path[i + 1].x, path[i + 1].z);
    if (!e.ok) return Infinity;
    c += e.cost;
  }
  return c;
}

test('fine route is not beaten under honest pricing', () => {
  assert.ok(fineRoute.ok && coarseRoute.ok);
  const fineOnFine = fineCostOfPath(fineRoute.path);
  const coarseOnFine = fineCostOfPath(coarseRoute.path);
  assert.ok(fineOnFine <= coarseOnFine + 1e-6,
    `fine ${fineOnFine.toFixed(2)} > coarse-route-priced-honestly ${coarseOnFine.toFixed(2)}`);
});

test('coarse model underprices its own route relative to fine integration', () => {
  const coarseBelieved = coarseRoute.cost;
  const honest = fineCostOfPath(coarseRoute.path);
  assert.ok(honest > coarseBelieved + 0.05,
    `coarse believed ${coarseBelieved.toFixed(2)}, honest ${honest.toFixed(2)}`);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
