import { PLAYER_RADIUS, TILE } from "./constants";
import type { MapDefinition } from "./map";

/** Axis-aligned body used by movement. `x`/`y` are the body centre. */
export interface Body {
  x: number;
  y: number;
}

export interface Vec2 {
  x: number;
  y: number;
}

export function isWallTile(map: MapDefinition, tx: number, ty: number): boolean {
  if (tx < 0 || ty < 0 || tx >= map.cols || ty >= map.rows) return true;
  return map.walls[ty * map.cols + tx] === 1;
}

/** True when the player-sized AABB centred at (x, y) overlaps any wall tile. */
export function bodyCollides(map: MapDefinition, x: number, y: number, half: number = PLAYER_RADIUS): boolean {
  const minTx = Math.floor((x - half) / TILE);
  const maxTx = Math.floor((x + half) / TILE);
  const minTy = Math.floor((y - half) / TILE);
  const maxTy = Math.floor((y + half) / TILE);

  for (let ty = minTy; ty <= maxTy; ty++) {
    for (let tx = minTx; tx <= maxTx; tx++) {
      if (isWallTile(map, tx, ty)) return true;
    }
  }
  return false;
}

/**
 * Move one axis with swept clamping against the tile grid. Moving per-axis (X
 * then Y) is what lets players slide along walls instead of sticking to them.
 */
function moveAxis(map: MapDefinition, body: Body, delta: number, axis: "x" | "y", half: number): void {
  if (delta === 0) return;

  const startX = body.x;
  const startY = body.y;
  body[axis] += delta;

  if (!bodyCollides(map, body.x, body.y, half)) return;

  if (axis === "x") {
    body.x =
      delta > 0
        ? Math.floor((body.x + half) / TILE) * TILE - half - 0.001
        : Math.ceil((body.x - half) / TILE) * TILE + half + 0.001;
  } else {
    body.y =
      delta > 0
        ? Math.floor((body.y + half) / TILE) * TILE - half - 0.001
        : Math.ceil((body.y - half) / TILE) * TILE + half + 0.001;
  }

  if (bodyCollides(map, body.x, body.y, half)) {
    body.x = startX;
    body.y = startY;
  }
}

/** Resolve a movement delta against the map, mutating `body` in place. */
export function moveBody(
  map: MapDefinition,
  body: Body,
  dx: number,
  dy: number,
  half: number = PLAYER_RADIUS,
): void {
  moveAxis(map, body, dx, "x", half);
  moveAxis(map, body, dy, "y", half);
}

export function tileCenter(tx: number, ty: number): Vec2 {
  return { x: tx * TILE + TILE / 2, y: ty * TILE + TILE / 2 };
}
