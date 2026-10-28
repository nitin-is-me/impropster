import {
  HIDER_VISION_RADIUS,
  SEEKER_AMBIENT_RADIUS,
  SEEKER_FOV_RAD,
  SEEKER_VISION_RANGE,
} from "./constants";
import { angleBetween, angleDelta, distSq } from "./math";
import { lineOfSight } from "./raycast";
import type { MapDefinition } from "./map";

export interface VisionSource {
  x: number;
  y: number;
  aim: number;
}

export interface VisionProfile {
  radius: number;
  /** Half-angle of the cone. `null` == 360 degree vision. */
  halfFov: number | null;
  ambientRadius: number;
}

export const SEEKER_VISION: VisionProfile = {
  radius: SEEKER_VISION_RANGE,
  halfFov: SEEKER_FOV_RAD / 2,
  ambientRadius: SEEKER_AMBIENT_RADIUS,
};

export const HIDER_VISION: VisionProfile = {
  radius: HIDER_VISION_RADIUS,
  halfFov: null,
  ambientRadius: HIDER_VISION_RADIUS * 0.35,
};

/**
 * Authoritative perception test. Used by the server for shot validation, for
 * per-client state filtering and for the hider threat meter.
 */
export function canPerceive(
  map: MapDefinition,
  observer: VisionSource,
  profile: VisionProfile,
  target: { x: number; y: number },
): boolean {
  const d2 = distSq(observer.x, observer.y, target.x, target.y);

  if (d2 <= profile.ambientRadius * profile.ambientRadius) {
    return lineOfSight(map, observer.x, observer.y, target.x, target.y);
  }

  if (d2 > profile.radius * profile.radius) return false;

  if (profile.halfFov !== null) {
    const toTarget = angleBetween(observer.x, observer.y, target.x, target.y);
    if (Math.abs(angleDelta(observer.aim, toTarget)) > profile.halfFov) return false;
  }

  return lineOfSight(map, observer.x, observer.y, target.x, target.y);
}

/** Convenience wrapper with the seeker cone rules applied. */
export function seekerCanSee(
  map: MapDefinition,
  seeker: VisionSource,
  target: { x: number; y: number },
): boolean {
  return canPerceive(map, seeker, SEEKER_VISION, target);
}

export function hiderCanSee(
  map: MapDefinition,
  hider: VisionSource,
  target: { x: number; y: number },
): boolean {
  return canPerceive(map, hider, HIDER_VISION, target);
}
