import { TAU } from "./math";
import { isWallTile } from "./collision";
import type { MapDefinition } from "./map";
import { TILE } from "./constants";

export interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface RayHit {
  hit: boolean;
  /** Distance to the wall (== maxDist when nothing was hit). */
  dist: number;
  /** World position of the hit (or the ray end when nothing was hit). */
  x: number;
  y: number;
}

/**
 * Grid raycast using the Amanatides & Woo DDA traversal. Exact against the tile
 * grid, no sampling error, and cheap enough to run a few hundred times per tick.
 */
export function castRay(
  map: MapDefinition,
  originX: number,
  originY: number,
  dirX: number,
  dirY: number,
  maxDist: number,
): RayHit {
  const len = Math.hypot(dirX, dirY) || 1;
  const dx = dirX / len;
  const dy = dirY / len;

  let mapX = Math.floor(originX / TILE);
  let mapY = Math.floor(originY / TILE);

  if (isWallTile(map, mapX, mapY)) {
    return { hit: true, dist: 0, x: originX, y: originY };
  }

  const deltaDistX = dx === 0 ? Infinity : Math.abs(TILE / dx);
  const deltaDistY = dy === 0 ? Infinity : Math.abs(TILE / dy);

  const stepX = dx < 0 ? -1 : 1;
  const stepY = dy < 0 ? -1 : 1;

  let sideDistX =
    dx === 0
      ? Infinity
      : dx < 0
        ? (originX - mapX * TILE) / -dx
        : ((mapX + 1) * TILE - originX) / dx;
  let sideDistY =
    dy === 0
      ? Infinity
      : dy < 0
        ? (originY - mapY * TILE) / -dy
        : ((mapY + 1) * TILE - originY) / dy;

  let travelled = 0;
  // Bounded so a degenerate direction can never spin forever.
  for (let guard = 0; guard < 512; guard++) {
    if (sideDistX < sideDistY) {
      travelled = sideDistX;
      if (travelled > maxDist) break;
      sideDistX += deltaDistX;
      mapX += stepX;
    } else {
      travelled = sideDistY;
      if (travelled > maxDist) break;
      sideDistY += deltaDistY;
      mapY += stepY;
    }

    if (isWallTile(map, mapX, mapY)) {
      return {
        hit: true,
        dist: travelled,
        x: originX + dx * travelled,
        y: originY + dy * travelled,
      };
    }
  }

  return {
    hit: false,
    dist: maxDist,
    x: originX + dx * maxDist,
    y: originY + dy * maxDist,
  };
}

/** Cheap single-ray line of sight test between two world points. */
export function lineOfSight(
  map: MapDefinition,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): boolean {
  const dx = bx - ax;
  const dy = by - ay;
  const distance = Math.hypot(dx, dy);
  if (distance < 0.0001) return true;
  const hit = castRay(map, ax, ay, dx, dy, distance);
  return !hit.hit || hit.dist >= distance - 0.001;
}

/** Nearest intersection distance between a ray and a set of wall segments. */
function nearestSegmentHit(
  ox: number,
  oy: number,
  dx: number,
  dy: number,
  segments: Segment[],
  maxDist: number,
): number {
  let best = maxDist;

  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    if (!s) continue;

    const rx = s.x2 - s.x1;
    const ry = s.y2 - s.y1;
    const denom = dx * ry - dy * rx;
    if (Math.abs(denom) < 1e-9) continue;

    const qx = s.x1 - ox;
    const qy = s.y1 - oy;
    const t = (qx * ry - qy * rx) / denom;
    const u = (qx * dy - qy * dx) / denom;

    if (t >= 0 && t < best && u >= 0 && u <= 1) best = t;
  }

  return best;
}

/** Wall segments within `radius` of a point (broad-phase for the polygon). */
export function segmentsNear(
  segments: Segment[],
  x: number,
  y: number,
  radius: number,
): Segment[] {
  const out: Segment[] = [];
  const r2 = radius * radius;
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    if (!s) continue;
    // Distance from the point to the segment's bounding box.
    const nx = Math.max(s.x1 < s.x2 ? s.x1 : s.x2, Math.min(x, s.x1 < s.x2 ? s.x2 : s.x1));
    const ny = Math.max(s.y1 < s.y2 ? s.y1 : s.y2, Math.min(y, s.y1 < s.y2 ? s.y2 : s.y1));
    const dx = nx - x;
    const dy = ny - y;
    if (dx * dx + dy * dy <= r2) out.push(s);
  }
  return out;
}

/**
 * Vector visibility polygon: cast rays at every relevant corner (plus a minimum
 * angular density so curved gaps stay smooth) and stitch the hit points into a
 * fan. This is the shape the client punches into its fog layer.
 */
export function buildVisibilityPolygon(
  originX: number,
  originY: number,
  segments: Segment[],
  startAngle: number,
  fov: number,
  radius: number,
  minAngleStep = 0.035,
): Array<{ x: number; y: number }> {
  const candidates: number[] = [];
  const fullCircle = fov >= TAU - 0.0001;

  const pushAngle = (angle: number, radiusForAngle: number) => {
    const rel = fullCircle
      ? ((angle - startAngle) % TAU + TAU) % TAU
      : angle - startAngle;
    if (!fullCircle && (rel < -0.0001 || rel > fov + 0.0001)) return;
    if (radiusForAngle > radius) return;
    candidates.push(fullCircle ? startAngle + rel : angle);
  };

  const r2 = radius * radius;
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    if (!s) continue;
    for (const [px, py] of [
      [s.x1, s.y1],
      [s.x2, s.y2],
    ] as const) {
      const dx = px - originX;
      const dy = py - originY;
      const d2 = dx * dx + dy * dy;
      if (d2 > r2 && d2 > radius * radius) continue;
      const a = Math.atan2(dy, dx);
      pushAngle(a - 0.0006, Math.sqrt(d2));
      pushAngle(a + 0.0006, Math.sqrt(d2));
    }
  }

  const endAngle = startAngle + fov;
  candidates.push(startAngle, endAngle);

  // Sort inside the sweep window.
  candidates.sort((a, b) => a - b);

  // Fill sparse gaps with evenly spaced rays.
  const filled: number[] = [];
  let previous: number | null = null;
  for (let i = 0; i < candidates.length; i++) {
    const angle = candidates[i];
    if (angle === undefined) continue;
    if (previous !== null) {
      const gap = angle - previous;
      if (gap > minAngleStep) {
        const steps = Math.min(24, Math.floor(gap / minAngleStep));
        for (let s = 1; s < steps; s++) filled.push(previous + (gap * s) / steps);
      }
    }
    filled.push(angle);
    previous = angle;
  }

  const points: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < filled.length; i++) {
    const angle = filled[i];
    if (angle === undefined) continue;
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    const d = nearestSegmentHit(originX, originY, dx, dy, segments, radius);
    points.push({ x: originX + dx * d, y: originY + dy * d });
  }

  return points;
}
