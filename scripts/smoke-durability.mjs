// End-to-end check for the durability UI: solvers render, supply drag triggers
// a new solve, the walk records stats, and the debugger renders both minimaps.
import { chromium } from 'playwright';

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
const logs = [];
page.on('console', (m) => { if (m.type() === 'error') logs.push(`[err] ${m.text()}`); });
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
await page.waitForFunction(() => document.getElementById('dstat-cost')?.textContent !== '–', { timeout: 60000 });
await page.waitForTimeout(800);

console.log('compare panel:\n' + (await page.locator('#solver-compare').innerText()));
console.log('\nchosen stats:', await page.locator('.dura-bar').first().innerText(), '|',
  await page.locator('#dstat-cost').innerText(), await page.locator('#dstat-dur').innerText(),
  await page.locator('#dstat-expanded').innerText());

await page.waitForFunction(() => document.querySelector('#debug-panel h3') !== null, { timeout: 30000 });
const debugText = await page.locator('#debug-panel').innerText();
console.log('\ndebugger has mud-gate section:', debugText.includes('mud-gate'));
console.log('debugger has fallback section:', debugText.includes('分层法选错'));
console.log('debugger has junction drop box:', debugText.includes('提前淘汰'));

// Switch to hierarchical-only solver
await page.click('#solver-switch [data-solver="hierarchical"]');
await page.waitForTimeout(2500);
console.log('\nhierarchical fallback stat:', await page.locator('#dstat-fallback').innerText());

// Walk the chosen route and confirm the walk log fills
await page.click('#drive');
await page.waitForTimeout(9000);
const walkLog = await page.locator('#walk-log').innerText();
console.log('\nwalk log:\n' + walkLog);

// Supply drag: simulate dropping a chip onto the canvas
const chip = await page.locator('.supply-chip').first();
const box = await chip.boundingBox();
const canvas = await page.locator('#view').boundingBox();
await page.mouse.move(box.x + 5, box.y + 5);
await page.mouse.down();
await page.mouse.move(canvas.x + canvas.width * 0.5, canvas.y + canvas.height * 0.5, { steps: 6 });
await page.mouse.up();
// HTML5 drag needs dataTransfer; dispatch a synthetic drop instead on the canvas
await page.evaluate(() => {
  const chip = document.querySelector('.supply-chip');
  const id = chip.dataset.id;
  const dt = new DataTransfer();
  dt.setData('text/supply-id', id);
  const ev = new DragEvent('drop', { dataTransfer: dt, bubbles: true, clientX: 700, clientY: 500 });
  document.getElementById('view').dispatchEvent(ev);
});
await page.waitForTimeout(3000);
console.log('\nstatus after supply drop:', await page.locator('#status').innerText());
console.log('cache key present:', (await page.locator('#cache-key').innerText()).length > 20);

await page.screenshot({ path: '/tmp/durability-ui.png', fullPage: false });
console.log('\nerrors:', logs.length ? logs.join('\n') : 'none');
await browser.close();
