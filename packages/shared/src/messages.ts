import type { PropKind } from "./map";

/** Client -> server message names. */
export const ClientMessage = {
  Fire: "fire",
  Reload: "reload",
  Morph: "morph",
  ToggleLock: "lock",
  /** Host-only: begin the countdown and deal roles. */
  Start: "start",
  /** Host-only: pick the match length (odd, 1..9 rounds). */
  Rounds: "rounds",
  /** Echo of a server ping probe, used to derive the lobby ping column. */
  Pong: "pong",
} as const;

/** Server -> client message names. */
export const ServerMessage = {
  Shot: "shot",
  Footstep: "footstep",
  Giggle: "giggle",
  Shatter: "shatter",
  Eliminated: "eliminated",
  Denied: "denied",
  Phase: "phase",
  MorphResult: "morphResult",
  PingProbe: "pingProbe",
} as const;

/** Client fires; the aim angle is validated and clamped server-side. */
export interface FirePayload {
  aim: number;
}

/** Authority's answer to a shot, broadcast so everyone sees the tracer. */
export interface ShotPayload {
  /** Muzzle position. */
  x: number;
  y: number;
  aim: number;
  /** Where the bullet stopped. */
  impactX: number;
  impactY: number;
  hit: boolean;
  killed: boolean;
  /** Prop the bullet struck, when it hit scenery. */
  propKind: PropKind | null;
  /** Session id of the player that was hit, or null. */
  targetId: string | null;
}

export interface FootstepPayload {
  x: number;
  y: number;
  /** Stride index, used by clients to vary the sample. */
  step: number;
}

export interface GigglePayload {
  x: number;
  y: number;
  /** Purely for audio variation; carries no identity. */
  variant: number;
}

export interface ShatterPayload {
  propId: number;
  x: number;
  y: number;
  targetId: string;
}

export interface EliminatedPayload {
  targetId: string;
  x: number;
  y: number;
  /** Names for the kill feed; the event itself is already public. */
  killerName: string;
  victimName: string;
}

export interface PhasePayload {
  phase: number;
  round: number;
  winner: number;
}

export interface DeniedPayload {
  reason: string;
}

export interface MorphResultPayload {
  ok: boolean;
  propId: number;
}

/** Server -> client clock probe; the client echoes `t` straight back. */
export interface PingProbePayload {
  t: number;
}

