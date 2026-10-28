/**
 * HUD geometry.
 *
 * The minimap used to float over the playfield, which meant the bottom-left of
 * the map — exactly where a hider tends to crouch — was permanently covered.
 * It now lives in a reserved bar under the game viewport, so nothing in the
 * world is ever hidden behind the HUD.
 */

const MIN_BAR = 124;
const MAX_BAR = 168;
const RATIO = 0.18;

export function hudBarHeight(screenHeight: number): number {
  return Math.round(Math.min(MAX_BAR, Math.max(MIN_BAR, screenHeight * RATIO)));
}
