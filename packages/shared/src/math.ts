/** Small, dependency-free math helpers shared by client and server. */

export const TAU = Math.PI * 2;

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Normalise an angle into (-PI, PI]. */
export function normalizeAngle(angle: number): number {
  let a = angle % TAU;
  if (a <= -Math.PI) a += TAU;
  else if (a > Math.PI) a -= TAU;
  return a;
}

/** Signed shortest difference `b - a` in (-PI, PI]. */
export function angleDelta(a: number, b: number): number {
  return normalizeAngle(b - a);
}

export function angleBetween(ax: number, ay: number, bx: number, by: number): number {
  return Math.atan2(by - ay, bx - ax);
}

export function dist(x1: number, y1: number, x2: number, y2: number): number {
  return Math.hypot(x2 - x1, y2 - y1);
}

export function distSq(x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  return dx * dx + dy * dy;
}

/** True when `angle` lies within `halfWidth` radians of `center`. */
export function withinAngle(center: number, angle: number, halfWidth: number): boolean {
  return Math.abs(angleDelta(center, angle)) <= halfWidth;
}

/**
 * Ray / circle intersection. Returns the distance along the (normalised) ray
 * direction to the first intersection, or `null` when there is none.
 */
export function rayCircle(
  ox: number,
  oy: number,
  dx: number,
  dy: number,
  cx: number,
  cy: number,
  radius: number,
): number | null {
  const fx = ox - cx;
  const fy = oy - cy;
  const b = fx * dx + fy * dy;
  const c = fx * fx + fy * fy - radius * radius;
  if (c > 0 && b > 0) return null;
  const disc = b * b - c;
  if (disc < 0) return null;
  let t = -b - Math.sqrt(disc);
  if (t < 0) t = 0;
  return t;
}

/** Deterministic 32-bit PRNG so map generation is identical everywhere. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
