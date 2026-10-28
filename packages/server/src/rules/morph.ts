import {
  MORPH_CONTACT_PAD,
  PLAYER_RADIUS,
  type MapDefinition,
  type PlayerStateInstance,
  type PropDefinition,
} from "@impropster/shared";

/**
 * Nearest morphable prop the player is *touching*.
 *
 * Morphing used to require the prop to be inside a facing cone, which meant a
 * hider had to look at the furniture and could not become the barrel behind
 * them. It is a contact rule now: any prop whose footprint your body is against
 * is fair game, whichever way you happen to face.
 */
export function findMorphTarget(
  map: MapDefinition,
  player: Pick<PlayerStateInstance, "x" | "y">,
  isPropTaken: (propId: number) => boolean,
): PropDefinition | null {
  let best: PropDefinition | null = null;
  let bestDistance = Infinity;

  for (const prop of map.props) {
    if (isPropTaken(prop.id)) continue;

    // Distance to the prop's *surface*, so a table is reachable from its edge
    // rather than only from its exact centre.
    const reach = Math.max(prop.width, prop.height) / 2 + PLAYER_RADIUS + MORPH_CONTACT_PAD;
    const distance = Math.hypot(prop.x - player.x, prop.y - player.y);
    if (distance > reach) continue;

    if (distance < bestDistance || (distance === bestDistance && best && prop.id < best.id)) {
      best = prop;
      bestDistance = distance;
    }
  }

  return best;
}
