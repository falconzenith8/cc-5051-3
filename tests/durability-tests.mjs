// Durability solver tests: enumerable reference solutions, the hierarchical
// fallback criterion, and the single-label pruning counterexample. Also checks
// the augmented-state search on the real terrain and the cache key contract.
import assert from 'node:assert/strict';
import { WORLD, EQUIPMENT, SURFACE, DURABILITY, DEFAULT_SUPPLIES } from '../src/config.js';
import { heightAt, surfaceClassAt } from '../src/terrain.js';
import { buildModel, buildProfile } from '../src/planner.js';
import {
  solveDurability, solveHierarchical, searchDurability, evaluateDurabilityEdge,
} from '../src/durability.js';
import {
  buildGraph, solveGraph, solveGraphHierarchical, enumerateSimplePaths,
  MUD_GATE, DIAMOND, MINIMAP_DCFG, MINIMAP_GEAR, DIAMOND_GATE_DCFG, DIAMOND_LOWGATE_DCFG,
  HIERARCHICAL_FAILURE_FIXTURE, shouldFallback,
} from '../src/minimap.js';

let pass = 0;
let fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log(`  ok   ${name}`); }
  catch (err) { fail++; console.log(`  FAIL ${name}\n       ${String(err.message).split('\n').join('\n       ')}`); }
}

const minimapProfile = buildProfile(MINIMAP_GEAR);
const gMud = buildGraph(MUD_GATE);
gMud.profile = minimapProfile;
const gDiamond = buildGraph(DIAMOND);
gDiamond.profile = minimapProfile;

console.log('\n[1] Enumerable minimaps: exact label search matches brute force');

test('MUD_GATE: brute force enumerates every feasible simple path', () => {
  const ref = enumerateSimplePaths(gMud, MUD_GATE.start, MUD_GATE.goal, { dcfg: MINIMAP_DCFG });
  assert.ok(ref.ok);
  assert.ok(ref.pathCount >= 1, 'at least one feasible path');
  assert.equal(ref.truncated, false);
});

test('MUD_GATE: exact search cost and durability equal the enumerated optimum', () => {
  const ref = enumerateSimplePaths(gMud, MUD_GATE.start, MUD_GATE.goal, { dcfg: MINIMAP_DCFG });
  const exact = solveGraph(gMud, MUD_GATE.start, MUD_GATE.goal, { dcfg: MINIMAP_DCFG });
  assert.ok(exact.ok);
  assert.ok(Math.abs(exact.cost - ref.optimum.cost) < 1e-9,
    `exact ${exact.cost} vs brute ${ref.optimum.cost}`);
  assert.equal(exact.finalDurability, ref.optimum.finalDurability);
});

test('MUD_GATE: mud lane is cheaper on base cost but blocked by the scree gate', () => {
  // The mud lane reaches the gate node with durability below the threshold.
  const mudPath = [0, 1, 2, 3, 4];
  let d = MINIMAP_DCFG.start;
  let blockedAt = -1;
  for (let i = 0; i < mudPath.length - 1; i++) {
    const edge = gMud.adj.get(mudPath[i]).find((e) => e.to === mudPath[i + 1]);
    const step = (function () {
      // mirror transition's gate check without importing internals
      const gated = MINIMAP_DCFG.gatedClasses.some((c) => edge.surfaces[c] > 1e-9);
      if (gated && d < MINIMAP_DCFG.gateThreshold) return null;
      let wear = 0;
      for (let c = 0; c < 4; c++) wear += edge.surfaces[c] * MINIMAP_DCFG.wear[['grass', 'gravel', 'mud', 'costly'][c]];
      d = Math.max(0, d - wear);
      return { d };
    })();
    if (!step) { blockedAt = mudPath[i + 1]; break; }
    d = step.d;
  }
  assert.ok(blockedAt >= 0, 'mud lane must hit the durability gate');
});

test('DIAMOND: both branches reach the junction, equal-ish cost, different durability', () => {
  const ref = enumerateSimplePaths(gDiamond, DIAMOND.start, 5, { dcfg: MINIMAP_DCFG });
  assert.equal(ref.paths.length, 2);
  const [a, b] = ref.paths;
  // Two distinct durability labels at J, neither dominating the other on d alone.
  assert.notEqual(a.finalDurability, b.finalDurability);
  const ds = ref.paths.map((p) => p.finalDurability).sort((x, y) => y - x);
  assert.ok(ds[0] >= DIAMOND_GATE_DCFG.gateThreshold, 'durable label clears the gate');
  assert.ok(ds[1] < DIAMOND_GATE_DCFG.gateThreshold, 'worn label is blocked by the gate');
});

console.log('\n[2] Hierarchical solver: wrong coarse input is recorded and triggers fallback');

test('recorded fixture describes the mud-lane coarse mistake', () => {
  assert.equal(HIERARCHICAL_FAILURE_FIXTURE.map, 'mud-gate');
  assert.equal(HIERARCHICAL_FAILURE_FIXTURE.coarseChoice, 'mud-lane');
  assert.equal(HIERARCHICAL_FAILURE_FIXTURE.reason, 'durability-gate');
});

test('MUD_GATE: hierarchical corridor fails then full fallback finds the brute-force optimum', () => {
  const hier = solveGraphHierarchical(gMud, MUD_GATE.start, MUD_GATE.goal, { dcfg: MINIMAP_DCFG });
  assert.ok(hier.ok);
  assert.equal(hier.fellBack, true, 'corridor must be rejected');
  assert.equal(hier.fallbackReason, 'unreachable');
  const ref = enumerateSimplePaths(gMud, MUD_GATE.start, MUD_GATE.goal, { dcfg: MINIMAP_DCFG });
  assert.ok(Math.abs(hier.cost - ref.optimum.cost) < 1e-9);
  // The refine phase is recorded as a failed corridor attempt.
  const refine = hier.trace.find((t) => t.phase === 'refine-in-corridor');
  assert.equal(refine.ok, false);
  assert.equal(refine.reason, 'unreachable');
});

test('fallback predicate rejects a blocked or sub-optimal hierarchical answer', () => {
  const exact = solveGraph(gMud, MUD_GATE.start, MUD_GATE.goal, { dcfg: MINIMAP_DCFG });
  assert.deepEqual(shouldFallback(null, exact), { fallback: true, why: 'corridor-unreachable' });
  assert.deepEqual(shouldFallback({ ok: true, cost: exact.cost }, exact),
    { fallback: false, why: 'matches-exact' });
  assert.equal(shouldFallback({ ok: true, cost: exact.cost + 5 }, exact).fallback, true);
});

console.log('\n[3] Single-label pruning counterexample: early state discard breaks optimality');

test('DIAMOND raised gate: exact search succeeds, single-label search is unreachable', () => {
  const exact = solveGraph(gDiamond, DIAMOND.start, DIAMOND.goal, { dcfg: DIAMOND_GATE_DCFG });
  const broken = solveGraph(gDiamond, DIAMOND.start, DIAMOND.goal, {
    dcfg: DIAMOND_GATE_DCFG, singleLabel: true,
  });
  assert.ok(exact.ok, 'Pareto label search keeps the durable grass label and passes the gate');
  assert.equal(broken.ok, false);
  assert.equal(broken.reason, 'unreachable');
  // The debugger event names the junction, the surviving cheap mud label and
  // the discarded durable label.
  const drop = broken.debugEvents.find((e) => e.node === 5);
  assert.ok(drop, 'a label was discarded at junction J');
  assert.ok(drop.kept.d < DIAMOND_GATE_DCFG.gateThreshold, 'kept label is too worn for the gate');
  assert.ok(drop.dropped.d >= DIAMOND_GATE_DCFG.gateThreshold, 'dropped label would have passed');
});

test('DIAMOND low gate: single-label still discards the durable label at J', () => {
  const broken = solveGraph(gDiamond, DIAMOND.start, DIAMOND.goal, {
    dcfg: DIAMOND_LOWGATE_DCFG, singleLabel: true,
  });
  assert.ok(broken.ok, 'with a low gate the surviving mud label can still finish');
  const drop = broken.debugEvents.find((e) => e.node === 5);
  assert.ok(drop, 'the durable label is discarded even when both labels can finish');
  assert.ok(drop.dropped.d > drop.kept.d);
});

test('correct search keeps a non-dominated label front (peak labels > 1) at the junction', () => {
  const exact = solveGraph(gDiamond, DIAMOND.start, DIAMOND.goal, { dcfg: DIAMOND_GATE_DCFG });
  assert.ok(exact.peakLabels >= 2);
});

console.log('\n[4] Durability mechanics on the real terrain');

const realModel = buildModel({
  width: WORLD.width, depth: WORLD.depth, cell: WORLD.cell, spacing: 2,
  surfaceAt: surfaceClassAt, heightAt,
});
const boots = buildProfile(EQUIPMENT.boots);

test('mud strips durability faster than grass per metre', () => {
  assert.ok(DURABILITY.wear.mud > DURABILITY.wear.gravel);
  assert.ok(DURABILITY.wear.gravel > DURABILITY.wear.grass);
});

test('fatigue factor is 1 at full durability and rises as gear wears', () => {
  const full = evaluateDurabilityEdge(realModel, boots, 20, 20, 22, 20, DURABILITY.max, []);
  const worn = evaluateDurabilityEdge(realModel, boots, 20, 20, 22, 20, 30, []);
  assert.ok(full.ok && worn.ok);
  assert.ok(Math.abs(full.factor - 1) < 1e-9);
  assert.ok(worn.factor > full.factor);
});

test('scree edge is blocked below the gate threshold, allowed above it', () => {
  // Find a gravel edge by scanning the gravel wash area.
  let blocked = null;
  let allowed = null;
  for (let z = 140; z < 170 && (!blocked || !allowed); z += 2) {
    for (let x = 60; x < 100; x += 2) {
      const e = evaluateDurabilityEdge(realModel, boots, x, z, x + 2, z, DURABILITY.gateThreshold - 1, []);
      const e2 = evaluateDurabilityEdge(realModel, boots, x, z, x + 2, z, DURABILITY.max, []);
      if (e.ok === false && e.reason === 'durability-gate') blocked = e;
      if (e2.ok && e2.gated) allowed = e2;
    }
  }
  assert.ok(blocked, 'a gravel edge must be gated below threshold');
  assert.ok(allowed, 'the same edge is passable with full durability');
});

test('exact durability search reaches the goal with finite cost on the real map', () => {
  const r = solveDurability(realModel, boots, WORLD.start, WORLD.goal, { supplies: DEFAULT_SUPPLIES });
  assert.ok(r.ok, r.reason);
  assert.ok(r.cost > 0);
  assert.ok(r.finalDurability >= 0 && r.finalDurability <= DURABILITY.max);
  assert.ok(r.peakLabels >= 1);
});

test('no-supply trip is infeasible: the mud belt drains the gear before the goal', () => {
  const r = solveDurability(realModel, boots, WORLD.start, WORLD.goal, { supplies: [] });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unreachable');
});

test('a supply cache restores durability and makes the same trip feasible', () => {
  const none = solveDurability(realModel, boots, WORLD.start, WORLD.goal, { supplies: [] });
  const fed = solveDurability(realModel, boots, WORLD.start, WORLD.goal, { supplies: DEFAULT_SUPPLIES });
  assert.equal(none.ok, false);
  assert.ok(fed.ok);
  assert.ok(fed.totals.suppliesUsed >= 1);
});

test('single-label run on the real map terminates within the exact state count', () => {
  const exact = searchDurability(realModel, boots, WORLD.start, WORLD.goal, { supplies: DEFAULT_SUPPLIES });
  const broken = searchDurability(realModel, boots, WORLD.start, WORLD.goal, {
    supplies: DEFAULT_SUPPLIES, singleLabel: true,
  });
  assert.ok(exact.ok);
  assert.ok(broken.expanded <= exact.expanded + 4);
});

test('hierarchical solver on the real map returns a feasible path', () => {
  const r = solveHierarchical(realModel, boots, WORLD.start, WORLD.goal, {
    supplies: DEFAULT_SUPPLIES, corridorInflation: 1, maxWidenings: 1,
  });
  assert.ok(r.ok, r.reason);
  assert.ok(r.cost > 0);
  assert.ok(Array.isArray(r.trace) && r.trace.length >= 2);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
