import { describe, expect, it } from "vitest";
import { bodyCollides, moveBody } from "../src/collision";
import { MAP } from "../src/map";
import { applyInput, type SimBody } from "../src/sim";
import { castRay, buildVisibilityPolygon, lineOfSight, segmentsNear } from "../src/raycast";
import { HIDER_VISION_RADIUS, PLAYER_SPEED, TILE } from "../src/constants";
import { TAU } from "../src/math";

const openSpot = { x: 700, y: 700 };

describe("map", () => {
  it("is deterministic and fully populated", () => {
    expect(MAP.cols).toBe(40);
    expect(MAP.rows).toBe(28);
    expect(MAP.props.length).toBeGreaterThan(30);
    expect(MAP.segments.length).toBeGreaterThan(50);
    expect(MAP.seekerSpawns.length).toBeGreaterThan(0);
    expect(MAP.hiderSpawns.length).toBeGreaterThan(0);
  });

  it("keeps spawns out of walls", () => {
    for (const spawn of [...MAP.seekerSpawns, ...MAP.hiderSpawns]) {
      expect(bodyCollides(MAP, spawn.x, spawn.y, 9)).toBe(false);
    }
  });

  it("places every prop on a walkable tile", () => {
    for (const prop of MAP.props) {
      expect(bodyCollides(MAP, prop.x, prop.y, 4)).toBe(false);
    }
  });
});

describe("collision", () => {
  it("blocks movement into a wall", () => {
    const body = { x: 1.5 * TILE, y: 2.5 * TILE };
    // The outer border is a wall, so pushing west must stop at the boundary.
    moveBody(MAP, body, -400, 0, 9);
    expect(body.x).toBeGreaterThan(TILE);
  });

  it("lets a body slide along a wall instead of sticking", () => {
    const body = { x: 1.5 * TILE, y: 2.5 * TILE };
    const startY = body.y;
    moveBody(MAP, body, -400, 0, 9);
    const blockedX = body.x;
    moveBody(MAP, body, 0, 40, 9);
    expect(body.x).toBeCloseTo(blockedX, 2);
    expect(body.y).toBeGreaterThan(startY);
  });
});

describe("applyInput", () => {
  const body = (overrides: Partial<SimBody> = {}): SimBody => ({
    x: openSpot.x,
    y: openSpot.y,
    aim: 0,
    speedMul: 1,
    ...overrides,
  });

  it("normalises diagonal input so it is not faster", () => {
    const straight = body();
    const diagonal = body();

    for (let i = 0; i < 10; i++) {
      applyInput(straight, { moveX: 1, moveY: 0, aim: 0 }, 1 / 30, MAP);
      applyInput(diagonal, { moveX: 1, moveY: 1, aim: 0 }, 1 / 30, MAP);
    }

    const straightDistance = Math.hypot(straight.x - openSpot.x, straight.y - openSpot.y);
    const diagonalDistance = Math.hypot(diagonal.x - openSpot.x, diagonal.y - openSpot.y);

    expect(diagonalDistance).toBeCloseTo(straightDistance, 0);
    expect(straightDistance).toBeCloseTo((PLAYER_SPEED * 10) / 30, 0);
  });

  it("applies the speed boost multiplier", () => {
    const normal = body();
    const boosted = body({ speedMul: 1.5 });

    applyInput(normal, { moveX: 1, moveY: 0, aim: 0 }, 1 / 30, MAP);
    applyInput(boosted, { moveX: 1, moveY: 0, aim: 0 }, 1 / 30, MAP);

    const normalDelta = normal.x - openSpot.x;
    const boostedDelta = boosted.x - openSpot.x;
    expect(boostedDelta / normalDelta).toBeCloseTo(1.5, 1);
  });

  it("sanitises a non-finite command", () => {
    const target = body();
    applyInput(target, { moveX: Number.NaN, moveY: Infinity, aim: Number.NaN }, 1 / 30, MAP);
    expect(Number.isFinite(target.x)).toBe(true);
    expect(Number.isFinite(target.y)).toBe(true);
    expect(Number.isFinite(target.aim)).toBe(true);
  });
});

describe("raycasting", () => {
  it("hits the outer wall and reports a sane distance", () => {
    const hit = castRay(MAP, 700, 700, 1, 0, 3000);
    expect(hit.hit).toBe(true);
    expect(hit.dist).toBeGreaterThan(0);
    expect(hit.dist).toBeLessThan(3000);
  });

  it("sees through open space but not through walls", () => {
    expect(lineOfSight(MAP, 700, 700, 760, 700)).toBe(true);
    // Straight across the western divider wall.
    expect(lineOfSight(MAP, 400, 300, 900, 300)).toBe(false);
  });

  it("builds a visibility polygon clipped by geometry", () => {
    const segments = segmentsNear(MAP.segments, 700, 700, HIDER_VISION_RADIUS * 1.2);
    const points = buildVisibilityPolygon(700, 700, segments, 0, TAU, HIDER_VISION_RADIUS);

    expect(points.length).toBeGreaterThan(20);
    for (const point of points) {
      expect(Math.hypot(point.x - 700, point.y - 700)).toBeLessThanOrEqual(HIDER_VISION_RADIUS + 0.5);
    }
  });

  it("restricts the polygon to the seeker cone", () => {
    const aim = 0;
    const fov = Math.PI / 2;
    const segments = segmentsNear(MAP.segments, 700, 700, 420);
    const points = buildVisibilityPolygon(700, 700, segments, aim - fov / 2, fov, 400);

    for (const point of points) {
      const angle = Math.atan2(point.y - 700, point.x - 700);
      const delta = Math.atan2(Math.sin(angle - aim), Math.cos(angle - aim));
      expect(Math.abs(delta)).toBeLessThanOrEqual(fov / 2 + 0.02);
    }
  });
});
