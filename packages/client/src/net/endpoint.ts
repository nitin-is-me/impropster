import type { PhaseValue } from "@impropster/shared";

/** Matches the shape served by `GET /rooms`. */
export interface PublicRoom {
  roomId: string;
  code: string;
  hostName: string;
  players: number;
  maxPlayers: number;
  phase: PhaseValue;
  isPrivate: boolean;
  createdAt: number;
}

/**
 * Base URL of the authoritative server. One value for both HTTP (matchmaking)
 * and WebSocket (the room) — the Colyseus client upgrades the scheme itself.
 */
export function serverBase(): string {
  const configured = import.meta.env.VITE_SERVER_URL as string | undefined;
  if (configured) return configured.replace(/\/+$/, "");

  const protocol = window.location.protocol === "https:" ? "https:" : "http:";
  return `${protocol}//${window.location.hostname || "localhost"}:2567`;
}

async function getJson<T>(path: string, timeoutMs = 4000): Promise<T> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${serverBase()}${path}`, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(response.status === 404 ? "not-found" : `http-${response.status}`);
    }
    return (await response.json()) as T;
  } finally {
    window.clearTimeout(timer);
  }
}

/** Open, joinable public lobbies. Throws when the server is unreachable. */
export async function fetchPublicRooms(): Promise<PublicRoom[]> {
  const body = await getJson<{ rooms: PublicRoom[] }>("/rooms");
  return Array.isArray(body.rooms) ? body.rooms : [];
}

/** Resolves a typed room code to the room id `joinById` requires. */
export async function resolveRoomCode(code: string): Promise<string> {
  const body = await getJson<{ roomId: string }>(
    `/rooms/resolve?code=${encodeURIComponent(code)}`,
  );
  if (!body.roomId) throw new Error("not-found");
  return body.roomId;
}
