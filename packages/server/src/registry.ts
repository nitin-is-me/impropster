import { Phase, ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from "@impropster/shared";

/** Everything the landing page needs to know about a room. */
export interface RoomSummary {
  roomId: string;
  code: string;
  hostName: string;
  players: number;
  maxPlayers: number;
  phase: number;
  isPrivate: boolean;
  createdAt: number;
  updatedAt: number;
}

/** Absolute backstop for a room that never disposed. */
const STALE_MS = 6 * 60 * 60 * 1000;
/**
 * Liveness window. Live rooms refresh their summary every second, so anything
 * that has not been touched for 30 s is gone — listing it would offer players a
 * room they cannot join.
 */
const LIVENESS_MS = 30_000;

/**
 * In-process directory of live rooms.
 *
 * Colyseus' matchmaker can *create* and *join by id*, but it has no notion of a
 * human-readable room code and no "list the open lobbies" query. Both are a few
 * lines of bookkeeping on top, and keeping it here (rather than scraping the
 * matchmaker) means the code index is authoritative and collision-checked.
 */
class RoomDirectory {
  private readonly byRoomId = new Map<string, RoomSummary>();
  private readonly byCode = new Map<string, string>();

  /** Random 4-character code, unique among live rooms. */
  allocateCode(): string {
    for (let attempt = 0; attempt < 500; attempt++) {
      let code = "";
      for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
        code += ROOM_CODE_ALPHABET.charAt(
          Math.floor(Math.random() * ROOM_CODE_ALPHABET.length),
        );
      }
      if (!this.byCode.has(code)) return code;
    }

    // Astronomically unlikely, but never hand back a duplicate: widen instead.
    for (let attempt = 0; attempt < 5000; attempt++) {
      let code = "";
      for (let i = 0; i < ROOM_CODE_LENGTH + 2; i++) {
        code += ROOM_CODE_ALPHABET.charAt(
          Math.floor(Math.random() * ROOM_CODE_ALPHABET.length),
        );
      }
      if (!this.byCode.has(code)) return code;
    }

    throw new Error("room-code space exhausted");
  }

  register(summary: Omit<RoomSummary, "updatedAt">): void {
    const entry = { ...summary, updatedAt: Date.now() };
    this.byRoomId.set(entry.roomId, entry);
    this.byCode.set(entry.code, entry.roomId);
  }

  unregister(roomId: string): void {
    const entry = this.byRoomId.get(roomId);
    if (!entry) return;
    this.byRoomId.delete(roomId);
    this.byCode.delete(entry.code);
  }

  /** Cheap field updates, called a few times a second per room. */
  update(roomId: string, patch: Partial<Pick<RoomSummary, "players" | "phase" | "hostName">>): void {
    const entry = this.byRoomId.get(roomId);
    if (!entry) return;
    entry.updatedAt = Date.now();
    if (patch.players !== undefined) entry.players = patch.players;
    if (patch.phase !== undefined) entry.phase = patch.phase;
    if (patch.hostName !== undefined) entry.hostName = patch.hostName;
  }

  /** Codes are case-insensitive and forgiving about stray whitespace. */
  resolve(rawCode: string): RoomSummary | undefined {
    this.prune();
    const code = normalizeCode(rawCode);
    if (!code) return undefined;
    const roomId = this.byCode.get(code);
    return roomId ? this.byRoomId.get(roomId) : undefined;
  }

  /** Only public rooms still in their lobby are worth listing. */
  publicRooms(): RoomSummary[] {
    this.prune();
    return [...this.byRoomId.values()]
      .filter((room) => !room.isPrivate && room.phase === Phase.Lobby)
      .sort((a, b) => b.players - a.players || a.createdAt - b.createdAt);
  }

  get size(): number {
    return this.byRoomId.size;
  }

  private prune(): void {
    const now = Date.now();
    for (const room of [...this.byRoomId.values()]) {
      if (room.createdAt < now - STALE_MS) this.unregister(room.roomId);
      else if (room.updatedAt < now - LIVENESS_MS) this.unregister(room.roomId);
    }
  }
}

export function normalizeCode(rawCode: string): string {
  return rawCode.trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
}

export const directory = new RoomDirectory();

/**
 * Game-wide display names.
 *
 * Names are the only identity a player has, so two people called "Kai" in one
 * match would make the kill feed, the roster and team cards useless. The claim
 * is held for as long as the player is seated in any room and released the
 * moment they are gone, so a name is never permanently taken by someone who
 * left.
 */
class NameRegistry {
  /** lowercase name -> opaque owner key */
  private readonly owners = new Map<string, string>();

  static keyOf(name: string): string {
    return name.trim().replace(/\s+/g, " ").toLocaleLowerCase();
  }

  isTaken(name: string): boolean {
    const key = NameRegistry.keyOf(name);
    return this.owners.has(key) && this.owners.get(key) !== undefined;
  }

  /**
   * Claims `name` for `owner`. Returns false when somebody else already holds
   * it. Re-joining under the same owner key (reconnect, same seat) is fine.
   */
  claim(name: string, owner: string): boolean {
    const key = NameRegistry.keyOf(name);
    const current = this.owners.get(key);
    if (current !== undefined && current !== owner) return false;
    this.owners.set(key, owner);
    return true;
  }

  /** Frees every name held by `owner`; safe to call more than once. */
  release(owner: string): void {
    for (const [key, holder] of this.owners) {
      if (holder === owner) this.owners.delete(key);
    }
  }

  get size(): number {
    return this.owners.size;
  }
}

export const names = new NameRegistry();
