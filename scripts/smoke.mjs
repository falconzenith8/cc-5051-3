import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-gl=swiftshader','--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const logs = [];
page.on('console', (m) => { if (m.type()==='error') logs.push(`[err] ${m.text()}`); });
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
await page.waitForFunction(() => document.getElementById('stat-total')?.textContent !== '–', { timeout: 60000 });
await page.waitForTimeout(1000);
await page.screenshot({ path: '/tmp/shot-boots.png' });
console.log('boots total', await page.textContent('#stat-total'));
console.log(await page.locator('#verify').innerText());
for (const key of ['crampons','atv']) {
  await page.click(`.equip[data-key="${key}"]`);
  await page.waitForFunction((k) => document.querySelector(`.equip[data-key="${k}"]`)?.classList.contains('active')
    && document.getElementById('stat-total')?.textContent !== '–', key, { timeout: 60000 });
  await page.waitForTimeout(2200);
  await page.screenshot({ path: `/tmp/shot-${key}.png` });
  console.log(`\n--- ${key}`, await page.textContent('#stat-total'));
}
// walk animation check: press drive and sample scrub progress
await page.click('#drive');
await page.waitForTimeout(1500);
const mid = await page.textContent('#scrub-label');
await page.waitForTimeout(600);
const later = await page.textContent('#scrub-label');
await page.screenshot({ path: '/tmp/shot-walk.png' });
console.log('\nwalk progress:', mid, '->', later);
console.log('errors:', logs.length ? logs.join('\n') : 'none');
await browser.close();
