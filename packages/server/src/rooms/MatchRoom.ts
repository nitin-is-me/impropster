import { Client, Room, ServerError } from "colyseus";
import type { Rewind } from "colyseus";
import { StateView } from "@colyseus/schema";
import {
  applyInput,
  BOOST_MULTIPLIER,
  BOOST_MS,
  clamp,
  ClientMessage,
  dist,
  GIGGLE_MAX_MS,
  GIGGLE_MIN_MS,
  HEARING_RADIUS,
  HEARING_WALL_FACTOR,
  HIDE_PHASE_MS,
  HIDER_MAX_HP,
  HUNT_PHASE_MS,
  lineOfSight,
  DEFAULT_ROUNDS,
  isAllowedRounds,
  LEGS_PER_ROUND,
  MAG_SIZE,
  MAP,
  MAX_PLAYERS,
  MIN_PLAYERS,
  NAME_MAX,
  NAME_MIN,
  TEAM_REVEAL_MS,
  GameState,
  MoveInput,
  normalizeAngle,
  Phase,
  PlayerForm,
  PlayerRole,
  PlayerState,
  RESULTS_MS,
  ServerMessage,
  START_COUNTDOWN_MS,
  STEP_DISTANCE,
  THREAT_RADIUS,
  TICK_MS,
  TICK_RATE,
  Winner,
  type GameStateInstance,
  type MapDefinition,
  type MoveInputPayload,
  type PlayerStateInstance,
  type PropDefinition,
} from "@impropster/shared";
import { resolveFire, startReload } from "../rules/combat";
import { findMorphTarget } from "../rules/morph";
import { shuffleSeeded } from "../rules/round";
import { shouldShareState } from "../rules/visibility";
import { directory, names, normalizeCode } from "../registry";

type Bucket = { tokens: number; updatedAt: number };

/** Options accepted by `client.create` / `client.joinById`. */
export interface RoomOptions {
  name?: unknown;
  code?: unknown;
  isPrivate?: unknown;
}

const PLAYER_COLORS = 8;

/**
 * Optional duration multiplier for playtests and the integration script
 * (`IMPROPSTER_PHASE_SCALE=0.3` gives a 6s hide phase and a ~48s hunt).
 * Defaults to 1 = the design-document timings.
 */
const PHASE_SCALE = (() => {
  const parsed = Number.parseFloat(process.env.IMPROPSTER_PHASE_SCALE ?? "1");
  return Number.isFinite(parsed) && parsed > 0 ? clamp(parsed, 0.05, 10) : 1;
})();

const HIDE_MS = Math.round(HIDE_PHASE_MS * PHASE_SCALE);
const HUNT_MS = Math.round(HUNT_PHASE_MS * PHASE_SCALE);
const RESULTS_MS_SCALED = Math.round(RESULTS_MS * PHASE_SCALE);
const TEAMS_MS = Math.round(TEAM_REVEAL_MS * PHASE_SCALE);

export class MatchRoom extends Room<{
  state: GameStateInstance;
  input: MoveInputPayload;
}> {
  override state = new GameState();
  override maxClients = MAX_PLAYERS;
  override autoDispose = true;

  private readonly map: MapDefinition = MAP;

  override inputs = this.defineInput(MoveInput, {
    seqField: "seq",
    bufferMaxSize: 8,
    idle: true,
    sanitize: (input) => {
      input.moveX = clamp(Number.isFinite(input.moveX) ? input.moveX : 0, -1, 1);
      input.moveY = clamp(Number.isFinite(input.moveY) ? input.moveY : 0, -1, 1);
      input.aim = normalizeAngle(Number.isFinite(input.aim) ? input.aim : 0);
    },
  });

  private rewind!: Rewind;
  private phaseEndTick = 0;
  /** Tick at which a host-started countdown fires; 0 when idle. */
  private startTick = 0;
  private giggleAtTick = 0;
  /** Join code, allocated on create and never reused while the room lives. */
  private code = "";
  private isPrivate = true;

  /** Which remote players each client currently receives. */
  private readonly viewCache = new Map<string, Set<string>>();
  /** sessionId -> the name claim this seat holds, so it can be released. */
  private readonly nameOwner = new Map<string, string>();
  private readonly buckets = new Map<string, Bucket>();
  private readonly stepAccumulator = new Map<string, number>();
  private readonly lastPosition = new Map<string, { x: number; y: number }>();

  override messages = {
    [ClientMessage.Fire]: (client: Client, payload: unknown) => this.onFire(client, payload),
    [ClientMessage.Reload]: (client: Client) => this.onReload(client),
    [ClientMessage.Morph]: (client: Client) => this.onMorph(client),
    [ClientMessage.ToggleLock]: (client: Client) => this.onToggleLock(client),
    [ClientMessage.Start]: (client: Client) => this.onStart(client),
    [ClientMessage.Rounds]: (client: Client, payload: unknown) => this.onRounds(client, payload),
    [ClientMessage.Pong]: (client: Client, payload: unknown) => this.onPong(client, payload),
  };

  override onCreate(options: RoomOptions = {}): void {
    this.maxClients = MAX_PLAYERS;
    this.patchRate = TICK_MS;
    this.state.minPlayers = MIN_PLAYERS;
    this.state.maxPlayers = MAX_PLAYERS;
    this.state.roundsTotal = DEFAULT_ROUNDS;

    // A room is private unless the creator explicitly asked for it to be
    // listed. Codes are allocated here, so the client learns its code from the
    // state patch rather than inventing one that might collide.
    this.isPrivate = options.isPrivate !== false;
    this.code = directory.allocateCode();
    this.state.roomCode = this.code;
    this.state.isPrivate = this.isPrivate;

    directory.register({
      roomId: this.roomId,
      code: this.code,
      hostName: "",
      players: 0,
      maxPlayers: MAX_PLAYERS,
      phase: Phase.Lobby,
      isPrivate: this.isPrivate,
      createdAt: Date.now(),
    });

    // Server-side lag compensation: record positions of every player, so a
    // shot can be resolved against the world the shooter actually saw.
    this.rewind = this.allowRewindState({ maxRewindMs: 500 });
    this.rewind.attachAll(this.state.players, {
      fields: ["x", "y"],
      mode: "snapshot",
    });

    this.setFixedTimestep(this.step, TICK_RATE);
  }

  override onDispose(): void {
    directory.unregister(this.roomId);
    for (const owner of this.nameOwner.values()) names.release(owner);
    this.nameOwner.clear();
    this.viewCache.clear();
    this.buckets.clear();
    this.stepAccumulator.clear();
    this.lastPosition.clear();
  }

  override onJoin(client: Client, options: RoomOptions | undefined): void {
    // Two things gate a seat: the room code (for private lobbies) and the
    // phase (a round cannot absorb a player halfway through).
    if (this.state.phase !== Phase.Lobby && this.state.phase !== Phase.Results) {
      throw new ServerError(400, "That match is already in progress");
    }

    const provided = typeof options?.code === "string" ? normalizeCode(options.code) : "";
    // The creator is the first client and has never been told the code yet.
    if (this.state.hostId !== "" && provided !== this.code) {
      throw new ServerError(400, "That room code is not valid");
    }

    const name = sanitizeName(options?.name);
    if (name === null) {
      throw new ServerError(400, "name-invalid");
    }

    // Names are unique across the whole server, not just this room: the point of
    // a display name is that nobody else in the match can be mistaken for you.
    const owner = `${this.roomId}:${client.sessionId}`;
    if (!names.claim(name, owner)) {
      throw new ServerError(409, "name-taken");
    }

    const player = new PlayerState();
    player.name = name;
    player.color = this.state.players.size % PLAYER_COLORS;
    player.ping = 0;
    player.team = this.assignTeam();

    const spawns = this.map.hiderSpawns;
    const spawn = spawns[this.state.players.size % spawns.length];
    if (spawn) {
      player.x = spawn.x;
      player.y = spawn.y;
    }

    this.state.players.set(client.sessionId, player);

    // First player in is the host; the seat is re-elected when they leave.
    if (this.state.hostId === "") this.state.hostId = client.sessionId;

    const view = new StateView();
    view.add(player, 1);
    client.view = view;

    this.viewCache.set(client.sessionId, new Set());
    this.lastPosition.set(client.sessionId, { x: player.x, y: player.y });
    this.buckets.set(client.sessionId, { tokens: 30, updatedAt: Date.now() });
    this.nameOwner.set(client.sessionId, owner);
    // Phase/round/winner are in the initial state patch, so no join message is
    // needed — and sending one would arrive before the client can subscribe.
  }

  override async onLeave(client: Client, code?: number): Promise<void> {
    const player = this.state.players.get(client.sessionId);
    if (!player) return;

    player.connected = false;
    // 4000 == CONSENTED: the player closed the tab on purpose, don't hold the seat.
    const consented = code === 4000;

    try {
      if (consented) throw new Error("consented-leave");
      await this.allowReconnection(client, 20);
      player.connected = true;
    } catch {
      this.dropPlayer(client.sessionId);
    }
  }

  override onReconnect(client: Client): void {
    const player = this.state.players.get(client.sessionId);
    if (player) player.connected = true;
  }

  /** Promotes the longest-seated connected player when the host is gone. */
  private electHost(): void {
    const current = this.state.hostId === "" ? undefined : this.state.players.get(this.state.hostId);
    if (current && current.connected !== false) return;

    for (const [sessionId, player] of this.state.players) {
      if (player.connected === false) continue;
      this.state.hostId = sessionId;
      return;
    }

    this.state.hostId = "";
  }

  /** Keeps the lobby roster split as evenly as the seats allow. */
  private assignTeam(): number {
    let teamA = 0;
    let teamB = 0;
    for (const player of this.state.players.values()) {
      if (player.team === 0) teamA += 1;
      else teamB += 1;
    }
    return teamA <= teamB ? 0 : 1;
  }

  private readyCount(): number {
    let ready = 0;
    for (const player of this.state.players.values()) {
      if (player.connected !== false) ready += 1;
    }
    return ready;
  }

  // ---------------------------------------------------------------- messages

  private allowMessage(sessionId: string): boolean {
    const bucket = this.buckets.get(sessionId);
    if (!bucket) return false;

    const now = Date.now();
    const elapsed = Math.max(0, now - bucket.updatedAt) / 1000;
    bucket.tokens = Math.min(40, bucket.tokens + elapsed * 25);
    bucket.updatedAt = now;

    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  private onFire(client: Client, payload: unknown): void {
    if (!this.allowMessage(client.sessionId)) return;

    const shooter = this.state.players.get(client.sessionId);
    if (!shooter) return;

    const rawAim = (payload as { aim?: unknown } | null)?.aim;
    if (typeof rawAim !== "number" || !Number.isFinite(rawAim)) return;

    shooter.aim = normalizeAngle(rawAim);

    const seen = this.rewind.lastSeenBy(client.sessionId);
    const readSeen = (target: PlayerStateInstance) => ({
      x: seen.value(target, "x"),
      y: seen.value(target, "y"),
    });

    const outcome = resolveFire({
      map: this.map,
      state: this.state,
      shooterId: client.sessionId,
      shooter,
      seenPosition: readSeen,
    });

    if (!outcome.accepted) {
      client.send(ServerMessage.Denied, { reason: outcome.reason ?? "denied" });
      return;
    }

    if (outcome.payload) this.broadcast(ServerMessage.Shot, outcome.payload);

    if (outcome.shatteredPropId !== undefined && outcome.shatteredPropId >= 0) {
      this.broadcast(ServerMessage.Shatter, {
        propId: outcome.shatteredPropId,
        x: outcome.payload?.impactX ?? shooter.x,
        y: outcome.payload?.impactY ?? shooter.y,
        targetId: outcome.payload?.targetId ?? "",
      });
      this.refreshCounts();
    }

    if (outcome.eliminatedId) {
      const victim = this.state.players.get(outcome.eliminatedId);
      if (shooter.team === 0) this.state.teamAKills += 1;
      else this.state.teamBKills += 1;

      this.broadcast(ServerMessage.Eliminated, {
        targetId: outcome.eliminatedId,
        x: outcome.payload?.impactX ?? 0,
        y: outcome.payload?.impactY ?? 0,
        killerName: shooter.name,
        victimName: victim?.name ?? "",
      });
      this.refreshCounts();
    }
  }

  private onReload(client: Client): void {
    if (!this.allowMessage(client.sessionId)) return;
    const player = this.state.players.get(client.sessionId);
    if (!player || player.role !== PlayerRole.Seeker || !player.alive) return;
    startReload(player);
  }

  private onMorph(client: Client): void {
    if (!this.allowMessage(client.sessionId)) return;

    const player = this.state.players.get(client.sessionId);
    if (!player || !player.alive) return;
    if (player.role !== PlayerRole.Hider) return;
    if (this.state.phase !== Phase.Hide && this.state.phase !== Phase.Hunt) return;
    if (player.morphCdMs > 0) return;

    // Leave the current disguise.
    if (player.form === PlayerForm.Prop) {
      player.form = PlayerForm.Human;
      player.propId = -1;
      player.disguiseId = -1;
      player.locked = false;
      player.morphCdMs = 600;
      this.broadcast(ServerMessage.MorphResult, { ok: true, propId: -1 });
      return;
    }

    const target = this.findTarget(player);
    if (!target) {
      client.send(ServerMessage.Denied, { reason: "no-prop" });
      return;
    }

    player.form = PlayerForm.Prop;
    player.propId = target.id;
    player.disguiseId = target.id;
    player.x = target.x;
    player.y = target.y;
    player.aim = target.angle;
    player.locked = false;
    player.morphCdMs = 900;
    player.canMorph = false;
    player.morphTargetId = -1;

    client.send(ServerMessage.MorphResult, { ok: true, propId: target.id });
  }

  private onToggleLock(client: Client): void {
    if (!this.allowMessage(client.sessionId)) return;
    const player = this.state.players.get(client.sessionId);
    if (!player || !player.alive) return;
    if (player.form !== PlayerForm.Prop) return;
    player.locked = !player.locked;
  }

  /** Host-only. Picks how many rounds the match runs (odd, 1–9). */
  private onRounds(client: Client, payload: unknown): void {
    if (!this.allowMessage(client.sessionId)) return;
    if (this.state.phase !== Phase.Lobby) return;
    if (this.state.hostId !== client.sessionId) return;

    const raw = (payload as { rounds?: unknown } | null)?.rounds;
    const rounds = typeof raw === "number" ? raw : Number(raw);
    if (!isAllowedRounds(rounds)) {
      client.send(ServerMessage.Denied, { reason: "bad-rounds" });
      return;
    }

    this.state.roundsTotal = rounds;
  }

  /** Host-only. Queues a short countdown, then deals roles and starts Hide. */
  private onStart(client: Client): void {
    if (!this.allowMessage(client.sessionId)) return;
    if (this.state.phase !== Phase.Lobby) return;

    if (this.state.hostId !== client.sessionId) {
      client.send(ServerMessage.Denied, { reason: "not-host" });
      return;
    }
    if (this.startTick !== 0) return;

    if (this.readyCount() < MIN_PLAYERS) {
      client.send(ServerMessage.Denied, { reason: "need-players" });
      return;
    }

    this.startTick = this.state.tick + Math.round(START_COUNTDOWN_MS / TICK_MS);
    this.state.lobbyMs = START_COUNTDOWN_MS;
  }

  /**
   * Clock probe echo. Pings are display-only, so they must never be able to
   * fight over the message budget — a dropped pong just skips one sample.
   */
  private onPong(client: Client, payload: unknown): void {
    const sentAt = (payload as { t?: unknown } | null)?.t;
    if (typeof sentAt !== "number" || !Number.isFinite(sentAt)) return;

    const player = this.state.players.get(client.sessionId);
    if (!player) return;

    const rtt = Date.now() - sentAt;
    if (rtt < 0 || rtt > 5000) return;

    // Smoothed, so one spike does not make the roster row jump around.
    player.ping = Math.round(player.ping === 0 ? rtt : player.ping * 0.6 + rtt * 0.4);
  }

  // ------------------------------------------------------------------- loop

  private step = (ctx: { dt: number }): void => {
    this.state.tick += 1;
    this.tickPlayerTimers();
    this.stepPhase();

    const simulating = this.state.phase === Phase.Hide || this.state.phase === Phase.Hunt;
    if (simulating) this.stepMovement(ctx.dt);

    if (this.state.tick % 3 === 0) this.syncViews();
    if (this.state.phase === Phase.Hunt) {
      this.stepFootsteps();
      this.stepGiggle();
    }
    if (this.state.tick % 4 === 0) {
      this.stepThreat();
      this.refreshMorphHints();
    }

    this.refreshCounts();

    if (this.state.tick % 60 === 0) this.probePing();
    if (this.state.tick % 30 === 0) this.publishSummary();
  };

  private probePing(): void {
    const sentAt = Date.now();
    for (const client of this.clients) {
      client.send(ServerMessage.PingProbe, { t: sentAt });
    }
  }

  /** Keeps the public room list honest without exposing anything private. */
  private publishSummary(): void {
    const host = this.state.hostId === "" ? undefined : this.state.players.get(this.state.hostId);
    directory.update(this.roomId, {
      players: this.readyCount(),
      phase: this.state.phase,
      hostName: host?.name ?? "",
    });
  }

  private tickPlayerTimers(): void {
    for (const player of this.state.players.values()) {
      if (player.cooldownMs > 0) player.cooldownMs = Math.max(0, player.cooldownMs - TICK_MS);
      if (player.lockoutMs > 0) player.lockoutMs = Math.max(0, player.lockoutMs - TICK_MS);
      if (player.morphCdMs > 0) player.morphCdMs = Math.max(0, player.morphCdMs - TICK_MS);

      if (player.boostMs > 0) {
        player.boostMs = Math.max(0, player.boostMs - TICK_MS);
        if (player.boostMs === 0) player.speedMul = 1;
      }

      if (player.reloading) {
        player.reloadMs = Math.max(0, player.reloadMs - TICK_MS);
        if (player.reloadMs === 0) {
          player.reloading = false;
          player.ammo = MAG_SIZE;
        }
      }
    }
  }

  private stepPhase(): void {
    const tick = this.state.tick;

    switch (this.state.phase) {
      case Phase.Lobby: {
        // Nothing starts on its own: a host presses Start. If the lobby loses
        // players during the countdown it is cancelled rather than dropping
        // everyone into a lopsided round.
        if (this.startTick === 0) {
          this.state.phaseMs = 0;
          this.state.lobbyMs = 0;
          break;
        }

        if (this.readyCount() < MIN_PLAYERS) {
          this.startTick = 0;
          this.state.phaseMs = 0;
          this.state.lobbyMs = 0;
          break;
        }

        this.state.phaseMs = 0;
        this.state.lobbyMs = Math.max(0, (this.startTick - tick) * TICK_MS);

        if (tick >= this.startTick) {
          this.startTick = 0;
          this.state.lobbyMs = 0;
          this.beginMatch();
        }
        break;
      }

      case Phase.Teams: {
        this.state.phaseMs = Math.max(0, (this.phaseEndTick - tick) * TICK_MS);
        if (tick >= this.phaseEndTick) {
          this.state.phase = Phase.Hide;
          this.phaseEndTick = tick + Math.round(HIDE_MS / TICK_MS);
          this.state.phaseMs = HIDE_MS;
          this.announcePhase();
        }
        break;
      }

      case Phase.Hide: {
        this.state.phaseMs = Math.max(0, (this.phaseEndTick - tick) * TICK_MS);
        if (tick >= this.phaseEndTick) {
          this.state.phase = Phase.Hunt;
          this.phaseEndTick = tick + Math.round(HUNT_MS / TICK_MS);
          this.state.phaseMs = HUNT_MS;
          this.announcePhase();
        }
        break;
      }

      case Phase.Hunt: {
        this.state.phaseMs = Math.max(0, (this.phaseEndTick - tick) * TICK_MS);

        if (this.state.seekerCount === 0) {
          this.endLeg(Winner.Hiders);
        } else if (this.state.aliveHiders === 0) {
          this.endLeg(Winner.Seekers);
        } else if (tick >= this.phaseEndTick) {
          this.endLeg(Winner.Hiders);
        }
        break;
      }

      case Phase.Results: {
        this.state.phaseMs = Math.max(0, (this.phaseEndTick - tick) * TICK_MS);
        if (tick >= this.phaseEndTick) this.advanceAfterResults();
        break;
      }

      default:
        break;
    }
  }

  private stepMovement(dt: number): void {
    for (const [sessionId, player] of this.state.players) {
      if (!player.alive) continue;
      if (this.state.phase === Phase.Hide && player.role === PlayerRole.Seeker) continue;

      const accessor = this.inputs.get(sessionId);
      const command = accessor.next();
      if (!command) continue;

      // Always accept the aim so blinded/locked players can still look around.
      player.aim = normalizeAngle(command.aim);

      if (player.locked) continue;
      applyInput(player, command, dt, this.map);
    }
  }

  private stepFootsteps(): void {
    for (const [sessionId, player] of this.state.players) {
      const previous = this.lastPosition.get(sessionId) ?? { x: player.x, y: player.y };
      const moved = dist(previous.x, previous.y, player.x, player.y);
      this.lastPosition.set(sessionId, { x: player.x, y: player.y });

      if (!player.alive || player.locked || moved <= 0.01) continue;

      const accumulated = (this.stepAccumulator.get(sessionId) ?? 0) + moved;
      if (accumulated < STEP_DISTANCE) {
        this.stepAccumulator.set(sessionId, accumulated);
        continue;
      }
      this.stepAccumulator.set(sessionId, 0);

      // Footsteps are only sent to players close enough to hear them — and a
      // wall halves the audible radius. Nothing is broadcast "just in case".
      for (const listener of this.clients) {
        if (listener.sessionId === sessionId) continue;
        const hearer = this.state.players.get(listener.sessionId);
        if (!hearer || !hearer.alive) continue;

        const distance = dist(hearer.x, hearer.y, player.x, player.y);
        const clear = lineOfSight(this.map, hearer.x, hearer.y, player.x, player.y);
        const audible = clear ? HEARING_RADIUS : HEARING_RADIUS * HEARING_WALL_FACTOR;
        if (distance > audible) continue;

        listener.send(ServerMessage.Footstep, {
          x: player.x,
          y: player.y,
          step: this.state.tick,
        });
      }
    }
  }

  private stepGiggle(): void {
    const alive = [...this.state.players.entries()].filter(
      ([, player]) => player.alive && player.role === PlayerRole.Hider,
    );
    if (alive.length === 0) return;

    if (this.giggleAtTick === 0) {
      this.giggleAtTick = this.state.tick + this.randomGiggleTicks();
      return;
    }

    if (this.state.tick < this.giggleAtTick) return;

    const pick = alive[Math.floor(Math.random() * alive.length)];
    if (pick) {
      const [, player] = pick;
      this.broadcast(ServerMessage.Giggle, {
        x: player.x,
        y: player.y,
        variant: Math.floor(Math.random() * 4),
      });
    }

    this.giggleAtTick = this.state.tick + this.randomGiggleTicks();
  }

  private randomGiggleTicks(): number {
    const min = Math.round(GIGGLE_MIN_MS / TICK_MS);
    const max = Math.round(GIGGLE_MAX_MS / TICK_MS);
    return min + Math.floor(Math.random() * (max - min));
  }

  private stepThreat(): void {
    const seekers: Array<[string, PlayerStateInstance]> = [];
    for (const entry of this.state.players) {
      if (entry[1].alive && entry[1].role === PlayerRole.Seeker) seekers.push(entry);
    }

    for (const [, player] of this.state.players) {
      if (!player.alive || player.role !== PlayerRole.Hider) {
        player.threat = 0;
        continue;
      }

      let nearest = Infinity;
      for (const [, seeker] of seekers) {
        nearest = Math.min(nearest, dist(player.x, player.y, seeker.x, seeker.y));
      }

      if (!Number.isFinite(nearest) || nearest > THREAT_RADIUS) {
        player.threat = 0;
        continue;
      }

      const clear = seekers.some(([, seeker]) =>
        lineOfSight(this.map, player.x, player.y, seeker.x, seeker.y),
      );
      const base = 1 - nearest / THREAT_RADIUS;
      player.threat = Math.round(clamp(clear ? base * 1.15 : base, 0, 1) * 100) / 100;
    }
  }

  private refreshMorphHints(): void {
    if (this.state.phase !== Phase.Hide && this.state.phase !== Phase.Hunt) return;

    for (const [, player] of this.state.players) {
      if (player.role !== PlayerRole.Hider || !player.alive || player.form === PlayerForm.Prop) {
        player.canMorph = false;
        player.morphTargetId = -1;
        continue;
      }
      const target = this.findTarget(player);
      player.canMorph = target !== null;
      player.morphTargetId = target ? target.id : -1;
    }
  }

  private findTarget(player: PlayerStateInstance): PropDefinition | null {
    return findMorphTarget(this.map, player, (propId) => this.isPropTaken(propId));
  }

  private isPropTaken(propId: number): boolean {
    if (this.state.shattered.includes(propId)) return false;
    for (const [, player] of this.state.players) {
      if (player.form === PlayerForm.Prop && player.propId === propId) return true;
    }
    return false;
  }

  // ------------------------------------------------------------------ views

  /**
   * Builds each client's filtered state. This is the anti-cheat backbone: a
   * seeker never receives a hider's entity while that hider is disguised, and
   * nothing is shared without line of sight.
   */
  private syncViews(): void {
    for (const client of this.clients) {
      const viewer = this.state.players.get(client.sessionId);
      const view = client.view as StateView | undefined;
      if (!viewer || !view) continue;

      const visible = this.viewCache.get(client.sessionId) ?? new Set<string>();

      for (const [targetId, target] of this.state.players) {
        if (targetId === client.sessionId) continue;

        const desired = shouldShareState(
          this.map,
          this.state.phase,
          viewer,
          client.sessionId,
          target,
          targetId,
        );

        const present = visible.has(targetId);
        if (desired && !present) {
          view.add(target);
          visible.add(targetId);
        } else if (!desired && present) {
          view.remove(target);
          visible.delete(targetId);
        }
      }

      this.viewCache.set(client.sessionId, visible);
    }
  }

  // --------------------------------------------------------------- lifecycle

  /**
   * Starts a match: locks in two balanced teams, then plays leg 1.
   *
   * Teams are fixed for the whole match and roles swap every leg, so each team
   * hides once and seeks once per round. Only the round count is odd; the match
   * winner is still always decided (score, then kills, then the last leg).
   */
  private beginMatch(): void {
    const entries = [...this.state.players.entries()].filter(([, player]) => player.connected !== false);
    if (entries.length < MIN_PLAYERS) {
      return;
    }

    const ordered = shuffleSeeded(entries, Date.now() & 0x7fffffff);
    const teamA = Math.ceil(ordered.length / 2);
    ordered.forEach(([, player], index) => {
      player.team = index < teamA ? 0 : 1;
    });

    this.state.round = 1;
    this.state.leg = 0;
    this.state.teamAScore = 0;
    this.state.teamBScore = 0;
    this.state.teamAKills = 0;
    this.state.teamBKills = 0;
    this.state.matchWinner = 0;
    this.state.matchOver = false;
    this.state.winner = Winner.None;

    this.startLeg();
  }

  /** Deals roles for the current leg and shows the team card for five seconds. */
  private startLeg(): void {
    const seekingTeam = this.state.leg === 0 ? 1 : 0;
    this.state.seekingTeam = seekingTeam;
    this.state.shattered.clear();
    this.state.winner = Winner.None;
    this.giggleAtTick = 0;

    let seekerIndex = 0;
    let hiderIndex = 0;

    for (const [sessionId, player] of this.state.players) {
      player.form = PlayerForm.Human;
      player.propId = -1;
      player.disguiseId = -1;
      player.locked = false;
      player.speedMul = 1;
      player.boostMs = 0;
      player.lockoutMs = 0;
      player.cooldownMs = 0;
      player.morphCdMs = 0;
      player.reloading = false;
      player.reloadMs = 0;
      player.threat = 0;
      player.canMorph = false;
      player.morphTargetId = -1;
      player.alive = player.connected !== false;
      player.role = player.alive
        ? player.team === seekingTeam
          ? PlayerRole.Seeker
          : PlayerRole.Hider
        : PlayerRole.None;

      const spawns = player.role === PlayerRole.Seeker ? this.map.seekerSpawns : this.map.hiderSpawns;
      const index = player.role === PlayerRole.Seeker ? seekerIndex++ : hiderIndex++;
      const spawn = spawns[index % spawns.length];
      if (spawn) {
        player.x = spawn.x;
        player.y = spawn.y;
      }

      player.aim = 0;
      player.ammo = MAG_SIZE;
      player.hp = HIDER_MAX_HP;

      this.lastPosition.set(sessionId, { x: player.x, y: player.y });
      this.stepAccumulator.set(sessionId, 0);
    }

    this.state.phase = Phase.Teams;
    this.state.phaseMs = TEAMS_MS;
    this.phaseEndTick = this.state.tick + Math.round(TEAMS_MS / TICK_MS);

    this.refreshCounts();
    this.syncViews();
    this.announcePhase();
  }

  private endLeg(winner: number): void {
    if (this.state.phase === Phase.Results) return;

    const winnersSeek = winner === Winner.Seekers;
    const winnerTeam = winnersSeek ? this.state.seekingTeam : 1 - this.state.seekingTeam;

    if (winnerTeam === 0) this.state.teamAScore += 1;
    else this.state.teamBScore += 1;

    for (const [, player] of this.state.players) {
      if (!player.alive) continue;
      if (player.role === PlayerRole.Hider && winner === Winner.Hiders) player.score += 2;
      if (player.role === PlayerRole.Seeker && winner === Winner.Seekers) player.score += 1;
    }

    this.state.phase = Phase.Results;
    this.state.winner = winner;
    this.state.phaseMs = RESULTS_MS_SCALED;
    this.phaseEndTick = this.state.tick + Math.round(RESULTS_MS_SCALED / TICK_MS);

    this.state.matchOver =
      this.state.round >= this.state.roundsTotal && this.state.leg + 1 >= LEGS_PER_ROUND;
    if (this.state.matchOver) {
      this.state.matchWinner = this.resolveMatchWinner(winnerTeam);
    }

    this.refreshCounts();
    this.syncViews();
    this.announcePhase();
  }

  /**
   * Score first, then eliminations, then the team that just won the last leg.
   * A match therefore always has a winner, whatever the round count does.
   */
  private resolveMatchWinner(lastLegWinner: number): number {
    const scoreA = this.state.teamAScore;
    const scoreB = this.state.teamBScore;
    if (scoreA !== scoreB) return scoreA > scoreB ? 1 : 2;

    const killsA = this.state.teamAKills;
    const killsB = this.state.teamBKills;
    if (killsA !== killsB) return killsA > killsB ? 1 : 2;

    return lastLegWinner === 0 ? 1 : 2;
  }

  /** After the leg scoreboard: next leg, next round, or back to the lobby. */
  private advanceAfterResults(): void {
    if (this.state.matchOver) {
      this.resetToLobby();
      return;
    }

    if (this.state.leg + 1 < LEGS_PER_ROUND) {
      this.state.leg += 1;
    } else {
      this.state.leg = 0;
      this.state.round += 1;
    }

    this.startLeg();
  }

  private resetToLobby(): void {
    this.state.phase = Phase.Lobby;
    this.state.winner = Winner.None;
    this.state.phaseMs = 0;
    this.state.lobbyMs = 0;
    this.state.round = 0;
    this.state.leg = 0;
    this.state.teamAScore = 0;
    this.state.teamBScore = 0;
    this.state.teamAKills = 0;
    this.state.teamBKills = 0;
    this.state.matchWinner = 0;
    this.state.matchOver = false;
    this.giggleAtTick = 0;
    this.state.shattered.clear();

    for (const [sessionId, player] of this.state.players) {
      player.role = PlayerRole.None;
      player.alive = true;
      player.form = PlayerForm.Human;
      player.propId = -1;
      player.disguiseId = -1;
      player.hp = HIDER_MAX_HP;
      player.locked = false;
      player.speedMul = 1;
      player.boostMs = 0;
      player.lockoutMs = 0;
      player.cooldownMs = 0;
      player.morphCdMs = 0;
      player.reloading = false;
      player.reloadMs = 0;
      player.threat = 0;
      player.canMorph = false;
      player.morphTargetId = -1;
      player.ammo = MAG_SIZE;

      const spawns = this.map.hiderSpawns;
      const spawn = spawns[this.state.players.size % spawns.length];
      if (spawn) {
        player.x = spawn.x;
        player.y = spawn.y;
      }
      player.aim = 0;
      player.team = this.assignTeam();
      this.lastPosition.set(sessionId, { x: player.x, y: player.y });
      this.stepAccumulator.set(sessionId, 0);
    }

    this.startTick = 0;
    this.electHost();
    this.refreshCounts();
    this.syncViews();
    this.announcePhase();
  }

  private dropPlayer(sessionId: string): void {
    const player = this.state.players.get(sessionId);
    if (!player) return;

    // A name is only held while its owner is actually in the game.
    const owner = this.nameOwner.get(sessionId);
    if (owner !== undefined) {
      names.release(owner);
      this.nameOwner.delete(sessionId);
    }

    for (const client of this.clients) {
      const view = client.view as StateView | undefined;
      if (view) view.remove(player);
    }

    this.state.players.delete(sessionId);
    this.viewCache.delete(sessionId);
    this.buckets.delete(sessionId);
    this.stepAccumulator.delete(sessionId);
    this.lastPosition.delete(sessionId);

    this.electHost();
    this.refreshCounts();
    this.publishSummary();
  }

  private refreshCounts(): void {
    let seekers = 0;
    let hiders = 0;
    let aliveHiders = 0;

    for (const player of this.state.players.values()) {
      if (player.role === PlayerRole.Seeker) seekers += 1;
      else if (player.role === PlayerRole.Hider) {
        hiders += 1;
        if (player.alive) aliveHiders += 1;
      }
    }

    this.state.playerCount = this.state.players.size;
    this.state.seekerCount = seekers;
    this.state.hiderCount = hiders;
    this.state.aliveHiders = aliveHiders;
  }

  private announcePhase(): void {
    this.broadcast(ServerMessage.Phase, {
      phase: this.state.phase,
      round: this.state.round,
      winner: this.state.winner,
    });
  }
}

function sanitizeName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, NAME_MAX);
  return cleaned.length >= NAME_MIN ? cleaned : null;
}
