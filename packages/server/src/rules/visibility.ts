import {
  canPerceive,
  HIDER_VISION,
  Phase,
  PlayerRole,
  SEEKER_VISION,
  type MapDefinition,
  type PlayerStateInstance,
} from "@impropster/shared";

/** Seeker and hider have very different eyes; pick the right profile. */
export function visionProfileFor(role: number) {
  return role === PlayerRole.Seeker ? SEEKER_VISION : HIDER_VISION;
}

/**
 * Should `observer` currently receive the state of `target`?
 *
 * Rules:
 *  - you always receive yourself;
 *  - lobby / results reveal everyone so the scoreboard is real;
 *  - a disguised hider IS transmitted to whoever perceives it, carrying only
 *    `form` + `disguiseId` and its position. It has to be: a prop that walks
 *    must walk on every screen, otherwise a disguised hider who moves would be
 *    an invisible player. The client draws the prop on the body and hides the
 *    static decor copy, so the two are pixel-identical;
 *  - dead players and the blinded hide phase reveal nothing;
 *  - otherwise, authoritative perception (cone + line of sight) decides.
 */
export function shouldShareState(
  map: MapDefinition,
  phase: number,
  observer: PlayerStateInstance,
  observerId: string,
  target: PlayerStateInstance,
  targetId: string,
): boolean {
  if (observerId === targetId) return true;
  if (phase === Phase.Lobby || phase === Phase.Results || phase === Phase.Teams) return true;
  if (!observer.alive) return true; // spectators watch the round out
  if (!target.alive) return false;
  if (target.connected === false) return false;
  if (phase === Phase.Hide && observer.role === PlayerRole.Seeker) return false;

  return canPerceive(
    map,
    { x: observer.x, y: observer.y, aim: observer.aim },
    visionProfileFor(observer.role),
    { x: target.x, y: target.y },
  );
}
