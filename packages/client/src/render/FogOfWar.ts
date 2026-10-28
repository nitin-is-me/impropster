import Phaser from "phaser";
import {
  buildVisibilityPolygon,
  HIDER_VISION_RADIUS,
  PlayerRole,
  SEEKER_AMBIENT_RADIUS,
  SEEKER_FOV_RAD,
  SEEKER_VISION_RANGE,
  segmentsNear,
  TAU,
  type MapDefinition,
} from "@impropster/shared";
import { DEPTH } from "./depths";
import { TEX } from "./textures";

/**
 * Client-side fog of war.
 *
 * The model is: draw the world normally, then lay a black rectangle over the
 * whole map and punch the lit area out of it. The punch is an *inverted*
 * geometry mask, so the mask shape itself must never be drawn — the mask
 * Graphics is therefore built with `make.graphics(..., false)` and kept off the
 * display list. (Adding it via `add.graphics()` and masking with it paints the
 * solid white stencil on top of the hole it creates, which reads as a white
 * cone on a black screen.)
 *
 * The mask is attached to nothing but `darkness`. The camera and every world
 * container stay un-masked, so the world renders at full fidelity and only the
 * overlay is cut away.
 */
export class FogOfWar {
  private readonly map: MapDefinition;
  /** Off-screen stencil source. Never rendered — geometry only. */
  private readonly stencil: Phaser.GameObjects.Graphics;
  private readonly darkness: Phaser.GameObjects.Rectangle;
  private readonly glow: Phaser.GameObjects.Image;
  private lastDraw = 0;

  constructor(scene: Phaser.Scene, map: MapDefinition) {
    this.map = map;

    // The overlay covers the entire map in world space. A world-space overlay
    // is deliberate: the camera is scrolled *and* zoomed, and a
    // `setScrollFactor(0)` screen-sized rectangle would be scaled by the zoom,
    // leaving uncovered bands at the edges. Covering the map bounds works for
    // any zoom level because the camera is clamped to those same bounds.
    this.darkness = scene.add
      .rectangle(0, 0, map.width, map.height, 0x04060a, 1)
      .setOrigin(0, 0)
      .setDepth(DEPTH.fog);

    // `false` == do not add to the scene's display list. This is the whole fix:
    // a mask source must be geometry only, never a drawn object.
    this.stencil = scene.make.graphics({ x: 0, y: 0 }, false);

    const mask = this.stencil.createGeometryMask();
    mask.setInvertAlpha(true);
    this.darkness.setMask(mask);

    // Feathered falloff at the rim of the light: a multiply gradient darkens
    // the revealed area towards its edge so the cone does not end in a hard
    // periscope cut. It sits above the overlay and is clipped by it implicitly
    // (everything it multiplies is either lit world or the black overlay).
    this.glow = scene.add
      .image(0, 0, TEX.glow)
      .setDepth(DEPTH.fogGlow)
      .setBlendMode(Phaser.BlendModes.MULTIPLY)
      .setVisible(false);
  }

  /** Rebuilds the light polygon. Throttled to ~30 Hz — it is pure CPU work. */
  update(now: number, x: number, y: number, aim: number, role: number): void {
    if (now - this.lastDraw < 33) return;
    this.lastDraw = now;

    const isSeeker = role === PlayerRole.Seeker;
    const radius = isSeeker ? SEEKER_VISION_RANGE : HIDER_VISION_RADIUS;
    const fov = isSeeker ? SEEKER_FOV_RAD : TAU;
    const startAngle = isSeeker ? aim - fov / 2 : 0;

    const segments = segmentsNear(this.map.segments, x, y, radius * 1.2);
    const points = buildVisibilityPolygon(x, y, segments, startAngle, fov, radius);

    const g = this.stencil;
    g.clear();

    if (points.length >= 3) {
      const first = points[0];
      if (first) {
        g.fillStyle(0xffffff, 1);
        g.beginPath();
        g.moveTo(x, y);
        g.lineTo(first.x, first.y);
        for (let i = 1; i < points.length; i++) {
          const point = points[i];
          if (point) g.lineTo(point.x, point.y);
        }
        g.closePath();
        g.fillPath();
      }
    }

    // A small ambient bubble so you are never blind at your own feet.
    g.fillStyle(0xffffff, 1);
    g.fillCircle(x, y, SEEKER_AMBIENT_RADIUS * (isSeeker ? 1 : 0.8));

    this.glow
      .setVisible(true)
      .setPosition(x, y)
      .setDisplaySize(radius * 2.1, radius * 2.1);
  }

  /**
   * Kill the light without lifting the darkness — used for a seeker with their
   * eyes shut during the hide phase, who should see nothing at all.
   */
  hideLight(): void {
    this.stencil.clear();
    this.glow.setVisible(false);
  }

  /** Show or hide the whole fog system (lobby, spectating, results). */
  setEnabled(enabled: boolean): void {
    this.darkness.setVisible(enabled);
    this.glow.setVisible(enabled);
    if (!enabled) this.stencil.clear();
  }

  destroy(): void {
    this.darkness.clearMask(true);
    this.stencil.destroy();
    this.glow.destroy();
    this.darkness.destroy();
  }
}
