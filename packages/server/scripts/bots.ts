/**
 * Headless players for local playtesting, so one browser tab can fill a lobby.
 *
 * They are *not* automatic: a run requires an explicit room code and they never
 * create a room, never start a match, and never pick a room off a list.
 *
 *   ROOM_CODE=X7K9 BOT_COUNT=2 pnpm --filter @impropster/server exec tsx scripts/bots.ts
 */
import { Client, type Room } from "@colyseus/sdk";

const ENDPOINT = process.env.SMOKE_URL ?? "http://localhost:2567";
const CODE = (process.env.ROOM_CODE ?? "").trim().toUpperCase();
const COUNT = Number(process.env.BOT_COUNT ?? 2);

if (!/^[A-Z0-9]{4,8}$/.test(CODE)) {
  console.error(
    "Refusing to start: set ROOM_CODE to the lobby you want to fill, e.g.\n" +
      "  ROOM_CODE=X7K9 BOT_COUNT=2 pnpm --filter @impropster/server exec tsx scripts/bots.ts",
  );
  process.exit(1);
}

interface Bot {
  room: Room<any, any>;
  input: { data: Record<string, number>; send: () => void };
  moveX: number;
  moveY: number;
  aim: number;
}

const resolved = (await fetch(`${ENDPOINT}/rooms/resolve?code=${CODE}`)
  .then((response) => (response.ok ? response.json() : null))
  .catch(() => null)) as { roomId: string } | null;

if (!resolved?.roomId) {
  console.error(`No open room with code ${CODE}.`);
  process.exit(1);
}

const client = new Client(ENDPOINT);
const bots: Bot[] = [];
// Names are unique game-wide, so two bot processes must not collide.
const tag = Math.random().toString(36).slice(2, 4).toUpperCase();

for (let i = 0; i < COUNT; i++) {
  const room = (await client.joinById(resolved.roomId, {
    name: `Bot ${i + 1} ${tag}`,
    code: CODE,
  })) as Room<any, any>;

  const input = (room as unknown as {
    input: () => { data: Record<string, number>; send: () => void };
  }).input();

  // Answer the lobby clock probe so the roster shows a real ping for bots.
  room.onMessage("pingProbe", (payload: { t?: number }) => {
    if (typeof payload?.t === "number") room.send("pong", { t: payload.t });
  });

  room.onMessage("phase", (payload: { phase: number }) => {
    if ((payload.phase === 1 || payload.phase === 2) && Math.random() < 0.7) {
      setTimeout(() => room.send("morph"), 900);
    }
  });

  bots.push({ room, input, moveX: 0, moveY: 0, aim: 0 });
  console.log(`joined ${CODE} as ${room.sessionId}`);
}

let tick = 0;
setInterval(() => {
  tick += 1;

  for (let i = 0; i < bots.length; i++) {
    const bot = bots[i];
    if (!bot) continue;
    const state = bot.room.state as any;
    const self = state?.players?.get(bot.room.sessionId);
    if (!self) continue;

    if (tick % 45 === 0) {
      bot.moveX = Math.random() < 0.35 ? 0 : Math.random() < 0.5 ? 1 : -1;
      bot.moveY = Math.random() < 0.35 ? 0 : Math.random() < 0.5 ? 1 : -1;
      bot.aim = Math.random() * Math.PI * 2;
    }

    bot.input.data.moveX = bot.moveX;
    bot.input.data.moveY = bot.moveY;
    bot.input.data.aim = bot.aim;
    bot.input.data.seq = tick;
    bot.input.send();

    if (self.role === 1 && state.phase === 2 && tick % 30 === i) {
      bot.room.send("fire", { aim: bot.aim });
    }
  }
}, 33);

process.on("SIGINT", () => process.exit(0));
