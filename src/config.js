// World and solver configuration shared by the browser app and the Node tests.

export const WORLD = {
  width: 240,   // metres, x
  depth: 180,   // metres, z
  // Fine "truth" grid. Everything the planner charges for is sampled on this
  // lattice at 0.2 m; the rendered mesh uses a coarser lattice but the same
  // continuous height field.
  cell: 0.2,
  renderStep: 1.5,
  start: { x: 52, z: 160 },
  goal: { x: 150, z: 18 },
};

// Nodes the planner searches over. Spacing 2 m (10 fine cells). The cost of an
// edge is integrated over every fine cell the edge actually touches, so thin
// strips are never skipped just because node spacing is coarse.
export const SEARCH = {
  nodeSpacing: 2,
  // 8-connected. Diagonals are charged as sqrt(2) * d and are cut off when the
  // fine-cell traversal passes through an impassable cell.
  neighbours: [
    [1, 0], [-1, 0], [0, 1], [0, -1],
    [1, 1], [1, -1], [-1, 1], [-1, -1],
  ],
};

// Three surface classes plus the two ways a surface can say "no".
//   passable   : can be walked, edge cost finite
//   impassable : hard barrier, no edge may cross it
//   costly     : walkable but very expensive; NOT the same state as impassable
export const SURFACE = {
  grass: 0,
  gravel: 1,
  mud: 2,
  costly: 3,
  impassable: 4,
};

export const SURFACE_LABEL = ['草地', '碎石', '泥地', '高代价', '不可通行'];
export const SURFACE_COLOR = [
  [0.36, 0.58, 0.28],
  [0.60, 0.58, 0.50],
  [0.45, 0.33, 0.20],
  [0.72, 0.20, 0.16],
  [0.10, 0.10, 0.12],
];

// Per-metre cost of walking on a surface for each piece of equipment.
// Multiply by edge length (and by grade factor, see below).
export const EQUIPMENT = {
  boots: {
    name: '登山靴',
    desc: '轻装徒步，泥地难走，碎石稳定',
    cost: { grass: 1.0, gravel: 1.25, mud: 6.5, costly: 9.0 },
    grade: { up: 4.2, down: 1.8 },
    maxGrade: 0.55,
  },
  crampons: {
    name: '冰爪',
    desc: '陡坡抓地强，泥地会陷，碎石易绊',
    cost: { grass: 1.15, gravel: 2.4, mud: 10.0, costly: 5.0 },
    grade: { up: 0.7, down: 0.9 },
    maxGrade: 1.6,
  },
  atv: {
    name: '全地形车',
    desc: '碎石飞快，泥地极贵，陡坡几乎过不去',
    cost: { grass: 1.6, gravel: 0.55, mud: 14.0, costly: 11.0 },
    grade: { up: 6.5, down: 2.2 },
    maxGrade: 0.34,
  },
};

export const DEFAULT_EQUIPMENT = 'boots';
