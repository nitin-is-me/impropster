import { schema, t } from "@colyseus/schema";
import { MAG_SIZE, MAX_PLAYERS, MIN_PLAYERS } from "./constants";

export const PlayerRole = {
  None: 0,
  Seeker: 1,
  Hider: 2,
} as const;
export type PlayerRoleValue = (typeof PlayerRole)[keyof typeof PlayerRole];

export const PlayerForm = {
  Human: 0,
  Prop: 1,
} as const;
export type PlayerFormValue = (typeof PlayerForm)[keyof typeof PlayerForm];

export const Phase = {
  Lobby: 0,
  Hide: 1,
  Hunt: 2,
  Results: 3,
  /** Five-second team card before a leg; nobody can move yet. */
  Teams: 4,
} as const;
export type PhaseValue = (typeof Phase)[keyof typeof Phase];

export const Winner = {
  None: 0,
  Seekers: 1,
  Hiders: 2,
} as const;
export type WinnerValue = (typeof Winner)[keyof typeof Winner];

/**
 * Wire input: one instance per fixed simulation step. Values are sanitized
 * server-side (see `defineInput`'s sanitize map) before the sim reads them.
 */
export const MoveInput = schema(
  {
    moveX: t.number().default(0),
    moveY: t.number().default(0),
    aim: t.number().default(0),
    seq: t.number().default(0),
  },
  "MoveInput",
);

export type MoveInputPayload = {
  moveX: number;
  moveY: number;
  aim: number;
  seq: number;
};

/**
 * A participant. Public fields are only received by clients that currently
 * perceive this player (StateView membership). Fields tagged with `.view(1)`
 * are *only* ever received by the player themselves — that tag is what keeps a
 * seeker from ever learning a hider's role, prop identity or ammo state, even
 * by inspecting the socket.
 */
export const PlayerState = schema(
  {
    // Every field is view-tagged on purpose. StateView filters FIELDS, not
    // entities: an untagged field is broadcast to every client no matter what.
    // Tagging all of them means a player instance that is absent from a
    // client's view serializes to nothing at all — which is what makes
    // entity-level fog of war possible.
    name: t.string().view().default(""),
    color: t.uint8().view().default(0),
    x: t.number().view().default(0),
    y: t.number().view().default(0),
    aim: t.number().view().default(0),
    speedMul: t.number().view().default(1),
    alive: t.boolean().view().default(true),
    /**
     * Human or prop. Public because the body has to be drawn as one or the
     * other; the disguise id above says *which* prop.
     */
    form: t.uint8().view().default(PlayerForm.Human),
    score: t.number().view().default(0),
    connected: t.boolean().view().default(true),
    /** 0 = Team A, 1 = Team B. Fixed for the whole match. */
    team: t.uint8().view().default(0),
    /**
     * Visible to whoever can see this player: someone already in your line of
     * sight being a seeker is not a secret.
     */
    role: t.uint8().view().default(PlayerRole.None),
    /**
     * Id of the map prop this player is currently wearing as a disguise, or -1.
     *
     * This has to travel with the entity: a hider who walks while disguised is
     * visible furniture, so the client must know which piece of decor to draw
     * on the body *and* which static copy to suppress (otherwise the player
     * would be invisible and the prop would stay behind). It carries no
     * identity — only clients that already perceive the body receive it.
     */
    disguiseId: t.number().view().default(-1),
    /**
     * Round-trip time in ms, measured by the server's own ping probe. Only
     * meaningful in the lobby, where every player is shared with everyone.
     */
    ping: t.uint16().view().default(0),

    // ---- private to the owning client -------------------------------------
    propId: t.number().view(1).default(-1),
    hp: t.uint8().view(1).default(2),
    ammo: t.uint8().view(1).default(MAG_SIZE),
    reloading: t.boolean().view(1).default(false),
    reloadMs: t.number().view(1).default(0),
    lockoutMs: t.number().view(1).default(0),
    cooldownMs: t.number().view(1).default(0),
    boostMs: t.number().view(1).default(0),
    threat: t.number().view(1).default(0),
    locked: t.boolean().view(1).default(false),
    canMorph: t.boolean().view(1).default(false),
    morphTargetId: t.number().view(1).default(-1),
    morphCdMs: t.number().view(1).default(0),
  },
  "PlayerState",
);

export const GameState = schema(
  {
    phase: t.uint8().default(Phase.Lobby),
    /** Milliseconds left in the current phase, refreshed every tick. */
    phaseMs: t.number().default(0),
    /** Current round (1-based during a match, 0 in the lobby). */
    round: t.uint8().default(0),
    /** Leg within the round: 0 = first team hides, 1 = roles swapped. */
    leg: t.uint8().default(0),
    /** Rounds the host picked; always odd, so the match resolves a winner. */
    roundsTotal: t.uint8().default(3),
    /** Which team is seeking this leg (0 = A, 1 = B). */
    seekingTeam: t.uint8().default(0),
    teamAScore: t.number().default(0),
    teamBScore: t.number().default(0),
    teamAKills: t.number().default(0),
    teamBKills: t.number().default(0),
    /** 0 = unresolved, 1 = Team A took the match, 2 = Team B. */
    matchWinner: t.uint8().default(0),
    matchOver: t.boolean().default(false),
    tick: t.number().default(0),
    /**
     * The map itself is view-tagged: each element is enrolled per client, and
     * removing an element from a client's StateView deletes it from that
     * client's copy (a plain `@type` map would leave an empty shell behind).
     */
    players: t.map(PlayerState).view(),
    /** Prop ids whose disguise has been shattered this round. */
    shattered: t.array("uint16"),
    playerCount: t.uint8().default(0),
    seekerCount: t.uint8().default(0),
    hiderCount: t.uint8().default(0),
    aliveHiders: t.uint8().default(0),
    winner: t.uint8().default(Winner.None),
    minPlayers: t.uint8().default(MIN_PLAYERS),
    maxPlayers: t.uint8().default(MAX_PLAYERS),
    /** Countdown after the host starts; 0 while waiting for the host. */
    lobbyMs: t.number().default(0),
    /** Join code for this room, e.g. "X7K9". Always public within the room. */
    roomCode: t.string().default(""),
    /** Private rooms are only reachable by code, never listed publicly. */
    isPrivate: t.boolean().default(true),
    /** Session id of the host (the player who may start the match). */
    hostId: t.string().default(""),
  },
  "GameState",
);

export type PlayerStateInstance = InstanceType<typeof PlayerState>;
export type GameStateInstance = InstanceType<typeof GameState>;
