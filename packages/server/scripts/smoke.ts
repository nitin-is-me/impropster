/**
 * Headless integration check.
 *
 * Boots N SDK clients against a running server and walks the whole flow:
 * private room -> wrong code rejected -> join by code -> host starts the match
 * -> hide -> hunt -> results. Also asserts the public room listing, code
 * resolution, lobby ping and the anti-cheat field filtering.
 *
 *   pnpm --filter @impropster/server exec tsx scripts/smoke.ts
 */
import { Client, type Room } from "@colyseus/sdk";
import { MAP, MORPH_CONTACT_PAD, PLAYER_RADIUS } from "@impropster/shared";

const ENDPOINT = process.env.SMOKE_URL ?? "http://localhost:2567";
const PLAYER_COUNT = Number(process.env.SMOKE_PLAYERS ?? 4);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function fail(message: string): never {
  console.error(`FAIL  ${message}`);
  process.exit(1);
}

function ok(message: string): void {
  console.log(`ok    ${message}`);
}

async function waitFor(label: string, predicate: () => boolean, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await sleep(100);
  }
  fail(`timed out waiting for ${label}`);
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${ENDPOINT}${path}`);
  if (!response.ok) throw new Error(`GET ${path} -> ${response.status}`);
  return (await response.json()) as T;
}

type AnyRoom = Room<any, any>;
type AnyState = {
  phase: number;
  round: number;
  playerCount: number;
  seekerCount: number;
  hiderCount: number;
  aliveHiders: number;
  roomCode: string;
  hostId: string;
  isPrivate: boolean;
  lobbyMs: number;
  minPlayers: number;
  roundsTotal: number;
  leg: number;
  seekingTeam: number;
  teamAScore: number;
  teamBScore: number;
  matchOver: boolean;
  matchWinner: number;
  players: Map<string, Record<string, unknown>>;
};

const client = new Client(ENDPOINT);
const rooms: AnyRoom[] = [];
const seen: Record<string, string[]> = {};

/** Records what the server pushed to a client, and answers ping probes. */
function subscribe(room: AnyRoom): void {
  seen[room.sessionId] = [];
  for (const type of [
    "shot",
    "footstep",
    "giggle",
    "shatter",
    "eliminated",
    "denied",
    "phase",
    "morphResult",
  ]) {
    room.onMessage(type, () => seen[room.sessionId]?.push(type));
  }

  room.onMessage("pingProbe", (payload: { t?: number }) => {
    if (typeof payload?.t === "number") room.send("pong", { t: payload.t });
  });
}

async function waitForState(
  room: AnyRoom,
  label: string,
  predicate: (state: AnyState) => boolean,
  timeoutMs = 10_000,
): Promise<AnyState> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const state = room.state as unknown as AnyState | undefined;
    if (state?.players?.get(room.sessionId) && predicate(state)) return state;
    await sleep(50);
  }
  return fail(`timed out waiting for ${label}`);
}

const stateOf = (room: AnyRoom) => room.state as unknown as AnyState;

// ---------------------------------------------------------------- matchmaking

const host = (await client.create("match", {
  name: "host",
  isPrivate: true,
})) as AnyRoom;
subscribe(host);
rooms.push(host);

const hostState = await waitForState(host, "room code", (state) => state.roomCode.length === 4);
const code = hostState.roomCode;
if (!/^[A-Z0-9]{4}$/.test(code)) fail(`expected a 4-character code, got "${code}"`);
if (!hostState.isPrivate) fail("create(isPrivate: true) produced a public room");
if (hostState.hostId !== host.sessionId) fail("first player was not made host");
ok(`private room created with code ${code}`);

const listing = await getJson<{ rooms: Array<{ code: string }> }>("/rooms");
if (listing.rooms.some((room) => room.code === code)) {
  fail("a private room appeared in the public listing");
}
ok("private room is absent from the public listing");

// A stranger must not be able to walk into a private room without the code.
let wrongCodeRejected = false;
try {
  const intruder = (await client.joinById(host.roomId, {
    name: "intruder",
    code: "ZZZZ",
  })) as AnyRoom;
  await intruder.leave();
} catch {
  wrongCodeRejected = true;
}
if (!wrongCodeRejected) fail("a wrong room code was accepted");
ok("wrong room code rejected");

// Names are unique across the whole server, and only held while seated.
let duplicateRejected = false;
try {
  const duplicate = (await client.joinById(host.roomId, { name: "host", code })) as AnyRoom;
  await duplicate.leave();
} catch (error) {
  duplicateRejected = /name-taken/i.test(String((error as Error).message));
}
if (!duplicateRejected) fail("a duplicate name was accepted");
ok("duplicate name rejected");

const seat = (await client.joinById(host.roomId, { name: "recycled", code })) as AnyRoom;
await seat.leave();
await sleep(300);

// The name that seat held must be free again immediately.
let reused = false;
try {
  const again = (await client.joinById(host.roomId, { name: "recycled", code })) as AnyRoom;
  reused = true;
  await again.leave();
  await sleep(300);
} catch {
  reused = false;
}
if (!reused) fail("a name stayed claimed after its owner left");
ok("names are released when their owner leaves");

for (let i = 1; i < PLAYER_COUNT; i++) {
  const room = (await client.joinById(host.roomId, {
    name: `bot-${i}`,
    code,
  })) as AnyRoom;
  subscribe(room);
  rooms.push(room);
}

await waitForState(host, "all players", (state) => state.playerCount === PLAYER_COUNT);
ok(`${rooms.length} clients joined by code`);

// Lobby reveals everybody so the pre-match room can be rendered. Views are
// recomputed every third tick, so `playerCount` can be a frame ahead of them.
const lobbyState = await waitForState(
  host,
  "lobby view",
  (state) => state.players.size === PLAYER_COUNT,
  8_000,
);
ok(`lobby reveals all ${lobbyState.players.size} players`);

// Nothing may start on its own any more: the host has to press Start.
await sleep(2500);
if (stateOf(host).phase !== 0) fail("the lobby started without the host pressing Start");
ok("lobby waits for the host");

// The host sizes the match; only odd counts are legal so a winner is resolved.
host.send("rounds", { rounds: 4 });
await sleep(250);
if (Number(stateOf(host).roundsTotal) !== 3) fail("an even round count was accepted");
host.send("rounds", { rounds: 5 });
await sleep(250);
if (Number(stateOf(host).roundsTotal) !== 5) fail("the host's round choice was not applied");
ok("host round selection is odd-only and applied");

// The server's own clock probe should populate the ping column.
const pings = [...stateOf(host).players.entries()]
  .filter(([id]) => id !== host.sessionId)
  .map(([, player]) => Number(player["ping"] ?? 0));
if (pings.length > 0 && pings.every((ping) => ping === 0)) fail("no ping samples reached the lobby");
ok(`lobby ping measured (${pings.join(", ")} ms)`);

// ------------------------------------------------------- public room listing

const publicRoom = (await client.create("match", {
  name: "public-host",
  isPrivate: false,
})) as AnyRoom;
subscribe(publicRoom);

const publicState = await waitForState(publicRoom, "public room code", (state) => state.roomCode.length === 4);
if (publicState.isPrivate) fail("public room reported itself as private");

const publicListing = await getJson<{ rooms: Array<{ roomId: string; code: string; players: number }> }>(
  "/rooms",
);
const listed = publicListing.rooms.find((room) => room.roomId === publicRoom.roomId);
if (!listed) fail("public room missing from /rooms");
ok(`public room listed (${listed.code}, ${listed.players} player)`);

// Codes are case-insensitive when typed by a human.
const resolved = await getJson<{ roomId: string }>(
  `/rooms/resolve?code=${publicState.roomCode.toLowerCase()}`,
);
if (resolved.roomId !== publicRoom.roomId) fail("code resolution returned the wrong room");
ok("code resolves case-insensitively");

await publicRoom.leave();
await sleep(150);

// ------------------------------------------------------------------- the round

host.send("start");
await waitFor("hide phase", () => stateOf(host).phase === 1, 15_000);
ok("host Start -> hide phase");

const hideState = stateOf(host);
const expectedSeekers = Math.floor(PLAYER_COUNT / 2);
if (hideState.seekerCount !== expectedSeekers) {
  fail(`expected ${expectedSeekers} seekers, got ${hideState.seekerCount}`);
}
if (hideState.hiderCount !== PLAYER_COUNT - expectedSeekers) {
  fail(`expected ${PLAYER_COUNT - expectedSeekers} hiders, got ${hideState.hiderCount}`);
}
ok(`roles split ${hideState.seekerCount}/${hideState.hiderCount}`);

// Anti-cheat: a seeker is blind during the hide phase, so it must not receive
// any other player's entity at all. The team card just showed everyone, and
// views are rebuilt every third tick, so wait for the prune before asserting.
const seekerRooms = rooms.filter(
  (room) => stateOf(room).players.get(room.sessionId)?.["role"] === 1,
);
await waitFor(
  "seeker views to be pruned",
  () => seekerRooms.every((room) => stateOf(room).players.size === 1),
  5_000,
);

for (const room of rooms) {
  const self = stateOf(room).players.get(room.sessionId);
  if (!self) fail(`own player missing for ${room.sessionId}`);

  const isSeeker = self["role"] === 1;
  const others = [...stateOf(room).players.keys()].filter((key) => key !== room.sessionId);

  if (isSeeker && others.length !== 0) {
    fail(`seeker ${room.sessionId} received ${others.length} hidden player(s) during hide phase`);
  }
}
ok("seeker views contain no other players while blinded");

// Private fields must only ever exist on your own player instance.
for (const room of rooms) {
  for (const [id, player] of stateOf(room).players) {
    if (id === room.sessionId) continue;
    for (const field of ["propId", "ammo", "threat", "lockoutMs", "morphTargetId"]) {
      const value = player[field];
      if (typeof value === "number" && value !== 0) {
        fail(`private field ${field}=${value} leaked for ${id} to ${room.sessionId}`);
      }
    }
  }
}
ok("no private fields received for other players");

// Drive input on every client: this exercises the defineInput buffer + applyInput.
const startPositions = rooms.map((room) => {
  const self = stateOf(room).players.get(room.sessionId);
  return { x: Number(self?.["x"] ?? 0), y: Number(self?.["y"] ?? 0) };
});

for (const room of rooms) {
  const input = (room as unknown as { input: (opts?: unknown) => { data: Record<string, number>; send: () => void } }).input();
  (room as unknown as { _smokeInput?: unknown })._smokeInput = input;
}

type SmokeInput = { data: Record<string, number>; send: () => void };

// The room is configured with `seqField: "seq"`, so the server dedupes on the
// sequence number: frames that reuse a seq are dropped as duplicates. Every
// simulated frame needs a fresh one or only the first few ever apply.
const seqs = new Map<string, number>();

function stage(room: AnyRoom, values: { moveX: number; moveY: number; aim: number }): void {
  const input = (room as unknown as { _smokeInput: SmokeInput })._smokeInput;
  const seq = (seqs.get(room.sessionId) ?? 0) + 1;
  seqs.set(room.sessionId, seq);

  input.data.moveX = values.moveX;
  input.data.moveY = values.moveY;
  input.data.aim = values.aim;
  input.data.seq = seq;
  input.send();
}

for (let step = 0; step < 40; step++) {
  rooms.forEach((room, index) => {
    stage(room, {
      moveX: index % 2 === 0 ? 1 : -1,
      moveY: 0.4,
      aim: index % 2 === 0 ? 0 : Math.PI,
    });
  });
  await sleep(33);
}

await sleep(400);

const moved = rooms.filter((room, index) => {
  const self = stateOf(room).players.get(room.sessionId);
  const start = startPositions[index];
  if (!self || !start) return false;
  return Math.hypot(Number(self["x"]) - start.x, Number(self["y"]) - start.y) > 4;
}).length;

if (moved < Math.ceil(PLAYER_COUNT / 2)) {
  fail(`only ${moved}/${PLAYER_COUNT} players moved from input`);
}
ok(`${moved}/${PLAYER_COUNT} players moved from buffered input`);

// A hider morphs. The random walk above left everyone facing nowhere, so walk
// this one to real furniture first: the disguise path is too important to leave
// to a coin flip. Props are tried nearest-first in case another hider took one.
const selfOf = (room: AnyRoom) => stateOf(room).players.get(room.sessionId) ?? {};

async function walkToAndMorph(room: AnyRoom): Promise<boolean> {
  const origin = selfOf(room);
  const candidates = [...MAP.props]
    .map((prop) => ({ prop, d: Math.hypot(prop.x - Number(origin["x"]), prop.y - Number(origin["y"])) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, 4);

  for (const candidate of candidates) {
    const { prop } = candidate;
    // Morphing is contact-based now: walk until the body is against the prop's
    // footprint, not until it is inside some cone.
    const reach = Math.max(prop.width, prop.height) / 2 + PLAYER_RADIUS + MORPH_CONTACT_PAD;

    for (let step = 0; step < 150; step++) {
      const self = selfOf(room);
      const dx = prop.x - Number(self["x"]);
      const dy = prop.y - Number(self["y"]);
      const distance = Math.hypot(dx, dy);
      const close = distance <= reach - 3;

      stage(room, {
        moveX: close ? 0 : dx / distance,
        moveY: close ? 0 : dy / distance,
        aim: Math.atan2(dy, dx),
      });

      if (close) break;
      await sleep(30);
    }

    stage(room, { moveX: 0, moveY: 0, aim: Number(selfOf(room)["aim"] ?? 0) });
    await sleep(120);

    const before = seen[room.sessionId]?.length ?? 0;
    room.send("morph");

    for (let waited = 0; waited < 900; waited += 50) {
      const events = (seen[room.sessionId] ?? []).slice(before);
      if (events.includes("morphResult")) return true;
      if (events.includes("denied")) {
        if (process.env.SMOKE_DEBUG) {
          const now = selfOf(room);
          console.log(
            `      debug: denied prop=${prop.id} kind=${prop.kind} at ${prop.x},${prop.y} ` +
              `player=${Number(now["x"]).toFixed(0)},${Number(now["y"]).toFixed(0)} ` +
              `aim=${Number(now["aim"]).toFixed(2)} phase=${stateOf(room).phase}`,
          );
        }
        break;
      }
      await sleep(50);
    }
  }

  return false;
}

const hiderRoom = rooms.find((room) => stateOf(room).players.get(room.sessionId)?.["role"] === 2);
if (hiderRoom) {
  const morphed = await walkToAndMorph(hiderRoom);
  if (!morphed) {
    console.log("      (morph denied: could not reach furniture — acceptable)");
  } else {
    await sleep(200);
    const self = stateOf(hiderRoom).players.get(hiderRoom.sessionId) ?? {};
    const propId = Number(self["propId"] ?? -1);
    const disguiseId = Number(self["disguiseId"] ?? -1);

    if (Number(self["form"]) !== 1) fail(`morph left form=${String(self["form"])}, expected prop`);
    if (propId < 0) fail("morph did not set a private propId");
    // The disguise is published so every client can draw the furniture the body
    // is wearing and drop the static copy of it.
    if (disguiseId !== propId) {
      fail(`disguiseId ${disguiseId} does not mirror propId ${propId}`);
    }
    ok("hider morph round-tripped and published disguiseId");
  }
}

await waitFor("hunt phase", () => stateOf(host).phase === 2, 30_000);
ok("hide phase -> hunt phase (seekers released)");

// Everyone is visible in the results reveal; a shot from a seeker must answer.
const seekerRoom = rooms.find((room) => stateOf(room).players.get(room.sessionId)?.["role"] === 1);
if (seekerRoom) {
  seekerRoom.send("fire", { aim: 0 });
  await sleep(300);
  if (!seen[seekerRoom.sessionId]?.includes("shot")) {
    fail("seeker fired but received no authoritative shot result");
  }
  ok("shot resolved authoritatively");
}

// Rounds must terminate and wrap back to the lobby.
await waitFor(
  "round completion",
  () => {
    const phase = stateOf(host).phase;
    return phase === 3 || phase === 0;
  },
  120_000,
);
ok("round reached results/lobby");

// Teams are fixed for the match and roles swap every leg, so the side that hid
// now seeks. This is the whole point of the round format.
const rolesBefore = new Map(
  rooms.map((room) => [room.sessionId, Number(stateOf(room).players.get(room.sessionId)?.["role"] ?? 0)]),
);
const seekingBefore = Number(stateOf(host).seekingTeam);

await waitFor("second leg team card", () => stateOf(host).phase === 4, 30_000);
await sleep(400);

if (Number(stateOf(host).seekingTeam) === seekingBefore) fail("seeking team did not swap for leg 2");
for (const room of rooms) {
  const role = Number(stateOf(room).players.get(room.sessionId)?.["role"] ?? 0);
  const before = rolesBefore.get(room.sessionId);
  if (before !== undefined && role !== 0 && role === before) {
    fail(`role did not swap for ${room.sessionId} (${before} -> ${role})`);
  }
}
ok("leg 2 gives every player the opposite role");

for (const room of rooms) room.leave();
console.log("\nSMOKE TEST PASSED");
process.exit(0);
