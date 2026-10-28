import { describe, expect, it } from "vitest";
import { MAP } from "../src/map";
import { hiderCanSee, seekerCanSee } from "../src/vision";
import { SEEKER_FOV_RAD } from "../src/constants";

describe("perception", () => {
  it("a hider sees in every direction within their radius", () => {
    const hider = { x: 700, y: 700, aim: 0 };
    expect(hiderCanSee(MAP, hider, { x: 640, y: 700 })).toBe(true);
    expect(hiderCanSee(MAP, hider, { x: 760, y: 700 })).toBe(true);
    expect(hiderCanSee(MAP, hider, { x: 700, y: 640 })).toBe(true);
    // 320px away, beyond the 268px hider radius.
    expect(hiderCanSee(MAP, hider, { x: 700, y: 380 })).toBe(false);
  });

  it("a seeker's cone is directional", () => {
    const seeker = { x: 700, y: 700, aim: 0 };
    expect(seekerCanSee(MAP, seeker, { x: 780, y: 700 })).toBe(true);

    const behind = { x: 620, y: 700 };
    expect(seekerCanSee(MAP, seeker, behind)).toBe(false);

    const edge = {
      x: 700 + Math.cos(SEEKER_FOV_RAD / 2 - 0.02) * 120,
      y: 700 + Math.sin(SEEKER_FOV_RAD / 2 - 0.02) * 120,
    };
    expect(seekerCanSee(MAP, seeker, edge)).toBe(true);
  });

  it("walls block perception even inside the cone", () => {
    const seeker = { x: 400, y: 300, aim: 0 };
    // Library side of the divider wall (col 20), well inside the cone.
    expect(seekerCanSee(MAP, seeker, { x: 800, y: 300 })).toBe(false);
  });
});
