import { chromium } from 'playwright';
const browser = await chromium.launch({ args:['--use-gl=swiftshader','--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport:{width:1440,height:900}, deviceScaleFactor:1 });
const errs=[]; page.on('pageerror',e=>errs.push(e.message)); page.on('console',m=>{if(m.type()==='error')errs.push(m.text());});
await page.goto('http://localhost:5173/',{waitUntil:'networkidle'});
await page.waitForFunction(()=>document.getElementById('stat-total')?.textContent!=='–',{timeout:60000});
const before = await page.textContent('#stat-total');
// open the picker details, then arm goal placement
await page.locator('details').last().locator('summary').click();
await page.click('#pick-goal');
const armed = await page.locator('#pick-goal').getAttribute('class');
const box = await page.locator('#view').boundingBox();
await page.mouse.click(box.x + box.width*0.62, box.y + box.height*0.36);
await page.waitForTimeout(200);
const hint = await page.textContent('#pick-hint');
// wait for a new result (total may change)
await page.waitForTimeout(3500);
const after = await page.textContent('#stat-total');
const status = await page.textContent('#status');
await page.screenshot({path:'/tmp/shot-pick.png'});
console.log('armed class:', armed);
console.log('hint after pick:', hint);
console.log('total', before, '->', after);
console.log('status', status);
console.log('errors', errs.length?errs.join('\n'):'none');
await browser.close();
