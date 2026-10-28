import { BOOST_MULTIPLIER, PLAYER_SPEED } from "./constants";
import { moveBody } from "./collision";
import { clamp, normalizeAngle } from "./math";
import type { MapDefinition } from "./map";

/**
 * The deterministic body the prediction step mutates. On the server this is the
 * real `PlayerState`; on the client it is the reconciler's predicted copy of the
 * local player. Keeping the shape minimal is what makes the step shareable.
 */
export interface SimBody {
  x: number;
  y: number;
  aim: number;
  speedMul: number;
}

export interface MoveCommand {
  moveX: number;
  moveY: number;
  aim: number;
}

/**
 * THE shared movement step. The server and the client's rollback replay both
 * call this exact function with the same fixed `dt`, so prediction reproduces
 * authoritative motion bit-for-bit (up to float formatting on the wire).
 */
export function applyInput(
  body: SimBody,
  command: MoveCommand,
  dt: number,
  map: MapDefinition,
): void {
  body.aim = normalizeAngle(Number.isFinite(command.aim) ? command.aim : 0);

  let moveX = clamp(Number.isFinite(command.moveX) ? command.moveX : 0, -1, 1);
  let moveY = clamp(Number.isFinite(command.moveY) ? command.moveY : 0, -1, 1);

  const length = Math.hypot(moveX, moveY);
  if (length < 0.0001) return;
  if (length > 1) {
    moveX /= length;
    moveY /= length;
  }

  const multiplier = clamp(
    Number.isFinite(body.speedMul) && body.speedMul > 0 ? body.speedMul : 1,
    1,
    BOOST_MULTIPLIER,
  );
  const speed = PLAYER_SPEED * multiplier;

  moveBody(map, body, moveX * speed * dt, moveY * speed * dt);
}

export function speedFor(multiplier: number): number {
  return PLAYER_SPEED * clamp(multiplier, 1, BOOST_MULTIPLIER);
}
