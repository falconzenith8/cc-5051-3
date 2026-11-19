import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { WORLD, SURFACE, SURFACE_COLOR } from './config.js';
import { heightAt, SMALL_ROCKS, OUTCROPS } from './terrain.js';

// Cheap deterministic noise for texture speckle. Kept separate from the
// planner: this only affects appearance, never cost.
function hash01(x, z) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(z | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}

function surfaceRgbAt(x, z, surfaceAt, cls) {
  const c = SURFACE_COLOR[cls];
  const n = hash01(Math.floor(x * 5.3), Math.floor(z * 5.3));
  const fine = 0.88 + 0.24 * n;
  if (cls === SURFACE.grass) {
    const m = 0.5 + 0.5 * Math.sin(x * 0.19 + Math.cos(z * 0.15) * 2.0);
    return [c[0] * (0.82 + 0.22 * m) * fine, c[1] * (0.86 + 0.18 * m) * fine, c[2] * (0.84 + 0.18 * m) * fine];
  }
  if (cls === SURFACE.impassable) return [c[0], c[1], c[2]];
  return [c[0] * fine, c[1] * fine, c[2] * fine];
}

export function createScene(canvas, surfaceAt) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0d1117);
  scene.fog = new THREE.Fog(0x0d1117, 300, 540);

  const camera = new THREE.PerspectiveCamera(46, window.innerWidth / window.innerHeight, 0.5, 900);
  camera.position.set(WORLD.width * 0.16, 132, WORLD.depth + 96);

  const controls = new OrbitControls(camera, canvas);
  controls.target.set(WORLD.width * 0.5, 0, WORLD.depth * 0.44);
  controls.enableDamping = true;
  controls.dampingFactor = 0.075;
  controls.maxPolarAngle = Math.PI * 0.46;
  controls.minDistance = 24;
  controls.maxDistance = 460;

  scene.add(new THREE.HemisphereLight(0xc4dcff, 0x1c2318, 0.95));
  const sun = new THREE.DirectionalLight(0xfff1d6, 2.4);
  sun.position.set(-110, 170, 200);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const s = 200;
  sun.shadow.camera.left = -s;
  sun.shadow.camera.right = s;
  sun.shadow.camera.top = s;
  sun.shadow.camera.bottom = -s;
  sun.shadow.camera.near = 40;
  sun.shadow.camera.far = 560;
  sun.shadow.bias = -0.0007;
  scene.add(sun);
  const rim = new THREE.DirectionalLight(0x7fa8ff, 0.5);
  rim.position.set(200, 90, -160);
  scene.add(rim);

  // ------------------------------------------------------------ terrain mesh
  const step = WORLD.renderStep;
  const terrain = buildTerrain(surfaceAt, step);
  terrain.receiveShadow = true;
  terrain.castShadow = true;
  scene.add(terrain);

  addRocks(scene);
  addCostlyPebbles(scene);
  const markers = addMarkers(scene);

  return { renderer, scene, camera, controls, terrain, markers };
}

function buildTerrain(surfaceAt, step) {
  const gx = Math.round(WORLD.width / step);
  const gz = Math.round(WORLD.depth / step);
  const geo = new THREE.PlaneGeometry(WORLD.width, WORLD.depth, gx, gz);
  geo.rotateX(-Math.PI / 2);
  geo.translate(WORLD.width / 2, 0, WORLD.depth / 2);
  const pos = geo.attributes.position;
  const tones = new Float32Array(pos.count * 3);

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    pos.setY(i, heightAt(x, z));
    const t = 0.93 + 0.14 * hash01(Math.floor(x * 1.7), Math.floor(z * 1.7));
    tones[i * 3] = t;
    tones[i * 3 + 1] = t;
    tones[i * 3 + 2] = t;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(tones, 3));
  geo.computeVertexNormals();

  const tex = buildSurfaceTexture(surfaceAt);
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    map: tex,
    roughness: 0.97,
    metalness: 0.0,
  });
  addContours(mat);
  return new THREE.Mesh(geo, mat);
}

// Contour bands make the short/steep ridge and the long/gentle saddle legible
// without changing the underlying height field the planner samples.
function addContours(material) {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        float hgt = vWPos.y;
        float f1 = abs(fract(hgt / 1.5 + 0.5) - 0.5);
        float minor = smoothstep(0.055, 0.0, f1);
        float f2 = abs(fract(hgt / 7.5 + 0.5) - 0.5);
        float major = smoothstep(0.018, 0.0, f2);
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.66, minor * 0.35);
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.5, major * 0.6);
      `);
  };
  material.customProgramCacheKey = () => 'contoured-v1';
}

// Texture resolution ~0.23 m/px: finer than the 2 m planner node spacing and
// comparable to the 0.2 m truth grid, so thin strips are visible.
function buildSurfaceTexture(surfaceAt) {
  const W = 1024;
  const H = Math.round(W * (WORLD.depth / WORLD.width));
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(W, H);
  for (let j = 0; j < H; j++) {
    const z = ((j + 0.5) / H) * WORLD.depth;
    for (let i = 0; i < W; i++) {
      const x = ((i + 0.5) / W) * WORLD.width;
      const cls = surfaceAt(x, z);
      const c = surfaceRgbAt(x, z, surfaceAt, cls);
      const k = (j * W + i) * 4;
      img.data[k] = Math.min(255, c[0] * 255);
      img.data[k + 1] = Math.min(255, c[1] * 255);
      img.data[k + 2] = Math.min(255, c[2] * 255);
      img.data[k + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

function addRocks(scene) {
  const rockMat = new THREE.MeshStandardMaterial({ color: 0x59606a, roughness: 0.92, flatShading: true });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x30353d, roughness: 1.0, flatShading: true });
  const geos = [
    new THREE.DodecahedronGeometry(1, 0),
    new THREE.IcosahedronGeometry(1, 0),
    new THREE.OctahedronGeometry(1, 1),
  ];
  let seed = 7;
  const rnd = () => ((seed = (Math.imul(seed, 48271) % 2147483647) >>> 0) / 2147483647);

  for (const o of OUTCROPS) {
    const g = new THREE.Group();
    for (let k = 0; k < 5; k++) {
      const m = new THREE.Mesh(geos[k % geos.length], k % 2 ? darkMat : rockMat);
      const a = rnd() * Math.PI * 2;
      const r = rnd() * 0.5;
      const px = o.x + Math.cos(a) * o.rx * r;
      const pz = o.z + Math.sin(a) * o.rz * r;
      m.position.set(px, heightAt(px, pz) + 1.2 + rnd() * 1.6, pz);
      m.scale.set(2.6 + rnd() * 3.2, 2.0 + rnd() * 2.6, 2.4 + rnd() * 3.0);
      m.rotation.set(rnd() * 3, rnd() * 3, rnd() * 3);
      m.castShadow = true;
      m.receiveShadow = true;
      g.add(m);
    }
    scene.add(g);
  }

  for (const r of SMALL_ROCKS) {
    const m = new THREE.Mesh(geos[0], rockMat);
    m.position.set(r.x, heightAt(r.x, r.z) + r.r * 0.42, r.z);
    m.scale.set(r.r * 1.15, r.r * 0.9, r.r * 1.05);
    m.rotation.set(rnd() * 3, rnd() * 3, rnd() * 3);
    m.castShadow = true;
    m.receiveShadow = true;
    scene.add(m);
  }
}

// Scatter of loose stones across the expensive boulder field. They are visual
// only; the field is walkable and the planner charges a finite high cost, not a
// block.
function addCostlyPebbles(scene) {
  const mat = new THREE.MeshStandardMaterial({ color: 0x8a7458, roughness: 1.0, flatShading: true });
  const geo = new THREE.DodecahedronGeometry(1, 0);
  let seed = 991;
  const rnd = () => ((seed = (Math.imul(seed, 48271) % 2147483647) >>> 0) / 2147483647);
  const field = { x: 126, z: 96, rx: 20, rz: 13 };
  for (let k = 0; k < 150; k++) {
    const a = rnd() * Math.PI * 2;
    const r = Math.sqrt(rnd());
    const x = field.x + Math.cos(a) * field.rx * r;
    const z = field.z + Math.sin(a) * field.rz * r;
    const s = 0.16 + rnd() * 0.42;
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, heightAt(x, z) + s * 0.4, z);
    m.scale.set(s * 1.2, s * 0.8, s);
    m.rotation.set(rnd() * 3, rnd() * 3, rnd() * 3);
    m.castShadow = true;
    m.receiveShadow = true;
    scene.add(m);
  }
}

function addMarkers(scene) {
  const markers = {};
  const mk = (key, p, color) => {
    const g = new THREE.Group();
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(1.5, 2.2, 40),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, side: THREE.DoubleSide }),
    );
    ring.rotation.x = -Math.PI / 2;
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.12, 0.12, 5.4, 8),
      new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.55, roughness: 0.5 }),
    );
    pole.position.y = 2.7;
    pole.castShadow = true;
    const cap = new THREE.Mesh(
      new THREE.SphereGeometry(0.42, 16, 12),
      new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 1.1 }),
    );
    cap.position.y = 5.5;
    g.add(ring, pole, cap);
    const place = (q) => {
      const y = heightAt(q.x, q.z);
      g.position.set(q.x, y, q.z);
      ring.position.y = 0.12;
    };
    place(p);
    scene.add(g);
    markers[key] = { group: g, place };
  };
  mk('start', WORLD.start, 0x6ee7a8);
  mk('goal', WORLD.goal, 0xffb454);
  return markers;
}

export { addMarkers };

// --------------------------------------------------------------- route curve
// A piecewise-linear curve through the exact planner nodes. The walker and the
// tube both follow this, so the rendered trajectory is the trajectory that was
// costed; no smoothing pass is allowed to invent a cheaper-looking line.
class PolylineCurve extends THREE.Curve {
  constructor(points) {
    super();
    this.points = points;
    this.lengths = [0];
    let acc = 0;
    for (let i = 1; i < points.length; i++) {
      acc += points[i].distanceTo(points[i - 1]);
      this.lengths.push(acc);
    }
    this.total = acc || 1;
  }
  getPoint(t, target = new THREE.Vector3()) {
    const d = Math.min(this.total, Math.max(0, t) * this.total);
    let i = 1;
    while (i < this.lengths.length && this.lengths[i] < d) i++;
    const a = this.points[i - 1];
    const b = this.points[Math.min(i, this.points.length - 1)];
    const segLen = this.lengths[i] - this.lengths[i - 1] || 1;
    const u = (d - this.lengths[i - 1]) / segLen;
    return target.copy(a).lerp(b, Math.min(1, Math.max(0, u)));
  }
}

// Colour a route by actual charged cost per metre on an absolute scale shared
// across equipment, so an expensive stretch is visibly expensive rather than
// merely "less smooth". Anchors: 1/m = green, 2/m = yellow, 4/m = orange,
// 8/m+ = red.
const COST_STOPS = [
  [1.0, new THREE.Color(0x4bd38a)],
  [2.0, new THREE.Color(0xd6d94f)],
  [4.0, new THREE.Color(0xff9a3d)],
  [8.0, new THREE.Color(0xff4d3d)],
];

function costColor(density) {
  if (density <= COST_STOPS[0][0]) return COST_STOPS[0][1].clone();
  for (let i = 0; i < COST_STOPS.length - 1; i++) {
    const [d0, c0] = COST_STOPS[i];
    const [d1, c1] = COST_STOPS[i + 1];
    if (density <= d1) {
      return c0.clone().lerp(c1, (density - d0) / (d1 - d0));
    }
  }
  return COST_STOPS[COST_STOPS.length - 1][1].clone();
}

export function buildRouteLine(result) {
  const points = [];
  const edgeDensity = [];
  const edgeEnd = [];     // cumulative distance at each edge's end
  let acc = 0;
  for (const e of result.edges) {
    if (!points.length) {
      points.push(new THREE.Vector3(e.from.x, heightAt(e.from.x, e.from.z) + 0.55, e.from.z));
    }
    points.push(new THREE.Vector3(e.to.x, heightAt(e.to.x, e.to.z) + 0.55, e.to.z));
    edgeDensity.push(e.cost / e.length);
    acc += e.length;
    edgeEnd.push(acc);
  }
  if (points.length < 2) return null;

  const curve = new PolylineCurve(points);
  const group = new THREE.Group();

  const segs = Math.max(24, result.edges.length * 3);
  const tubeGeo = new THREE.TubeGeometry(curve, segs, 0.32, 8, false);
  const uv = tubeGeo.attributes.uv;
  const colors = new Float32Array(uv.count * 3);

  for (let i = 0; i < uv.count; i++) {
    // uv.x is the arc-length fraction along the tube since PolylineCurve is
    // arc-length parameterised. Map it back to the edge that owns that distance
    // so differing edge lengths (2 m vs 2.83 m) are coloured correctly.
    const dist = uv.getX(i) * curve.total;
    let k = 0;
    while (k < edgeEnd.length - 1 && edgeEnd[k] < dist) k++;
    const c = costColor(edgeDensity[k]);
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  tubeGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const tube = new THREE.Mesh(tubeGeo, new THREE.MeshStandardMaterial({
    vertexColors: true,
    emissive: 0x1e5a3d,
    emissiveIntensity: 0.3,
    roughness: 0.42,
    metalness: 0.05,
  }));
  tube.castShadow = true;
  group.add(tube);

  const glow = new THREE.Mesh(
    new THREE.TubeGeometry(curve, segs, 0.95, 8, false),
    new THREE.MeshBasicMaterial({ color: 0x9ff0c4, transparent: true, opacity: 0.06, depthWrite: false }),
  );
  group.add(glow);

  group.userData.curve = curve;
  group.userData.edgeDensity = edgeDensity;
  return group;
}

export function createWalker(scene) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.5, 1.1, 6, 12),
    new THREE.MeshStandardMaterial({ color: 0x8ff0c0, emissive: 0x3aa877, emissiveIntensity: 0.5, roughness: 0.5 }),
  );
  body.position.y = 1.25;
  body.castShadow = true;
  const pack = new THREE.Mesh(
    new THREE.BoxGeometry(0.5, 0.7, 0.35),
    new THREE.MeshStandardMaterial({ color: 0x2f4f6b, roughness: 0.8 }),
  );
  pack.position.set(0, 1.45, -0.42);
  pack.castShadow = true;
  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.4, 18, 14),
    new THREE.MeshStandardMaterial({ color: 0xf1e6d0, roughness: 0.7 }),
  );
  head.position.y = 2.35;
  head.castShadow = true;
  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(0.07, 0.07, 4, 8),
    new THREE.MeshBasicMaterial({ color: 0x8ff0c0, transparent: true, opacity: 0.22, depthWrite: false }),
  );
  beam.position.y = 4.4;
  g.add(body, pack, head, beam);
  g.visible = false;
  scene.add(g);
  return g;
}
