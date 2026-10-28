/**
 * Explicit render layers for the playfield.
 *
 * Everything that lives in the world stays strictly below `fog`; nothing may
 * ever be drawn above it except the fog's own falloff glow. Actors and props
 * share one band and are offset by their y coordinate so they sort against each
 * other (a player standing below a table draws over it).
 */
export const DEPTH = {
  map: 0,
  marker: 5,
  /** Base of the y-sorted band: props and bodies both use `actor + y / 100`. */
  actor: 10,
  tracer: 40,
  fog: 1000,
  fogGlow: 1001,
} as const;

/** Interleaved paint order for anything that should occlude by depth. */
export function actorDepth(y: number): number {
  return DEPTH.actor + y / 100;
}
