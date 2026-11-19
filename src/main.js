import * as THREE from 'three';
import { EQUIPMENT, DEFAULT_EQUIPMENT, SURFACE, SURFACE_LABEL, SURFACE_COLOR, WORLD } from './config.js';
import { surfaceClassAt, heightAt } from './terrain.js';
import { createScene, buildRouteLine, createWalker } from './scene.js';

const $ = (id) => document.getElementById(id);
const fmt = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '–');
const pct = (v) => `${Math.round(v * 100)}%`;
const css = (i) => `rgb(${SURFACE_COLOR[i].map((v) => Math.round(v * 255)).join(',')})`;

const state = {
  equipment: DEFAULT_EQUIPMENT,
  start: { ...WORLD.start },
  goal: { ...WORLD.goal },
  pickMode: null,
  result: null,
  route: null,
  profile: null,
  scrubT: 0,
  walking: false,
  walkStart: 0,
  walkDuration: 1,
};

const scene = createScene($('view'), surfaceClassAt);
const walker = createWalker(scene.scene);

// ------------------------------------------------------------------- worker
const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
worker.onmessage = (ev) => {
  if (ev.data.type === 'result') onResult(ev.data.result);
  else if (ev.data.type === 'error') {
    console.error('worker error', ev.data.message);
    setStatus('求解失败，详见控制台');
  }
};
worker.onerror = (e) => console.error('worker failed', e.message || e);

function request(equipment = state.equipment) {
  setStatus('构建细格并求解…');
  worker.postMessage({ type: 'solve', equipment, start: state.start, goal: state.goal });
}

// ------------------------------------------------------------------- UI build
function buildLegend() {
  $('legend').innerHTML = SURFACE_LABEL.map((label, i) => {
    if (i === SURFACE.impassable) {
      return `<span class="item"><span class="sw imp"></span>${label}</span>`;
    }
    const extra = i === SURFACE.costly ? '昂贵但可走' : '';
    return `<span class="item"><span class="sw" style="background:${css(i)}"></span>${label}${extra ? ` · ${extra}` : ''}</span>`;
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
  state.walking = false;
  request(key);
}

function setStatus(text) { $('status').textContent = text; }

// --------------------------------------------------------------------- result
function onResult(res) {
  if (res.equipment !== state.equipment) return;   // stale switch
  if (res.start.x !== state.start.x || res.start.z !== state.start.z) return;
  if (res.goal.x !== state.goal.x || res.goal.z !== state.goal.z) return;
  if (!res.ok) return renderFailure(res);
  state.result = res;
  installRoute(res);
  renderStats(res);
  renderVerify(res);
  updateScrub(0);
  $('scrub').value = '0';
  $('drive').disabled = false;
  setStatus(`A* ${res.solveMs} ms · 独立复核 ${res.verifyMs} ms`);
}

function installRoute(res) {
  if (state.route) {
    scene.scene.remove(state.route);
    state.route.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
  }
  state.route = buildRouteLine(res.astar);
  scene.scene.add(state.route);
  state.walkDuration = Math.max(6, state.route.userData.curve.total / 20);
  buildProfileSamples(res);
  walker.visible = true;
  placeWalker(0);
  state.scrubT = 0;
  state.walking = false;
  $('drive').textContent = '出发行进';
}

// Dense samples of height and charged cost along the chosen route. The height
// curve is what makes "short steep" vs "long gentle" directly readable: the same
// ridge is a narrow spike on one side and a wide swell on the other.
function buildProfileSamples(res) {
  const samples = [];
  let acc = 0;
  for (const e of res.astar.edges) {
    samples.push({ d: acc, h: heightAt(e.from.x, e.from.z), c: e.cost / e.length });
    acc += e.length;
  }
  const last = res.astar.edges[res.astar.edges.length - 1];
  if (last) samples.push({ d: acc, h: heightAt(last.to.x, last.to.z), c: 0 });
  state.profile = { samples, total: acc };
  drawProfile();
}

function drawProfile() {
  const cv = $('profile');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cssW = cv.clientWidth || 296;
  const cssH = cv.clientHeight || 74;
  if (cv.width !== Math.round(cssW * dpr) || cv.height !== Math.round(cssH * dpr)) {
    cv.width = Math.round(cssW * dpr);
    cv.height = Math.round(cssH * dpr);
  }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const W = cssW;
  const H = cssH;
  ctx.clearRect(0, 0, W, H);
  const p = state.profile;
  if (!p || !p.samples.length) return;

  const pad = { l: 8, r: 8, t: 12, b: 14 };
  const pw = W - pad.l - pad.r;
  const ph = H - pad.t - pad.b;
  const hs = p.samples.map((s) => s.h);
  const h0 = Math.min(...hs);
  const h1 = Math.max(...hs);
  const hSpan = Math.max(1, h1 - h0);
  const X = (d) => pad.l + (d / p.total) * pw;
  const Y = (h) => pad.t + ph - ((h - h0) / hSpan) * ph;

  for (let i = 0; i < p.samples.length - 1; i++) {
    const a = p.samples[i];
    const b = p.samples[i + 1];
    const t = Math.min(1, a.c / 8);
    const r = Math.round(75 + t * 180);
    const g = Math.round(211 - t * 150);
    const bl = Math.round(138 - t * 90);
    ctx.fillStyle = `rgba(${r},${g},${bl},0.9)`;
    ctx.fillRect(X(a.d), H - pad.b + 4, Math.max(1.5, X(b.d) - X(a.d)), 4);
  }

  ctx.beginPath();
  ctx.moveTo(X(0), Y(p.samples[0].h));
  for (const s of p.samples) ctx.lineTo(X(s.d), Y(s.h));
  ctx.lineTo(X(p.total), pad.t + ph);
  ctx.lineTo(X(0), pad.t + ph);
  ctx.closePath();
  const grad = ctx.createLinearGradient(0, pad.t, 0, pad.t + ph);
  grad.addColorStop(0, 'rgba(110,231,168,0.34)');
  grad.addColorStop(1, 'rgba(110,231,168,0.02)');
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(X(0), Y(p.samples[0].h));
  for (const s of p.samples) ctx.lineTo(X(s.d), Y(s.h));
  ctx.strokeStyle = '#6ee7a8';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  const x = pad.l + state.scrubT * pw;
  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, pad.t - 3);
  ctx.lineTo(x, H - pad.b);
  ctx.stroke();
  ctx.fillStyle = '#e6edf3';
  ctx.beginPath();
  ctx.arc(x, pad.t - 3, 2.4, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = 'rgba(147,163,181,0.85)';
  ctx.font = '9px ui-monospace, monospace';
  ctx.textBaseline = 'top';
  ctx.fillText(`${h0.toFixed(0)}–${h1.toFixed(0)} m`, pad.l, 1);
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('每米代价', W - pad.r - 38, H - 1);
}

function renderFailure(res) {
  state.result = null;
  if (state.route) {
    scene.scene.remove(state.route);
    state.route = null;
  }
  state.profile = null;
  drawProfile();
  walker.visible = false;
  $('drive').disabled = true;
  for (const id of ['stat-total', 'stat-len', 'stat-up', 'stat-down', 'stat-grade', 'stat-expanded']) {
    $(id).textContent = '–';
  }
  $('surface-mix').innerHTML = '';
  $('verify').innerHTML = '';
  $('segment').innerHTML = '<p class="muted small">没有可行路线。</p>';
  $('scrub-label').textContent = '—';
  $('stat-grade').style.color = '';
  setStatus(`无法规划：${describeReason(res.reason)}`);
}

function describeReason(reason) {
  return {
    'start-impassable': '起点位于不可通行区域',
    'goal-impassable': '终点位于不可通行区域',
    unreachable: '所有连线都被不可通行地形或超出上限的坡度切断',
  }[reason] || reason;
}

function renderStats(res) {
  const { astar } = res;
  const t = astar.totals;
  let len = 0;
  let steepest = 0;
  for (const e of astar.edges) {
    len += e.length;
    steepest = Math.max(steepest, e.steepest);
  }
  $('stat-total').textContent = fmt(astar.cost, 1);
  $('stat-len').textContent = `${fmt(len, 0)} m`;
  $('stat-up').textContent = `+${fmt(t.upExtra, 1)}`;
  $('stat-down').textContent = `+${fmt(t.downExtra, 1)}`;
  const cap = EQUIPMENT[state.equipment].maxGrade;
  $('stat-grade').textContent = `${pct(steepest)} / 上限 ${pct(cap)}`;
  $('stat-grade').style.color = steepest > cap ? 'var(--danger)' : '';
  $('stat-expanded').textContent = astar.expanded;

  const total = t.surfaces.reduce((a, b) => a + b, 0) || 1;
  const rows = [];
  for (const i of [SURFACE.grass, SURFACE.gravel, SURFACE.mud, SURFACE.costly]) {
    const m = t.surfaces[i];
    if (m <= 0.02) continue;
    rows.push(`<div class="row">
      <label>${SURFACE_LABEL[i]}</label>
      <div class="track"><div class="fill" style="width:${(m / total) * 100}%;background:${css(i)}"></div></div>
      <span class="amt">${fmt(m, 0)} m</span>
    </div>`);
  }
  $('surface-mix').innerHTML = rows.join('') || '<div class="muted small">未接触任何地表</div>';
}

function renderVerify(res) {
  const dijOk = res.dijkstra.cost !== null;
  const diff = dijOk ? res.astar.cost - res.dijkstra.cost : NaN;
  const re = res.reintegrated;
  const reDiff = re && re.ok ? re.cost - res.astar.cost : NaN;
  const h = res.heuristic;

  const nm = res.naiveModel;
  const rows = [
    ['A* 代价', fmt(res.astar.cost, 2), ''],
    ['Dijkstra 复核', dijOk ? fmt(res.dijkstra.cost, 2) : '不可达', ''],
    ['两者之差', dijOk ? `${diff >= 0 ? '+' : ''}${fmt(diff, 3)}` : '–', Math.abs(diff) < 0.05 ? 'ok' : 'bad'],
    ['0.05 m 重积分', re && re.ok ? fmt(re.cost, 2) : '–', Math.abs(reDiff) < res.astar.cost * 0.01 ? 'ok' : 'warn'],
    ['启发式一致性', h.consistent ? '通过' : '违背', h.consistent ? 'ok' : 'bad'],
    ['采样边数', `${h.checked}`, ''],
    ['本路线端点漏判', `${res.skimmed} 条`, res.skimmed > 0 ? 'ok' : 'muted'],
    ['全网端点漏判边', `${res.survey.endpointBlind} / ${res.survey.checked}`,
      res.survey.endpointBlind > 0 ? 'ok' : 'muted'],
    ['粗模型自估 / 细格重算', nm ? `${fmt(nm.believed, 2)} / ${fmt(nm.honest, 2)}` : '–',
      nm && nm.underpriced > 0.05 ? 'ok' : 'muted'],
    ['粗模型路线偏离本路线', nm ? `${fmt(nm.detour, 1)} m` : '–', nm && nm.detour > 2 ? 'ok' : 'muted'],
  ];
  const underNote = nm && nm.underpriced > 0.05
    ? `粗模型把这条线估成 ${fmt(nm.believed, 1)}，细格重算为 ${fmt(nm.honest, 1)}（低估 ${fmt(nm.underpriced, 1)}）。`
    : '本装备下粗模型未明显低估。';
  $('verify').innerHTML = rows.map(([k, v, cls]) =>
    `<div class="line"><span>${k}</span><b class="${cls}">${v}</b></div>`).join('')
    + `<p class="muted small" style="margin-top:6px">端点漏判：两个 2 m 节点都在草/砾上，
      但细格积分仍穿过泥、碎石或不可通行格。粗模型每 2 m 只看节点颜色，其选出的线
      （与本路线平均偏离 ${nm ? fmt(nm.detour, 1) : '–'} m）在细格下更贵：${underNote}</p>`;
}

// ------------------------------------------------------------ scrub / walk
function pathLen() {
  const e = state.result?.astar.edges;
  return e ? e.reduce((a, x) => a + x.length, 0) : 0;
}

function sampleAt(t) {
  const edges = state.result?.astar.edges;
  if (!edges || !edges.length) return null;
  const total = pathLen();
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
      };
    }
    acc += e.length;
  }
  const last = edges[edges.length - 1];
  return { edge: last, index: edges.length - 1, u: 1, total, x: last.to.x, z: last.to.z, travelled: total };
}

function placeWalker(t) {
  const s = sampleAt(t);
  if (!s) return;
  // Use the same continuous height field the planner integrates over.
  walker.position.set(s.x, heightAt(s.x, s.z) + 0.05, s.z);
  const ahead = Math.min(1, (s.travelled + 0.6) / s.total);
  const n = sampleAt(ahead);
  if (n) walker.rotation.y = Math.atan2(n.x - s.x, n.z - s.z);
}

function updateScrub(t) {
  state.scrubT = t;
  const s = sampleAt(t);
  placeWalker(t);
  if (!s) {
    $('segment').innerHTML = '<p class="muted small">尚无路线。</p>';
    return;
  }
  const e = s.edge;
  $('scrub-label').textContent =
    `${fmt(s.travelled, 0)} / ${fmt(s.total, 0)} m · 第 ${s.index + 1}/${state.result.astar.edges.length} 段`;

  const total = e.cost || 1;
  const parts = [
    ['地表基础', e.baseCost, '#5b9bde'],
    ['上坡附加', e.upExtra, '#ffb454'],
    ['下坡附加', e.downExtra, '#e0736b'],
  ];
  const bar = parts.map(([name, v, c]) =>
    `<i title="${name} ${fmt(v, 2)}" style="width:${(v / total) * 100}%;background:${c}"></i>`).join('');
  const contrib = parts.map(([name, v, c]) => `
    <div class="row">
      <label>${name}</label>
      <div class="track"><div class="fill" style="width:${(v / total) * 100}%;background:${c}"></div></div>
      <code>${fmt(v, 2)}</code>
    </div>`).join('');
  const segMix = [0, 1, 2, 3].map((i) => {
    const m = e.surfaces[i];
    return m > 0.001 ? `<span>${SURFACE_LABEL[i]} ${fmt(m, 2)} m</span>` : '';
  }).filter(Boolean).join(' · ') || '—';

  $('segment').innerHTML = `
    <div class="seg-head"><span>本段 ${fmt(e.length, 2)} m · 经 ${segMix}</span>
      <span>代价 <b>${fmt(e.cost, 2)}</b></span></div>
    <div class="seg-bar">${bar}</div>
    <div class="contribution">${contrib}</div>
    <div class="muted small">最陡 ${pct(e.steepest)} · 坡度附加 ${fmt(e.slopeExtra, 2)} ·
      每米代价 ${fmt(e.cost / e.length, 2)}</div>`;
  drawProfile();
}

$('scrub').addEventListener('input', (ev) => {
  if (state.walking) stopWalk(false);
  updateScrub(Number(ev.target.value) / 1000);
});

function stopWalk(label = true) {
  if (!state.walking) return;
  state.walking = false;
  $('drive').textContent = '出发行进';
  if (label) setStatus('已暂停；拖动滑块可查看任意一段的代价构成');
}

$('drive').addEventListener('click', () => {
  if (!state.result || !state.route) return;
  if (state.walking) return stopWalk();
  if (state.scrubT >= 0.999) { updateScrub(0); $('scrub').value = '0'; }
  state.walking = true;
  state.walkStart = performance.now() - state.scrubT * state.walkDuration * 1000;
  $('drive').textContent = '暂停行进';
  setStatus('沿规划折线实际行进中');
});

$('reset').addEventListener('click', () => {
  stopWalk(false);
  updateScrub(0);
  $('scrub').value = '0';
  setStatus('');
});

// --------------------------------------------------------------- endpoint pick
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
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

  const rect = scene.renderer.domElement.getBoundingClientRect();
  ndc.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
  ndc.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(ndc, scene.camera);
  const hit = raycaster.intersectObject(scene.terrain, false)[0];
  if (!hit) return;

  const mode = state.pickMode;
  // Planner nodes are a 2 m lattice, so snap the marker to it; the displayed
  // marker then matches the node the solver actually uses.
  const snap = 2;
  const p = {
    x: Math.min(WORLD.width - 0.01, Math.max(0, Math.round(hit.point.x / snap) * snap)),
    z: Math.min(WORLD.depth - 0.01, Math.max(0, Math.round(hit.point.z / snap) * snap)),
  };
  const cls = surfaceClassAt(p.x, p.z);
  if (cls === SURFACE.impassable) {
    setStatus('该点不可通行，请选择草地、碎石、泥地或高代价区');
    return;
  }
  state[mode] = p;
  scene.markers[mode].place(p);
  armPick(null);
  stopWalk(false);
  request();
});

// --------------------------------------------------------------------- loop
let last = performance.now();
function frame(now) {
  last = now;
  if (state.walking && state.result) {
    const t = (now - state.walkStart) / (state.walkDuration * 1000);
    if (t >= 1) {
      updateScrub(1);
      state.walking = false;
      $('drive').textContent = '出发行进';
      $('scrub').value = '1000';
      setStatus('已抵达终点');
    } else {
      updateScrub(t);
      $('scrub').value = String(Math.round(t * 1000));
    }
  }
  if (walker.visible) {
    walker.children[0].position.y = 1.25 + Math.sin(now * 0.009) * 0.06;
  }
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
request(state.equipment);
requestAnimationFrame(frame);
