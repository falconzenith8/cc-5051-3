// Durability-aware app shell.
//
// Runs both solvers on one terrain, lets the user drag supply caches, choose
// which path to walk, and records the actual walk (elapsed time, arrival
// durability, expanded states). The debugger panel renders the enumerable
// minimap counterexamples produced in the worker, including why discarding a
// state at the junction destroys the final optimum.

import * as THREE from 'three';
import {
  EQUIPMENT, DEFAULT_EQUIPMENT, SURFACE, SURFACE_LABEL, SURFACE_COLOR,
  WORLD, DURABILITY, DEFAULT_SUPPLIES,
} from './config.js';
import { surfaceClassAt, heightAt } from './terrain.js';
import { createScene, buildDurabilityRoute, buildCoarseLine, createWalker } from './scene.js';

const $ = (id) => document.getElementById(id);
const fmt = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '–');
const css = (i) => `rgb(${SURFACE_COLOR[i].map((v) => Math.round(v * 255)).join(',')})`;

const state = {
  equipment: DEFAULT_EQUIPMENT,
  start: { ...WORLD.start },
  goal: { ...WORLD.goal },
  supplies: DEFAULT_SUPPLIES.map((s) => ({ ...s })),
  solver: 'both',
  result: null,
  chosenRoute: 'exact',
  routeGroup: null,
  coarseLine: null,
  walk: null,
  pickMode: null,
};

const scene = createScene($('view'), surfaceClassAt);
const walker = createWalker(scene.scene);

// --------------------------------------------------------------- worker
const worker = new Worker(new URL('./worker-durability.js', import.meta.url), { type: 'module' });
worker.onmessage = (ev) => {
  if (ev.data.type === 'result') onResult(ev.data.result);
  else if (ev.data.type === 'minimap') renderDebugger(ev.data.payload);
  else if (ev.data.type === 'error') {
    console.error('worker error', ev.data.message);
    setStatus('求解失败，详见控制台');
  }
};
worker.onerror = (e) => console.error('worker failed', e.message || e);

function request() {
  setStatus('构建细格并进行耐久度搜索…');
  worker.postMessage({
    type: 'solve',
    equipment: state.equipment,
    start: state.start,
    goal: state.goal,
    supplies: state.supplies,
    startDurability: DURABILITY.start,
    solver: state.solver,
  });
}

function setStatus(text) { $('status').textContent = text; }

// --------------------------------------------------------------- UI build
function buildLegend() {
  $('legend').innerHTML = SURFACE_LABEL.map((label, i) => {
    if (i === SURFACE.impassable) return `<span class="item"><span class="sw imp"></span>${label}</span>`;
    return `<span class="item"><span class="sw" style="background:${css(i)}"></span>${label}</span>`;
  }).join('');
}

function buildEquipment() {
  const wrap = $('equipment');
  wrap.innerHTML = '';
  for (const [key, eq] of Object.entries(EQUIPMENT)) {
    const btn = document.createElement('button');
    btn.className = 'equip' + (key === state.equipment ? ' active' : '');
    btn.dataset.key = key;
    btn.innerHTML = `<b>${eq.name}</b>
      <span class="cost">草 ${eq.cost.grass} · 砾 ${eq.cost.gravel} · 泥 ${eq.cost.mud}</span>`;
    btn.addEventListener('click', () => selectEquipment(key));
    wrap.appendChild(btn);
  }
  $('equip-desc').textContent = EQUIPMENT[state.equipment].desc;
}

function selectEquipment(key) {
  if (key === state.equipment) return;
  state.equipment = key;
  document.querySelectorAll('.equip').forEach((el) => {
    el.classList.toggle('active', el.dataset.key === key);
  });
  $('equip-desc').textContent = EQUIPMENT[key].desc;
  request();
}

// --------------------------------------------------------------- supplies
function buildSupplyTray() {
  const tray = $('supply-tray');
  tray.innerHTML = '';
  for (const s of state.supplies) {
    const chip = document.createElement('div');
    chip.className = 'supply-chip';
    chip.draggable = true;
    chip.dataset.id = s.id;
    chip.textContent = `补给 ${s.id.slice(-1)} (${Math.round(s.x)}, ${Math.round(s.z)})`;
    chip.addEventListener('dragstart', (ev) => {
      ev.dataTransfer.setData('text/supply-id', s.id);
      ev.dataTransfer.effectAllowed = 'move';
      draggingSupplyId = s.id;
    });
    chip.addEventListener('dragend', () => { draggingSupplyId = null; });
    tray.appendChild(chip);
  }
}

let draggingSupplyId = null;

function syncSupplyMarkers() {
  const existing = scene.supplyMarkers.all();
  for (const s of state.supplies) {
    if (!existing[s.id]) scene.supplyMarkers.add(s);
    scene.supplyMarkers.get(s.id).place(s);
  }
  for (const id of Object.keys(existing)) {
    if (!state.supplies.some((s) => s.id === id)) {
      scene.scene.remove(existing[id].group);
      delete existing[id];
    }
  }
}

// --------------------------------------------------------------- result
function onResult(res) {
  if (res.equipment !== state.equipment) return;
  state.result = res;
  renderRoutes(res);
  renderCompare(res);
  renderBlindPanel(res);
  updateChosenStats();
  setStatus(`求解 ${res.timings.solverMs} ms · 缓存 ${res.cacheHit ? '命中' : '未命中'}（键随装备/补给状态变化）`);
}

function activeRun(res) {
  if (state.chosenRoute === 'hierarchical' && res.hierarchical && res.hierarchical.ok) return res.hierarchical;
  if (res.exact && res.exact.ok) return res.exact;
  if (res.hierarchical && res.hierarchical.ok) return res.hierarchical;
  return null;
}

function renderRoutes(res) {
  if (state.routeGroup) {
    scene.scene.remove(state.routeGroup);
    state.routeGroup.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
  }
  if (state.coarseLine) {
    scene.scene.remove(state.coarseLine);
    state.coarseLine.geometry.dispose();
    state.coarseLine.material.dispose();
  }
  const run = activeRun(res);
  if (!run) {
    walker.visible = false;
    setStatus('当前输入下没有可行的耐久路线（泥路耗尽装备且无补给）');
    return;
  }
  state.routeGroup = buildDurabilityRoute(run, DURABILITY.max);
  scene.scene.add(state.routeGroup);
  if (res.hierarchical && res.hierarchical.coarsePath) {
    state.coarseLine = buildCoarseLine(res.hierarchical.coarsePath);
    if (state.coarseLine) scene.scene.add(state.coarseLine);
  }
  walker.visible = true;
  placeWalkerAt(0);
  state.walk = null;
  $('drive').textContent = '出发行进';
}

function renderCompare(res) {
  const rows = [];
  const line = (name, run, extra = '') => {
    if (!run) return '';
    if (!run.ok) return `<div class="cmp-row bad"><b>${name}</b><span>不可达：${run.reason}</span>${extra}</div>`;
    return `<div class="cmp-row">
      <b>${name}</b>
      <span>代价 ${fmt(run.cost, 2)}</span>
      <span>到达耐久 ${run.finalDurability}</span>
      <span>展开 ${run.expanded}</span>
      <span>峰值标签 ${run.peakLabels ?? '–'}</span>${extra}
    </div>`;
  };
  if (res.blind && res.blind.cost != null) {
    rows.push(`<div class="cmp-row muted"><b>无耐久粗层 A*</b>
      <span>代价 ${fmt(res.blind.cost, 2)}</span><span>展开 ${res.blind.expanded}</span></div>`);
  }
  rows.push(line('精确状态搜索', res.exact));
  if (res.hierarchical) {
    const tag = res.hierarchical.fellBack
      ? `<em class="warn">回退(${res.hierarchical.fallbackReason})</em>` : '<em class="ok">走廊成功</em>';
    rows.push(line('分层预估+精算', res.hierarchical, tag));
  }
  $('solver-compare').innerHTML = rows.join('');
  $('cache-key').textContent = res.cacheKey || '';
}

function updateChosenStats() {
  const res = state.result;
  if (!res) return;
  const run = activeRun(res);
  if (!run) {
    for (const id of ['dstat-cost', 'dstat-dur', 'dstat-expanded', 'dstat-peak', 'dstat-supplies', 'dstat-fallback']) {
      $(id).textContent = '–';
    }
    return;
  }
  $('dstat-cost').textContent = fmt(run.cost, 2);
  $('dstat-dur').textContent = run.finalDurability;
  $('dstat-expanded').textContent = run.expanded;
  $('dstat-peak').textContent = run.peakLabels ?? '–';
  $('dstat-supplies').textContent = run.totals ? run.totals.suppliesUsed : '–';
  $('dstat-fallback').textContent = res.hierarchical
    ? (res.hierarchical.fellBack ? `是 · ${res.hierarchical.fallbackReason}` : '否') : '–';
  $('dura-fill').style.width = `${run.finalDurability}%`;
  $('dura-value').textContent = run.finalDurability;
}

// ----------------------------------------------------- blind A* mini panel
function renderBlindPanel(res) {
  if (!res.blind || res.blind.cost == null) return;
  const t = res.blind.totals;
  const len = res.blind.edges.reduce((a, e) => a + e.length, 0);
  const steepest = res.blind.edges.reduce((m, e) => Math.max(m, e.steepest || 0), 0);
  $('stat-total').textContent = fmt(res.blind.cost, 1);
  $('stat-len').textContent = fmt(len, 0);
  $('stat-up').textContent = fmt(t.upExtra, 1);
  $('stat-down').textContent = fmt(t.downExtra, 1);
  $('stat-grade').textContent = `${(steepest * 100).toFixed(0)}%`;
  $('stat-expanded').textContent = res.blind.expanded;
  const mixTotal = t.surfaces.reduce((a, v) => a + v, 0) || 1;
  $('surface-mix').innerHTML = t.surfaces.map((metres, i) => {
    if (i === SURFACE.impassable || metres <= 0) return '';
    const pct = (metres / mixTotal) * 100;
    return `<div class="line"><span><span class="sw" style="background:${css(i)}"></span>${SURFACE_LABEL[i]}</span>
      <b>${fmt(metres, 0)} m · ${pct.toFixed(0)}%</b></div>`;
  }).join('');
  $('verify').innerHTML = `<div class="line"><span>粗层 A* 代价</span><b>${fmt(res.blind.cost, 2)}</b></div>
    <div class="line"><span>缓存键（装备+起终点+补给+耐久+求解器）</span><b class="muted" style="font-size:10px;word-break:break-all">${res.cacheKey}</b></div>
    <p class="muted small">缓存条目只在该装备状态（含补给位置与出发耐久）下有效；任一状态改变都会产生新键，旧条目不复用。</p>`;
}

// ------------------------------------------------------------- walk
function runEdges() {
  const run = activeRun(state.result);
  return run ? run.edges : null;
}
function pathTotal() {
  const edges = runEdges();
  return edges ? edges.reduce((a, e) => a + e.length, 0) : 0;
}

function sampleWalk(t) {
  const edges = runEdges();
  if (!edges || !edges.length) return null;
  const total = pathTotal();
  const target = Math.min(0.999999, Math.max(0, t)) * total;
  let acc = 0;
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    if (acc + e.length >= target) {
      const u = e.length ? (target - acc) / e.length : 0;
      return {
        edge: e, index: i, u, total,
        x: e.from.x + (e.to.x - e.from.x) * u,
        z: e.from.z + (e.to.z - e.from.z) * u,
        travelled: acc + e.length * u,
        durability: Math.round(e.durabilityIn + (e.durabilityOut - e.durabilityIn) * u),
      };
    }
    acc += e.length;
  }
  const last = edges[edges.length - 1];
  return { edge: last, index: edges.length - 1, u: 1, total, x: last.to.x, z: last.to.z, travelled: total, durability: last.durabilityOut };
}

function placeWalkerAt(t) {
  const s = sampleWalk(t);
  if (!s) return;
  walker.position.set(s.x, heightAt(s.x, s.z) + 0.05, s.z);
  const ahead = sampleWalk(Math.min(1, (s.travelled + 0.6) / s.total));
  if (ahead) walker.rotation.y = Math.atan2(ahead.x - s.x, ahead.z - s.z);
  $('dura-fill').style.width = `${s.durability}%`;
  $('dura-value').textContent = s.durability;
}

function finishWalk() {
  const run = activeRun(state.result);
  const elapsed = ((performance.now() - state.walk.startTs) / 1000).toFixed(1);
  $('walk-log').innerHTML = `
    <div class="line"><span>路线</span><b>${state.chosenRoute === 'hierarchical' ? '分层预估+精算' : '精确状态搜索'}</b></div>
    <div class="line"><span>实际耗时</span><b>${elapsed} s（模拟）</b></div>
    <div class="line"><span>到达装备耐久</span><b>${run.finalDurability} / ${DURABILITY.max}</b></div>
    <div class="line"><span>搜索扩展状态数</span><b>${run.expanded}</b></div>
    <div class="line"><span>峰值标签/节点</span><b>${run.peakLabels ?? '–'}</b></div>
    <div class="line"><span>补给使用次数</span><b>${run.totals ? run.totals.suppliesUsed : 0}</b></div>`;
}

// ------------------------------------------------------------- pointer
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();

function terrainHit(ev) {
  const rect = scene.renderer.domElement.getBoundingClientRect();
  ndc.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
  ndc.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(ndc, scene.camera);
  return raycaster.intersectObject(scene.terrain, false)[0];
}

scene.renderer.domElement.addEventListener('dragover', (ev) => {
  if (draggingSupplyId) { ev.preventDefault(); ev.dataTransfer.dropEffect = 'move'; }
});

scene.renderer.domElement.addEventListener('drop', (ev) => {
  const supplyId = draggingSupplyId || ev.dataTransfer?.getData('text/supply-id');
  if (!supplyId) return;
  ev.preventDefault();
  const hit = terrainHit(ev);
  if (!hit) return;
  const snap = 2;
  const p = {
    x: Math.min(WORLD.width - 0.01, Math.max(0, Math.round(hit.point.x / snap) * snap)),
    z: Math.min(WORLD.depth - 0.01, Math.max(0, Math.round(hit.point.z / snap) * snap)),
  };
  if (surfaceClassAt(p.x, p.z) === SURFACE.impassable) {
    setStatus('补给点不能放在不可通行区域');
    return;
  }
  const supply = state.supplies.find((s) => s.id === supplyId);
  if (!supply) return;
  supply.x = p.x;
  supply.z = p.z;
  draggingSupplyId = null;
  syncSupplyMarkers();
  buildSupplyTray();
  request();
});

// ------------------------------------------------------------- endpoint pick
let pointerDown = null;

function armPick(mode) {
  state.pickMode = state.pickMode === mode ? null : mode;
  for (const m of ['start', 'goal']) {
    $(`pick-${m}`).classList.toggle('armed', state.pickMode === m);
  }
  $('pick-hint').textContent = state.pickMode
    ? `点击地形放置${state.pickMode === 'start' ? '起点' : '终点'}…`
    : '点击地形放置标记；每次放置都会重新采样与求解。';
}

$('pick-start').addEventListener('click', () => armPick('start'));
$('pick-goal').addEventListener('click', () => armPick('goal'));

scene.renderer.domElement.addEventListener('pointerdown', (ev) => {
  pointerDown = { x: ev.clientX, y: ev.clientY };
});

scene.renderer.domElement.addEventListener('pointerup', (ev) => {
  if (!state.pickMode || !pointerDown) return;
  const moved = Math.hypot(ev.clientX - pointerDown.x, ev.clientY - pointerDown.y);
  pointerDown = null;
  if (moved > 4) return;   // orbit drag, not a click
  const hit = terrainHit(ev);
  if (!hit) return;
  const snap = 2;
  const p = {
    x: Math.min(WORLD.width - 0.01, Math.max(0, Math.round(hit.point.x / snap) * snap)),
    z: Math.min(WORLD.depth - 0.01, Math.max(0, Math.round(hit.point.z / snap) * snap)),
  };
  if (surfaceClassAt(p.x, p.z) === SURFACE.impassable) {
    setStatus('该点不可通行，请选择草地、碎石、泥地或高代价区');
    return;
  }
  const mode = state.pickMode;
  state[mode] = p;
  scene.markers[mode].place(p);
  armPick(null);
  request();
});

// ------------------------------------------------------------- controls
document.querySelectorAll('#solver-switch .toggle').forEach((btn) => {
  btn.addEventListener('click', () => {
    state.solver = btn.dataset.solver;
    document.querySelectorAll('#solver-switch .toggle').forEach((b) => {
      b.classList.toggle('active', b === btn);
    });
    request();
  });
});

$('route-exact').addEventListener('click', () => chooseRoute('exact'));
$('route-hier').addEventListener('click', () => chooseRoute('hierarchical'));
function chooseRoute(which) {
  state.chosenRoute = which;
  $('route-exact').classList.toggle('active', which === 'exact');
  $('route-hier').classList.toggle('active', which === 'hierarchical');
  if (state.result) { renderRoutes(state.result); updateChosenStats(); }
}

$('drive').addEventListener('click', () => {
  const run = activeRun(state.result);
  if (!run) return;
  if (state.walk && state.walk.active) { state.walk.active = false; $('drive').textContent = '出发行进'; return; }
  state.walk = { active: true, startTs: performance.now(), duration: Math.max(6, pathTotal() / 20) };
  $('drive').textContent = '暂停行进';
});

// ------------------------------------------------------------- debugger
function renderDebugger(d) {
  const mg = d.mudGate;
  const dia = d.diamond;
  const junctionRows = dia.junctionLabels.map((l) =>
    `<div class="line"><span>${l.path.join(' → ')}</span><b>代价 ${fmt(l.cost, 2)} · 耐久 ${l.durability}</b></div>`).join('');
  const drop = dia.singleLabel.drops.find((e) => e.node === 5);
  const traceRows = mg.hierarchical.trace.map((t) =>
    `<div class="line"><span>${t.phase}</span><b class="${t.ok === false ? 'bad' : 'ok'}">${t.ok === false ? `失败 · ${t.reason}` : `展开 ${t.expanded ?? ''}`}</b></div>`).join('');

  $('debug-panel').innerHTML = `
    <h3>① 可枚举小地图参照解（${mg.spec.name}）</h3>
    <div class="line"><span>穷举可行简单路径数</span><b>${mg.reference.pathCount}</b></div>
    <div class="line"><span>参照最优代价 / 路径</span><b>${fmt(mg.reference.optimumCost, 2)} · ${mg.reference.optimumPath.join('→')}</b></div>
    <div class="line"><span>精确搜索</span><b class="ok">${fmt(mg.exact.cost, 2)} · 耐久 ${mg.exact.finalDurability} · 展开 ${mg.exact.expanded}</b></div>
    <h3>② 分层法选错的输入与回退判据</h3>
    <div class="line"><span>粗层选择</span><b class="warn">${mg.hierarchical.coarsePath.join('→')}（泥路，磨损装备）</b></div>
    ${traceRows}
    <div class="line"><span>是否触发全图回退</span><b class="${mg.hierarchical.fellBack ? 'warn' : 'ok'}">${mg.hierarchical.fellBack ? `是：${mg.hierarchical.fallbackReason}` : '否'}</b></div>
    <div class="line"><span>回退后代价</span><b>${fmt(mg.hierarchical.cost, 2)}（与参照解一致）</b></div>
    <h3>③ 同价不同耐久 + 碎石门（${dia.spec.name}）</h3>
    <p class="muted small">两条分支到达汇合点 J（节点 5），代价相同而剩余耐久不同；门限 ${d.gateDcfg.gateThreshold} 只放行耐久标签。</p>
    ${junctionRows}
    <div class="line"><span>精确 Pareto 搜索</span><b class="ok">${dia.exact.ok ? `可达 · 代价 ${fmt(dia.exact.cost, 2)} · 耐久 ${dia.exact.finalDurability} · 峰值标签 ${dia.exact.peakLabels}` : '不可达'}</b></div>
    <div class="line"><span>单标签（提前淘汰）搜索</span><b class="bad">${dia.singleLabel.ok ? '可达（反例未触发）' : `不可达 · ${dia.singleLabel.reason}`}</b></div>
    ${drop ? `<div class="dropbox">在节点 ${drop.node} 提前淘汰：保留标签 (代价 ${fmt(drop.kept.g, 2)}, 耐久 ${drop.kept.d})，
      丢弃标签 (代价 ${fmt(drop.dropped.g, 2)}, 耐久 ${drop.dropped.d})。丢弃的耐久标签本可越过门限，
      故提前淘汰破坏了最终最优性。</div>` : ''}`;
}

// ------------------------------------------------------------- loop
function frame(now) {
  if (state.walk && state.walk.active && state.routeGroup) {
    const t = (now - state.walk.startTs) / (state.walk.duration * 1000);
    if (t >= 1) {
      state.walk.active = false;
      placeWalkerAt(1);
      $('drive').textContent = '出发行进';
      finishWalk();
    } else {
      placeWalkerAt(t);
    }
  }
  if (walker.visible) walker.children[0].position.y = 1.25 + Math.sin(now * 0.009) * 0.06;
  scene.controls.update();
  scene.renderer.render(scene.scene, scene.camera);
  requestAnimationFrame(frame);
}

window.addEventListener('resize', () => {
  scene.camera.aspect = window.innerWidth / window.innerHeight;
  scene.camera.updateProjectionMatrix();
  scene.renderer.setSize(window.innerWidth, window.innerHeight, false);
});

buildLegend();
buildEquipment();
buildSupplyTray();
syncSupplyMarkers();
chooseRoute('exact');
worker.postMessage({ type: 'minimap-debug' });
request();
requestAnimationFrame(frame);
