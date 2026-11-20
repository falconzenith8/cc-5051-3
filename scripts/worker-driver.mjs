// Node-side driver for worker-durability.js: emulate the Worker `self` global
// and exercise the same message handlers the browser uses, without a browser.
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const messages = [];
const self = {
  postMessage(msg) { messages.push(msg); },
};
globalThis.self = self;

await import(pathToFileURL(resolve('src/worker-durability.js')));

// The worker registers self.onmessage at import time.
function send(msg) {
  messages.length = 0;
  self.onmessage({ data: msg });
  return messages;
}

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log('  ok  ', name);
  else { failures++; console.log('  FAIL', name, detail); }
};

console.log('\n[W1] solve/both returns exact + hierarchical + single-label runs');
const [res1] = send({
  type: 'solve',
  equipment: 'boots',
  start: { x: 52, z: 160 },
  goal: { x: 150, z: 18 },
  supplies: [{ id: 'supply-1', x: 66, z: 128 }, { id: 'supply-2', x: 172, z: 126 }],
  startDurability: 100,
  solver: 'both',
});
check('result message type', res1.type === 'result');
const r = res1.result;
check('exact run ok', r.exact && r.exact.ok, r.exact && r.exact.reason);
check('hierarchical run ok', r.hierarchical && r.hierarchical.ok, r.hierarchical && r.hierarchical.reason);
check('single-label run present', r.singleLabel);
check('cache key includes equipment and supply positions',
  r.cacheKey.includes('boots') && r.cacheKey.includes('66,128') && r.cacheKey.includes('172,126'), r.cacheKey);
check('first request is a cache miss', res1.result.cacheHit === false);
console.log('   cacheKey:', r.cacheKey);
console.log('   exact cost', r.exact.cost.toFixed(2), 'dur', r.exact.finalDurability, 'expanded', r.exact.expanded, 'peak', r.exact.peakLabels);
console.log('   hierarchical fellBack', r.hierarchical.fellBack, 'trace phases', r.hierarchical.trace.map((t) => t.phase).join(','));

console.log('\n[W2] identical request is a cache hit; moving a supply changes the key');
const [res2] = send({
  type: 'solve', equipment: 'boots',
  start: { x: 52, z: 160 }, goal: { x: 150, z: 18 },
  supplies: [{ id: 'supply-1', x: 66, z: 128 }, { id: 'supply-2', x: 172, z: 126 }],
  startDurability: 100, solver: 'both',
});
check('second identical request hits the cache', res2.result.cacheHit === true);
check('cache size is 1', res2.result.cacheSize === 1);

const [res3] = send({
  type: 'solve', equipment: 'boots',
  start: { x: 52, z: 160 }, goal: { x: 150, z: 18 },
  supplies: [{ id: 'supply-1', x: 70, z: 130 }, { id: 'supply-2', x: 172, z: 126 }],
  startDurability: 100, solver: 'both',
});
check('moved supply is a cache miss (new key)', res3.result.cacheHit === false);
check('new key carries the new supply position', res3.result.cacheKey.includes('70,130'));
check('cache size grew to 2', res3.result.cacheSize === 2);

const [res4] = send({
  type: 'solve', equipment: 'atv',
  start: { x: 52, z: 160 }, goal: { x: 150, z: 18 },
  supplies: [{ id: 'supply-1', x: 70, z: 130 }, { id: 'supply-2', x: 172, z: 126 }],
  startDurability: 100, solver: 'both',
});
check('equipment change is a cache miss', res4.result.cacheHit === false);
check('key includes the new equipment id', res4.result.cacheKey.includes('atv'));

console.log('\n[W3] no-supply request is infeasible on the real map');
const [res5] = send({
  type: 'solve', equipment: 'boots',
  start: { x: 52, z: 160 }, goal: { x: 150, z: 18 },
  supplies: [], startDurability: 100, solver: 'both',
});
check('exact run reports unreachable without supplies', res5.result.exact.ok === false);
check('hierarchical also reports failure without supplies', res5.result.hierarchical.ok === false);

console.log('\n[W4] minimap-debug message returns the counterexample payload');
const [dbg] = send({ type: 'minimap-debug' });
check('debug message type', dbg.type === 'minimap');
const d = dbg.payload;
check('mud-gate reference optimum present', d.mudGate.reference.optimumCost > 0);
check('mud-gate hierarchical fell back', d.mudGate.hierarchical.fellBack === true);
check('diamond junction has two labels', d.diamond.junctionLabels.length === 2);
check('single-label search is unreachable under raised gate', d.diamond.singleLabel.ok === false);
check('a junction drop event is recorded', d.diamond.singleLabel.drops.some((e) => e.node === 5));
console.log('   junction labels:', JSON.stringify(d.diamond.junctionLabels));
console.log('   drop at J:', JSON.stringify(d.diamond.singleLabel.drops.find((e) => e.node === 5)));

console.log(`\n${failures ? failures + ' FAILURES' : 'all worker-driver checks passed'}\n`);
process.exit(failures ? 1 : 0);
