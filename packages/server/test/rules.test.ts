import { describe, expect, it } from "vitest";
import {
  BOOST_MULTIPLIER,
  GameState,
  HIDER_MAX_HP,
  MAG_SIZE,
  MAP,
  MISS_LOCKOUT_MS,
  MORPH_CONTACT_PAD,
  PLAYER_RADIUS,
  Phase,
  PlayerForm,
  PlayerRole,
  PlayerState,
  Winner,
} from "@impropster/shared";
import { splitTeams } from "../src/rules/round";
import { findMorphTarget } from "../src/rules/morph";
import { resolveFire } from "../src/rules/combat";
import { shouldShareState } from "../src/rules/visibility";

function makePlayer(overrides: Partial<ReturnType<typeof PlayerState.prototype.constructor>> & Record<string, unknown> = {}) {
  const player = new PlayerState();
  Object.assign(player, overrides);
  return player;
}

function makeState(): GameState {
  const state = new GameState();
  state.phase = Phase.Hunt;
  return state;
}

describe("team splitting", () => {
  it("floors the seeker count", () => {
    expect(splitTeams(2)).toEqual({ seekers: 1, hiders: 1 });
    expect(splitTeams(3)).toEqual({ seekers: 1, hiders: 2 });
    expect(splitTeams(4)).toEqual({ seekers: 2, hiders: 2 });
    expect(splitTeams(5)).toEqual({ seekers: 2, hiders: 3 });
    expect(splitTeams(9)).toEqual({ seekers: 4, hiders: 5 });
  });
});

describe("morph target selection", () => {
  /** Just outside the prop's footprint plus the player's own body. */
  const contact = (prop: (typeof MAP.props)[number]) =>
    Math.max(prop.width, prop.height) / 2 + PLAYER_RADIUS + MORPH_CONTACT_PAD;

  it("morphs into furniture the body is touching, whichever way you face", () => {
    const prop = MAP.props[0];
    if (!prop) throw new Error("map has no props");

    // Standing against the prop's edge; `aim` is deliberately absent from the
    // signature now — looking elsewhere must not matter.
    const touching = { x: prop.x - (contact(prop) - 4), y: prop.y };
    expect(findMorphTarget(MAP, touching, () => false)?.id).toBe(prop.id);
  });

  it("ignores furniture that is out of reach", () => {
    const prop = MAP.props[0];
    if (!prop) throw new Error("map has no props");

    const tooFar = { x: prop.x - (contact(prop) + 30), y: prop.y };
    expect(findMorphTarget(MAP, tooFar, () => false)?.id).not.toBe(prop.id);
  });

  it("will not reuse a prop that is already taken or shattered", () => {
    const prop = MAP.props[0];
    if (!prop) throw new Error("map has no props");
    const touching = { x: prop.x - (contact(prop) - 4), y: prop.y };

    expect(findMorphTarget(MAP, touching, (id) => id === prop.id)).toBeNull();
  });

  it("returns nothing when standing in the middle of a room", () => {
    expect(findMorphTarget(MAP, { x: 700, y: 700 }, () => false)).toBeNull();
  });
});

describe("combat", () => {
  function setup() {
    const state = makeState();
    const shooter = makePlayer({
      role: PlayerRole.Seeker,
      alive: true,
      ammo: MAG_SIZE,
      x: 700,
      y: 700,
      aim: 0,
    });
    const target = makePlayer({
      role: PlayerRole.Hider,
      alive: true,
      form: PlayerForm.Prop,
      propId: 4,
      hp: HIDER_MAX_HP,
      x: 760,
      y: 700,
    });

    state.players.set("seeker", shooter);
    state.players.set("hider", target);

    return { state, shooter, target };
  }

  const fire = (state: GameState, shooter: PlayerState) =>
    resolveFire({
      map: MAP,
      state,
      shooterId: "seeker",
      shooter,
      seenPosition: (target) => ({ x: target.x, y: target.y }),
    });

  it("shatters a disguise on the first hit", () => {
    const { state, shooter, target } = setup();
    const result = fire(state, shooter);

    expect(result.accepted).toBe(true);
    expect(result.payload?.hit).toBe(true);
    expect(result.payload?.killed).toBe(false);
    expect(result.shatteredPropId).toBe(4);
    expect(target.form).toBe(PlayerForm.Human);
    expect(target.hp).toBe(HIDER_MAX_HP - 1);
    expect(target.speedMul).toBe(BOOST_MULTIPLIER);
    expect(state.shattered.includes(4)).toBe(true);
    expect(shooter.ammo).toBe(MAG_SIZE - 1);
    expect(shooter.lockoutMs).toBe(0);
  });

  it("eliminates on the second hit", () => {
    const { state, shooter, target } = setup();
    fire(state, shooter);

    shooter.cooldownMs = 0;
    const second = fire(state, shooter);

    expect(second.payload?.killed).toBe(true);
    expect(second.eliminatedId).toBe("hider");
    expect(target.alive).toBe(false);
    expect(shooter.score).toBe(1);
  });

  it("charges a two second lockout for a miss", () => {
    const { state, shooter } = setup();
    shooter.aim = -Math.PI / 2;

    const result = fire(state, shooter);

    expect(result.accepted).toBe(true);
    expect(result.payload?.hit).toBe(false);
    expect(shooter.lockoutMs).toBe(MISS_LOCKOUT_MS);
    expect(shooter.ammo).toBe(MAG_SIZE - 1);
  });

  it("refuses to fire while locked out", () => {
    const { state, shooter } = setup();
    shooter.aim = -Math.PI / 2;
    fire(state, shooter);

    const blocked = fire(state, shooter);
    expect(blocked.accepted).toBe(false);
    expect(blocked.reason).toBe("locked");
  });

  it("cannot shoot through a wall", () => {
    const { state, shooter, target } = setup();
    shooter.x = 400;
    shooter.y = 300;
    target.x = 900;
    target.y = 300;

    const result = fire(state, shooter);
    expect(result.accepted).toBe(true);
    expect(result.payload?.hit).toBe(false);
  });

  it("will not fire outside the hunt phase", () => {
    const { state, shooter } = setup();
    state.phase = Phase.Hide;
    expect(fire(state, shooter).accepted).toBe(false);
  });

  it("will not fire without ammo", () => {
    const { state, shooter } = setup();
    shooter.ammo = 0;
    const result = fire(state, shooter);
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe("empty");
    expect(shooter.reloading).toBe(true);
  });
});

describe("state filtering", () => {
  const seeker = makePlayer({ role: PlayerRole.Seeker, x: 700, y: 700, aim: 0, alive: true });
  const hider = makePlayer({ role: PlayerRole.Hider, x: 780, y: 700, aim: 0, alive: true });

  it("blinds seekers during the hide phase", () => {
    expect(shouldShareState(MAP, Phase.Hide, seeker, "s", hider, "h")).toBe(false);
  });

  it("shares visible players during the hunt", () => {
    expect(shouldShareState(MAP, Phase.Hunt, seeker, "s", hider, "h")).toBe(true);
  });

  it("hides players outside the cone, disguised or not", () => {
    const disguised = makePlayer({
      role: PlayerRole.Hider,
      form: PlayerForm.Prop,
      propId: 1,
      x: 800,
      y: 700,
      alive: true,
    });
    const lookingAway = makePlayer({ role: PlayerRole.Seeker, x: 700, y: 700, aim: Math.PI, alive: true });
    expect(shouldShareState(MAP, Phase.Hunt, lookingAway, "s", hider, "h")).toBe(false);
    expect(shouldShareState(MAP, Phase.Hunt, lookingAway, "s", disguised, "h")).toBe(false);
  });

  // A disguise travels with its owner: without the entity the client cannot
  // draw the furniture over the body, and a hider who walks while disguised
  // would be an invisible player.
  it("shares a disguised hider inside the cone", () => {
    const disguised = makePlayer({
      role: PlayerRole.Hider,
      form: PlayerForm.Prop,
      propId: 1,
      x: 705,
      y: 700,
      alive: true,
    });
    expect(shouldShareState(MAP, Phase.Hunt, seeker, "s", disguised, "h")).toBe(true);
  });

  it("keeps disguised hiders hidden from blinded seekers", () => {
    const disguised = makePlayer({
      role: PlayerRole.Hider,
      form: PlayerForm.Prop,
      propId: 1,
      x: 705,
      y: 700,
      alive: true,
    });
    expect(shouldShareState(MAP, Phase.Hide, seeker, "s", disguised, "h")).toBe(false);
  });

  it("hides players behind walls", () => {
    const behindWall = makePlayer({ role: PlayerRole.Hider, x: 900, y: 300, alive: true });
    const elsewhere = makePlayer({ role: PlayerRole.Seeker, x: 400, y: 300, aim: 0, alive: true });
    expect(shouldShareState(MAP, Phase.Hunt, elsewhere, "s", behindWall, "h")).toBe(false);
  });

  it("reveals everyone in the lobby and results", () => {
    const far = makePlayer({ role: PlayerRole.Hider, x: 100, y: 100, alive: true });
    expect(shouldShareState(MAP, Phase.Lobby, seeker, "s", far, "h")).toBe(true);
    expect(shouldShareState(MAP, Phase.Results, seeker, "s", far, "h")).toBe(true);
  });

  it("always shares your own state", () => {
    expect(shouldShareState(MAP, Phase.Hunt, seeker, "s", seeker, "s")).toBe(true);
  });
});
