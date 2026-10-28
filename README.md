# Impropster

A 2D top-down multiplayer **Prop Hunt** game for the browser. One half of the lobby hides as furniture; the other half hunts it with a six-shot revolver and a flashlight cone. Hiders cannot stop giggling.

- **Client:** Phaser 3.90 + Vite + TypeScript
- **Server:** Node.js + Colyseus 0.18, authoritative 30 Hz fixed timestep
- **Monorepo:** pnpm workspaces (`shared`, `server`, `client`)

---

## Quick start

```bash
pnpm install
pnpm dev          # server on :2567, client on :5173
```

Open <http://localhost:5173> and pick an entry point:

- **Create private room** — you are the host and get a four-letter code (`X7K9`). Share it; the room never appears in any list.
- **Create public room** — same, but the lobby is listed on the landing page for anyone.
- **Join via code** — type the four letters. `/?code=X7K9` pre-fills the field, so a code doubles as an invite link.

A round needs **two players**, and the host presses **Start match**; nothing auto-starts. Roles are dealt at that moment with `⌊N/2⌋` seekers, so 4 players is 2/2 and 5 is 2/3.

To fill a lobby without extra devices, bots can be pointed at a specific code (they never create or join a room on their own):

```bash
ROOM_CODE=X7K9 BOT_COUNT=2 pnpm --filter @impropster/server bots
```

### Controls

| Key | Action |
| --- | --- |
| `WASD` / arrows | Move |
| Mouse | Aim (the cone follows) |
| Left click | Fire (seekers) |
| `F` | Morph into the furniture you are facing / drop the disguise |
| `Space` | Lock in place (no movement, no footsteps) |
| `R` | Reload |

### Scripts

| Command | What it does |
| --- | --- |
| `pnpm dev` | Server + client in watch mode |
| `pnpm build` | Production client bundle (`packages/client/dist`) |
| `pnpm typecheck` | Strict TypeScript across all three packages |
| `pnpm test` | Unit tests (shared simulation + server rules) |
| `pnpm --filter @impropster/server smoke` | Headless end-to-end test: creates a room, rejects a wrong code, joins 4 clients by code, starts the match, plays a round, asserts nothing leaks |
| `pnpm --filter @impropster/server bots` | Headless bots for one lobby (`ROOM_CODE` required, `BOT_COUNT` optional) |

Environment: `PORT` (default `2567`, also `HOST`), `IMPROPSTER_PHASE_SCALE` (multiplies the hide/hunt/results timers — `0.3` makes a round ~1 minute, used by the integration test), `VITE_SERVER_URL` on the client.

---

## How it works

### Layout

```
packages/
  shared/   pure simulation + protocol: constants, map, collision, raycasting,
            vision, applyInput, Colyseus schemas, message payloads
  server/   Colyseus room, combat/morph/visibility rules, integration scripts
  client/   Phaser scenes, prediction wrapper, fog renderer, Web Audio, DOM UI
```

`shared` has no Phaser dependency and no Node dependency — the server imports the
same movement step, the same raycasts and the same map the client renders.

### Matchmaking

Colyseus creates rooms and joins them by id, but has no notion of a room code and
no "list the open lobbies" query, so the server keeps a small in-process
`RoomDirectory` (`packages/server/src/registry.ts`):

- `onCreate` allocates a unique 4-letter code (no `I/O/0/1`, so it survives being
  read out loud) and publishes it in state;
- `GET /rooms` lists public rooms still in their lobby (never private ones);
- `GET /rooms/resolve?code=X7K9` turns a typed code into the room id the SDK needs;
- `onJoin` rejects a wrong code for a private room and rejects joining a match
  already in progress;
- the first player is host; the seat is re-elected when they leave.

Nothing auto-joins and nothing auto-starts: the host presses Start, a 3 s
countdown runs, and only then are roles dealt.

### Netcode

The server runs `setFixedTimestep(step, 30)` and owns everything: positions,
collisions, roles, ammo, cooldowns, round phase, giggle scheduling, visibility.

- Input: one `MoveInput` schema instance per fixed step via `defineInput`, with
  `sanitize` clamping `moveX/moveY` and wrapping `aim` server-side.
- Prediction: the client runs the *same* `applyInput(body, cmd, dt, MAP)` through
  `Predict.get(room).reconciler(...)`, so a rollback replay reproduces server
  motion. Remote bodies are interpolated 100 ms in the past.
- Lag compensation: `allowRewindState({ maxRewindMs: 500 })` records player
  positions; a shot is resolved against `rewind.lastSeenBy(shooterSessionId)`,
  i.e. against what the shooter actually saw.

### Anti-cheat / information model

This is the part that makes or breaks prop hunt, and it is enforced on the wire:

- **Every field of `PlayerState` is view-tagged** (`t.number().view()`), and the
  `players` map itself is `.view()`-tagged. `StateView` filters *fields*, not
  entities: without tagging the map, removing a player from a client's view
  leaves an empty shell behind (and an entity the client can count). With it,
  removal is a real delete.
- Each client's view is recomputed at 10 Hz from authoritative perception:
  - seekers get a 100° cone + 62 px ambient bubble, clipped by DDA line of sight;
  - hiders get a 360° / 268 px circle, clipped the same way;
  - the hide phase blinds seekers entirely;
  - lobby and results reveal everyone (roster and scoreboard need it);
  - a disguised hider **is** transmitted, but only within perception, and only
    as furniture: `form` + `disguiseId` travel with the entity so every client
    can draw the prop the body is wearing and suppress the static copy of it.
    It has to work this way — a prop that walks must walk on every screen,
    otherwise a disguised hider who moves is an invisible player. The disguise
    id names a map prop the client already renders, so it reveals nothing
    beyond what is on screen.
- Role/ammo/threat/`propId` are on a second view tag (`view(1)`), so they are
  only ever serialised for the player themselves.
- Every message is rate-limited (token bucket) and hand-validated; the client
  never decides a hit, a morph target, or a round outcome.

### Rendering

- The map is painted once into a `RenderTexture` (floor tiles + walls); props are
  individual sprites so a shattered disguise can be removed.
- Disguises: a body carries both a human sprite and a prop sprite; morphing
  swaps which is visible, sets the prop to the decor's own angle (the body stops
  rotating) and hides the static prop with that id, so the furniture is the
  body. Unmorphing, a shatter or a new round restores it.
- Fog of war: a vector visibility polygon (rays to every nearby wall endpoint,
  with angle-gap filling) is punched into a black overlay by an **inverted
  geometry mask**, then a radial gradient multiplied over the top feathers the
  falloff. Rebuilt at 30 Hz. The mask source is built with
  `make.graphics(..., false)` — a mask Graphics added to the display list paints
  its own white stencil over the hole it cuts, which looks exactly like a white
  cone on a black screen. Only the overlay is masked; the camera and world
  containers never are, and all world objects stay below `DEPTH.fog` (1000).
- Everything is procedural: textures are drawn with Phaser graphics at boot, and
  all audio is synthesised into buffers, so the repo has no binary assets.

### Audio

`AudioController` owns one `AudioContext`, a compressor and a voice budget
(18 concurrent). The listener is updated every frame from the local player's
position and facing with `setTargetAtTime` (no zipper noise on fast turns):

- footsteps — filtered noise bursts through a `PannerNode` (HRTF, inverse distance),
  emitted by the server only to players close enough to hear them (a wall halves
  the audible radius);
- giggles — a four-tone warble, server-scheduled at 30–40 s intervals, with an
  off-screen edge arrow and a minimap ripple;
- heartbeat — a low pulse whose rate and volume track the hider's server-computed
  threat level, plus a red vignette.

---

## Round flow

`Lobby → (host starts, 3 s) → Hide (20 s) → Hunt (160 s) → Results (9 s) → Lobby`

Roles split as `seekers = floor(N/2)`, hiders take the remainder (4 → 2/2,
5 → 2/3), dealt at the moment the countdown fires. Seekers are blinded in spawn during the hide phase. A round ends when
every hider is eliminated (seekers win) or the timer expires with survivors
(hiders win). Survivors score +2, eliminations +1.

Combat is two-hit: the first hit shatters the disguise, converts the hider to
human form and grants a 1 s ×1.5 speed boost; the second eliminates. Any shot
that hits nothing — including a decorative prop — locks the weapon for 2 s
(movement stays free). Six-round magazine, 2.5 s reload.

---

## Verification status

Run locally on Windows with Node 26 / pnpm 12:

- `pnpm typecheck` — clean across `shared`, `server`, `client`.
- `pnpm test` — 15 shared tests (collision, DDA raycasting, visibility polygon,
  normalised diagonal movement, boost) + 19 server tests (team split, morph
  targeting, shatter/eliminate, miss lockout, wall-blocked shots, view filtering,
  disguised-player sharing).
- `pnpm build` — production client bundle ~420 kB gzip (Phaser included).
- `smoke` — creates a private room, proves it is absent from `/rooms`, proves a
  wrong code is rejected, joins 4 clients by code, measures lobby ping, creates
  and lists a public room, resolves its code case-insensitively, has the host
  start the match, checks the `⌊N/2⌋` split, then hide (seekers receive zero
  other players) → buffered input moves bodies → walk to furniture → morph (the
  published `disguiseId` mirrors the private `propId`) → hunt → authoritative
  shot → results.
- Fog rendering — verified against the live framebuffer, not just the code: the
  display list holds exactly one masked object (the darkness rect, inverted) and
  no stray mask Graphics; sampling a ring around the player found a ~95° lit
  wedge around the seeker's aim with black outside it, and 360° awareness with
  wall occlusion for a hider.
- Sprite facing — the player texture's facing wedge measures to the right of its
  centre (6 cream pixels on the +x edge, 0 on the top edge), and the body's
  rotation equals `atan2(dy, dx)` at 0.01 rad for a right-hand pointer and
  1.57 rad for a downward one, so the gun and the crosshair agree.
- Disguise rendering — a disguised body draws the prop texture, hides the human
  sprite, keeps the prop's own angle and follows the body (+40/+12 px moved with
  it); the map's copy of that prop is hidden meanwhile and comes back on unmorph.
- Audio clues — the giggle ducks the ambience bus from 0.9 to 0.18 and restores
  it over its full 1.15 s; the minimap/edge ripple survives 2.4 s and is gone by
  2.6 s (clue window 2.5 s).

Not verified automatically: sustained 10-player load, and the visual/feel pass
(colour, cone tuning, audio mix) which needs human eyes and ears.
