import { Server } from "colyseus";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { MatchRoom } from "./rooms/MatchRoom.js";
import { directory } from "./registry.js";

const parsedPort = Number.parseInt(process.env.PORT ?? "", 10);
const PORT = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 2567;
const HOST = process.env.HOST?.trim() || "0.0.0.0";

const transport = new WebSocketTransport({
  pingInterval: 5000,
  pingMaxRetries: 3,
});

const gameServer = new Server({ transport });

gameServer.define("match", MatchRoom);

/** Minimal structural types: the transport hands back a plain Express app. */
interface JsonResponse {
  setHeader(name: string, value: string): void;
  status(code: number): { json(body: unknown): void };
}
interface JsonRequest {
  query?: Record<string, unknown>;
}

function sendJson(res: JsonResponse, body: unknown, status = 200): void {
  // The landing page is served by Vite on another port in development, so the
  // listing endpoints have to be readable cross-origin. Nothing here is secret:
  // private rooms are never included.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");
  res.status(status).json(body);
}

try {
  const app = transport.getExpressApp();

  app.get("/health", (_req: JsonRequest, res: JsonResponse) => {
    sendJson(res, { ok: true, room: "match", rooms: directory.size, uptime: process.uptime() });
  });

  /** Open, joinable lobbies. Private rooms and running matches are excluded. */
  app.get("/rooms", (_req: JsonRequest, res: JsonResponse) => {
    sendJson(res, { rooms: directory.publicRooms() });
  });

  /** Turns a human-typed code into the room id `joinById` needs. */
  app.get("/rooms/resolve", (req: JsonRequest, res: JsonResponse) => {
    const raw = req.query?.["code"];
    const room = directory.resolve(typeof raw === "string" ? raw : "");
    if (!room) {
      sendJson(res, { error: "not-found" }, 404);
      return;
    }
    sendJson(res, {
      roomId: room.roomId,
      code: room.code,
      players: room.players,
      maxPlayers: room.maxPlayers,
    });
  });
} catch (error) {
  console.warn("[impropster] could not register HTTP routes", error);
}

await gameServer.listen(PORT, HOST);
console.log(`[impropster] authoritative server listening on ws://${HOST}:${PORT}`);

const shutdown = async (signal: string) => {
  console.log(`[impropster] ${signal} received, shutting down`);
  await gameServer.gracefullyShutdown(false);
  process.exit(0);
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
