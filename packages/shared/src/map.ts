import { MAP_COLS, MAP_ROWS, MAP_WIDTH, MAP_HEIGHT, TILE } from "./constants";
import { mulberry32 } from "./math";
import type { Segment } from "./raycast";

export const PROP_KINDS = [
  "cabinet",
  "crate",
  "barrel",
  "plant",
  "chair",
  "table",
  "lamp",
  "vase",
  "bench",
] as const;

export type PropKind = (typeof PROP_KINDS)[number];

export interface PropDefinition {
  id: number;
  kind: PropKind;
  /** Centre of the prop in world pixels. */
  x: number;
  y: number;
  /** Rotation in radians; also the rotation a morphed hider adopts. */
  angle: number;
  /** Sprite footprint, used for hit tests and for rendering. */
  width: number;
  height: number;
}

export interface MapDefinition {
  cols: number;
  rows: number;
  tile: number;
  width: number;
  height: number;
  /** Row-major wall grid: 1 = solid. */
  walls: Uint8Array;
  props: PropDefinition[];
  /** Wall faces used by the client's visibility polygon. */
  segments: Segment[];
  seekerSpawns: Array<{ x: number; y: number }>;
  hiderSpawns: Array<{ x: number; y: number }>;
}

export const PROP_SIZE: Record<PropKind, { width: number; height: number }> = {
  cabinet: { width: 28, height: 22 },
  crate: { width: 22, height: 22 },
  barrel: { width: 18, height: 18 },
  plant: { width: 20, height: 26 },
  chair: { width: 18, height: 18 },
  table: { width: 30, height: 24 },
  lamp: { width: 16, height: 26 },
  vase: { width: 14, height: 20 },
  bench: { width: 32, height: 18 },
};

interface RoomSpec {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  kinds: PropKind[];
}

/** Five connected rooms: two north, three south. */
const ROOMS: RoomSpec[] = [
  { x0: 1, y0: 1, x1: 19, y1: 12, kinds: ["cabinet", "chair", "lamp", "vase", "table"] },
  { x0: 21, y0: 1, x1: 38, y1: 12, kinds: ["cabinet", "chair", "bench", "lamp", "crate"] },
  { x0: 1, y0: 14, x1: 12, y1: 26, kinds: ["barrel", "crate", "table", "vase", "chair"] },
  { x0: 14, y0: 14, x1: 26, y1: 26, kinds: ["table", "plant", "chair", "vase", "lamp"] },
  { x0: 28, y0: 14, x1: 38, y1: 26, kinds: ["plant", "vase", "bench", "lamp", "cabinet"] },
];

interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function fillRect(grid: Uint8Array, cols: number, rect: Rect): void {
  for (let y = rect.y0; y <= rect.y1; y++) {
    for (let x = rect.x0; x <= rect.x1; x++) {
      if (x < 0 || y < 0 || x >= cols || y >= MAP_ROWS) continue;
      grid[y * cols + x] = 1;
    }
  }
}

function buildWalls(): Uint8Array {
  const grid = new Uint8Array(MAP_COLS * MAP_ROWS);

  // Outer boundary.
  fillRect(grid, MAP_COLS, { x0: 0, y0: 0, x1: MAP_COLS - 1, y1: 0 });
  fillRect(grid, MAP_COLS, { x0: 0, y0: MAP_ROWS - 1, x1: MAP_COLS - 1, y1: MAP_ROWS - 1 });
  fillRect(grid, MAP_COLS, { x0: 0, y0: 0, x1: 0, y1: MAP_ROWS - 1 });
  fillRect(grid, MAP_COLS, { x0: MAP_COLS - 1, y0: 0, x1: MAP_COLS - 1, y1: MAP_ROWS - 1 });

  // North divider (study | library), doorway at rows 6-7.
  for (let y = 1; y <= 12; y++) {
    if (y === 6 || y === 7) continue;
    grid[y * MAP_COLS + 20] = 1;
  }

  // East/west divider between the north and south wings, with three doorways.
  for (let x = 1; x <= 38; x++) {
    if (x === 7 || x === 8 || x === 19 || x === 20 || x === 31 || x === 32) continue;
    grid[13 * MAP_COLS + x] = 1;
  }

  // South dividers (kitchen | hall | gallery), doorways at rows 19-20.
  for (let y = 14; y <= 26; y++) {
    if (y === 19 || y === 20) continue;
    grid[y * MAP_COLS + 13] = 1;
    grid[y * MAP_COLS + 27] = 1;
  }

  // Interior cover: pillars and counters.
  const obstacles: Rect[] = [
    { x0: 6, y0: 4, x1: 7, y1: 5 },
    { x0: 30, y0: 4, x1: 31, y1: 5 },
    { x0: 6, y0: 21, x1: 7, y1: 22 },
    { x0: 31, y0: 21, x1: 32, y1: 22 },
    { x0: 18, y0: 16, x1: 19, y1: 17 },
    { x0: 10, y0: 8, x1: 11, y1: 9 },
    { x0: 33, y0: 8, x1: 34, y1: 9 },
  ];
  for (const rect of obstacles) fillRect(grid, MAP_COLS, rect);

  return grid;
}

function wallAt(grid: Uint8Array, tx: number, ty: number): boolean {
  if (tx < 0 || ty < 0 || tx >= MAP_COLS || ty >= MAP_ROWS) return true;
  return grid[ty * MAP_COLS + tx] === 1;
}

function buildSegments(grid: Uint8Array): Segment[] {
  const segments: Segment[] = [];

  for (let ty = 0; ty < MAP_ROWS; ty++) {
    for (let tx = 0; tx < MAP_COLS; tx++) {
      if (!wallAt(grid, tx, ty)) continue;
      const left = tx * TILE;
      const top = ty * TILE;
      const right = left + TILE;
      const bottom = top + TILE;

      // Only emit faces that border open space; interior faces are wasted rays.
      if (!wallAt(grid, tx, ty - 1)) segments.push({ x1: left, y1: top, x2: right, y2: top });
      if (!wallAt(grid, tx, ty + 1)) segments.push({ x1: left, y1: bottom, x2: right, y2: bottom });
      if (!wallAt(grid, tx - 1, ty)) segments.push({ x1: left, y1: top, x2: left, y2: bottom });
      if (!wallAt(grid, tx + 1, ty)) segments.push({ x1: right, y1: top, x2: right, y2: bottom });
    }
  }

  return segments;
}

function buildProps(grid: Uint8Array): PropDefinition[] {
  const rng = mulberry32(0x1badc0de);
  const props: PropDefinition[] = [];
  let nextId = 0;

  const addProp = (tx: number, ty: number, angle: number, room: RoomSpec) => {
    if (wallAt(grid, tx, ty)) return;
    if (!room.kinds.length) return;
    const kind = room.kinds[Math.floor(rng() * room.kinds.length)] ?? "crate";
    const size = PROP_SIZE[kind];
    props.push({
      id: nextId++,
      kind,
      x: tx * TILE + TILE / 2,
      y: ty * TILE + TILE / 2,
      angle,
      width: size.width,
      height: size.height,
    });
  };

  for (const room of ROOMS) {
    // Spread props along each wall face with a small random phase offset.
    const step = 4;

    for (let tx = room.x0 + 1 + Math.floor(rng() * 2); tx < room.x1; tx += step) {
      if (wallAt(grid, tx, room.y0 - 1) && !wallAt(grid, tx, room.y0)) addProp(tx, room.y0, 0, room);
    }
    for (let tx = room.x0 + 1 + Math.floor(rng() * 2); tx < room.x1; tx += step) {
      if (wallAt(grid, tx, room.y1 + 1) && !wallAt(grid, tx, room.y1)) addProp(tx, room.y1, Math.PI, room);
    }
    for (let ty = room.y0 + 1 + Math.floor(rng() * 2); ty < room.y1; ty += step) {
      if (wallAt(grid, room.x0 - 1, ty) && !wallAt(grid, room.x0, ty)) {
        addProp(room.x0, ty, -Math.PI / 2, room);
      }
    }
    for (let ty = room.y0 + 1 + Math.floor(rng() * 2); ty < room.y1; ty += step) {
      if (wallAt(grid, room.x1 + 1, ty) && !wallAt(grid, room.x1, ty)) {
        addProp(room.x1, ty, Math.PI / 2, room);
      }
    }
  }

  return props;
}

function center(tx: number, ty: number): { x: number; y: number } {
  return { x: tx * TILE + TILE / 2, y: ty * TILE + TILE / 2 };
}

function buildMap(): MapDefinition {
  const walls = buildWalls();

  return {
    cols: MAP_COLS,
    rows: MAP_ROWS,
    tile: TILE,
    width: MAP_WIDTH,
    height: MAP_HEIGHT,
    walls,
    props: buildProps(walls),
    segments: buildSegments(walls),
    seekerSpawns: [center(3, 3), center(36, 3), center(3, 10), center(36, 10), center(10, 6)],
    hiderSpawns: [
      center(4, 16),
      center(10, 24),
      center(16, 16),
      center(24, 24),
      center(20, 20),
      center(33, 16),
      center(36, 24),
      center(29, 23),
      center(8, 19),
      center(25, 19),
    ],
  };
}

/** Deterministic singleton: identical on client and server, never transmitted. */
export const MAP: MapDefinition = buildMap();

export function propById(id: number): PropDefinition | undefined {
  return MAP.props.find((p) => p.id === id);
}
