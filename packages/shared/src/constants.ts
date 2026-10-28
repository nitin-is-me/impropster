/**
 * Global tuning constants shared by the authoritative server and the client
 * predictor. Anything that influences movement, vision or combat timings lives
 * here so both sides can never drift apart.
 */

/** Authoritative simulation rate. One client input == one fixed step. */
export const TICK_RATE = 30;
export const TICK_MS = 1000 / TICK_RATE;

/** World grid. */
export const TILE = 32;
export const MAP_COLS = 40;
export const MAP_ROWS = 28;
export const MAP_WIDTH = MAP_COLS * TILE;
export const MAP_HEIGHT = MAP_ROWS * TILE;

/** Movement. */
export const PLAYER_RADIUS = 9;
export const PLAYER_SPEED = 134; // px/s
export const BOOST_MULTIPLIER = 1.5;
export const BOOST_MS = 1000;

/** Vision. */
export const HIDER_VISION_RADIUS = 268;
export const SEEKER_VISION_RANGE = 408;
export const SEEKER_FOV_DEG = 100;
export const SEEKER_FOV_RAD = (SEEKER_FOV_DEG * Math.PI) / 180;
export const SEEKER_AMBIENT_RADIUS = 62;
/** Extra tolerance (radians) granted to the *server* when validating hits, so a
 *  client that can see a target on screen can always shoot it. */
export const SERVER_CONE_EPSILON = 0.06;

/** Weapon. */
export const MAG_SIZE = 6;
export const RELOAD_MS = 2500;
export const FIRE_COOLDOWN_MS = 260;
export const MISS_LOCKOUT_MS = 2000;
export const SHOT_RANGE = 720;
export const MUZZLE_OFFSET = 14;
export const HIT_RADIUS = 13;
export const HIDER_MAX_HP = 2;

/** Match lifecycle. */
export const HIDE_PHASE_MS = 20_000;
export const HUNT_PHASE_MS = 160_000;
export const ROUND_MS = HIDE_PHASE_MS + HUNT_PHASE_MS;
export const RESULTS_MS = 9_000;
/** Grace period after the host presses Start, so everyone can ready up. */
export const START_COUNTDOWN_MS = 3_000;
/**
 * Team card shown before every leg: five seconds of "you are on this side now"
 * before the roles actually do anything.
 */
export const TEAM_REVEAL_MS = 5_000;
/** A host may start with this many humans in the lobby. */
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 10;

/**
 * A match is a number of rounds; each round is two legs, so both teams hide
 * and both teams seek exactly once per round. Only odd round counts are
 * selectable, and the match always resolves a winner (see MatchRoom).
 */
export const MIN_ROUNDS = 1;
export const MAX_ROUNDS = 9;
export const DEFAULT_ROUNDS = 3;
export const LEGS_PER_ROUND = 2;
export function isAllowedRounds(value: number): boolean {
  return (
    Number.isInteger(value) &&
    value >= MIN_ROUNDS &&
    value <= MAX_ROUNDS &&
    value % 2 === 1
  );
}

/** Matchmaking. Codes deliberately exclude I/O/0/1 to survive being read out. */
export const ROOM_CODE_LENGTH = 4;
export const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** Clues. */
export const GIGGLE_MIN_MS = 30_000;
export const GIGGLE_MAX_MS = 40_000;
export const STEP_DISTANCE = 42;
export const HEARING_RADIUS = 560;
/** Sound travelling through a wall is attenuated: effective radius multiplier. */
export const HEARING_WALL_FACTOR = 0.55;
export const THREAT_RADIUS = 320;

/** Morphing. */
/**
 * Morphing is a touch, not a look: a hider may become any furniture whose
 * footprint they are standing against, whichever way they happen to face.
 * MORPH_RANGE stays as a cheap broad-phase bound for that contact test.
 */
export const MORPH_RANGE = 78;
/** Gap allowed between the player's body and the prop's footprint. */
export const MORPH_CONTACT_PAD = 6;

/** Names. */
export const NAME_MIN = 2;
export const NAME_MAX = 14;

/** Netcode. */
export const INPUT_RATE = TICK_RATE;
export const INTERP_DELAY_MS = 100;
export const MAX_MESSAGES_PER_SECOND = 40;
export const RECONNECT_SECONDS = 20;

export const PROTOCOL_VERSION = 1;
