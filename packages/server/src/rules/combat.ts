import {
  BOOST_MULTIPLIER,
  BOOST_MS,
  castRay,
  FIRE_COOLDOWN_MS,
  HIDER_MAX_HP,
  HIT_RADIUS,
  MAG_SIZE,
  MISS_LOCKOUT_MS,
  MUZZLE_OFFSET,
  Phase,
  PlayerForm,
  PlayerRole,
  rayCircle,
  RELOAD_MS,
  SHOT_RANGE,
  type GameStateInstance,
  type MapDefinition,
  type PropKind,
  type PlayerStateInstance,
  type ShotPayload,
} from "@impropster/shared";

export interface FireContext {
  map: MapDefinition;
  state: GameStateInstance;
  shooterId: string;
  shooter: PlayerStateInstance;
  /** Rewound (lag-compensated) position of a target. */
  seenPosition: (target: PlayerStateInstance) => { x: number; y: number };
}

export interface FireOutcome {
  accepted: boolean;
  reason?: string;
  payload?: ShotPayload;
  shatteredPropId?: number;
  eliminatedId?: string;
}

export function startReload(player: PlayerStateInstance): void {
  if (player.reloading || player.ammo >= MAG_SIZE) return;
  player.reloading = true;
  player.reloadMs = RELOAD_MS;
}

function nearestPropOnRay(
  map: MapDefinition,
  ox: number,
  oy: number,
  dx: number,
  dy: number,
  maxDist: number,
): { kind: PropKind; dist: number } | null {
  let best: { kind: PropKind; dist: number } | null = null;

  for (const prop of map.props) {
    const radius = Math.max(prop.width, prop.height) * 0.5;
    const t = rayCircle(ox, oy, dx, dy, prop.x, prop.y, radius);
    if (t === null || t <= 0 || t > maxDist) continue;
    if (!best || t < best.dist) best = { kind: prop.kind, dist: t };
  }

  return best;
}

/**
 * Authoritative shot resolution. Runs only on the server; the client never
 * learns whether a shot landed until this returns.
 */
export function resolveFire(ctx: FireContext): FireOutcome {
  const { map, state, shooter, shooterId } = ctx;

  if (state.phase !== Phase.Hunt) return { accepted: false, reason: "phase" };
  if (shooter.role !== PlayerRole.Seeker) return { accepted: false, reason: "role" };
  if (!shooter.alive) return { accepted: false, reason: "dead" };
  if (shooter.reloading) return { accepted: false, reason: "reloading" };
  if (shooter.lockoutMs > 0) return { accepted: false, reason: "locked" };
  if (shooter.cooldownMs > 0) return { accepted: false, reason: "cooldown" };

  if (shooter.ammo <= 0) {
    startReload(shooter);
    return { accepted: false, reason: "empty" };
  }

  shooter.ammo -= 1;
  shooter.cooldownMs = FIRE_COOLDOWN_MS;
  if (shooter.ammo === 0) startReload(shooter);

  const dx = Math.cos(shooter.aim);
  const dy = Math.sin(shooter.aim);
  const muzzleX = shooter.x + dx * MUZZLE_OFFSET;
  const muzzleY = shooter.y + dy * MUZZLE_OFFSET;

  const wall = castRay(map, muzzleX, muzzleY, dx, dy, SHOT_RANGE);
  let bestDistance = Math.min(wall.dist, SHOT_RANGE);
  let hitTarget: PlayerStateInstance | null = null;
  let hitTargetId: string | null = null;

  for (const [id, other] of state.players) {
    if (id === shooterId) continue;
    if (!other.alive) continue;

    const position = ctx.seenPosition(other);
    const distance = rayCircle(muzzleX, muzzleY, dx, dy, position.x, position.y, HIT_RADIUS);
    if (distance === null || distance < 0 || distance >= bestDistance) continue;

    bestDistance = distance;
    hitTarget = other;
    hitTargetId = id;
  }

  if (hitTarget && hitTargetId) {
    const impactX = muzzleX + dx * bestDistance;
    const impactY = muzzleY + dy * bestDistance;

    if (hitTarget.form === PlayerForm.Prop) {
      // First hit: the disguise breaks, the hider becomes human and gets a
      // short burst of speed to escape with.
      const propId = hitTarget.propId;
      hitTarget.form = PlayerForm.Human;
      hitTarget.propId = -1;
      hitTarget.disguiseId = -1;
      hitTarget.hp = HIDER_MAX_HP - 1;
      hitTarget.locked = false;
      hitTarget.speedMul = BOOST_MULTIPLIER;
      hitTarget.boostMs = BOOST_MS;
      if (propId >= 0 && !state.shattered.includes(propId)) state.shattered.push(propId);

      return {
        accepted: true,
        shatteredPropId: propId,
        payload: {
          x: muzzleX,
          y: muzzleY,
          aim: shooter.aim,
          impactX,
          impactY,
          hit: true,
          killed: false,
          propKind: null,
          targetId: hitTargetId,
        },
      };
    }

    // Second hit: eliminated.
    hitTarget.hp = 0;
    hitTarget.alive = false;
    hitTarget.form = PlayerForm.Human;
    hitTarget.disguiseId = -1;
    hitTarget.speedMul = 1;
    hitTarget.boostMs = 0;
    shooter.score += 1;

    return {
      accepted: true,
      eliminatedId: hitTargetId,
      payload: {
        x: muzzleX,
        y: muzzleY,
        aim: shooter.aim,
        impactX,
        impactY,
        hit: true,
        killed: true,
        propKind: null,
        targetId: hitTargetId,
      },
    };
  }

  // A miss — including shooting scenery — costs two full seconds of fire lock.
  shooter.lockoutMs = MISS_LOCKOUT_MS;

  const distanceToImpact = bestDistance;
  const prop = nearestPropOnRay(map, muzzleX, muzzleY, dx, dy, distanceToImpact);

  return {
    accepted: true,
    payload: {
      x: muzzleX,
      y: muzzleY,
      aim: shooter.aim,
      impactX: muzzleX + dx * distanceToImpact,
      impactY: muzzleY + dy * distanceToImpact,
      hit: false,
      killed: false,
      propKind: prop ? prop.kind : null,
      targetId: null,
    },
  };
}
