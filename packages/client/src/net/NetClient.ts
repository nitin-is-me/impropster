import { Callbacks, Client, Predict, type Room } from "@colyseus/sdk";
import { resolveRoomCode, serverBase } from "./endpoint";
import {
  applyInput,
  INTERP_DELAY_MS,
  MAP,
  MoveInput,
  type DeniedPayload,
  type EliminatedPayload,
  type FootstepPayload,
  type GameStateInstance,
  type GigglePayload,
  type MoveInputPayload,
  type PhasePayload,
  type PlayerStateInstance,
  type ShatterPayload,
  type ShotPayload,
} from "@impropster/shared";

export interface NetHandlers {
  onPlayerAdd?: (player: PlayerStateInstance, sessionId: string) => void;
  onPlayerRemove?: (player: PlayerStateInstance, sessionId: string) => void;
  onShot?: (payload: ShotPayload) => void;
  onFootstep?: (payload: FootstepPayload) => void;
  onGiggle?: (payload: GigglePayload) => void;
  onShatter?: (payload: ShatterPayload) => void;
  onEliminated?: (payload: EliminatedPayload) => void;
  onPhase?: (payload: PhasePayload) => void;
  onDenied?: (payload: DeniedPayload) => void;
  onMorph?: (payload: { ok: boolean; propId: number }) => void;
  onLeave?: (code: number) => void;
}

/** How the player asked to enter: brand-new room, code, or a listed room. */
export type JoinRequest =
  | { kind: "create"; name: string; isPrivate: boolean }
  | { kind: "code"; name: string; code: string }
  | { kind: "room"; name: string; roomId: string; code: string };

type InputHandle = ReturnType<Room["input"]>;

/**
 * Thin wrapper over the Colyseus SDK: owns the connection, the prediction stack
 * and the input cadence, and exposes a rendering-friendly read API.
 */
export class NetClient {
  room: Room<any, any> | null = null;
  state: GameStateInstance | null = null;
  sessionId = "";

  private client: Client | null = null;
  private predict: Predict<any> | null = null;
  private input: InputHandle | null = null;
  private reconciler: unknown = null;
  private sequence = 0;
  private readonly handlers: NetHandlers = {};

  /** Handlers are merged, so scenes can register before or after connect(). */
  setHandlers(handlers: NetHandlers): void {
    Object.assign(this.handlers, handlers);
  }

  get connected(): boolean {
    return this.state !== null;
  }

  get self(): PlayerStateInstance | null {
    if (!this.state) return null;
    return this.state.players.get(this.sessionId) ?? null;
  }

  /**
   * Enters a specific room. There is no `joinOrCreate` here on purpose: a
   * player always knows whether they are creating a room, typing a code or
   * picking one off the list, and silently landing in a stranger's lobby is a
   * bug, not a convenience.
   */
  async connect(request: JoinRequest): Promise<void> {
    this.client = new Client(serverBase());
    const room = (await this.join(request)) as Room<any, any>;

    this.room = room;
    this.sessionId = room.sessionId;

    // The SDK resolves `joinOrCreate` before the first state patch is decoded,
    // so wait for the initial snapshot before wiring prediction to it.
    this.state = await this.waitForState(room);

    // Prediction stack: remote bodies are interpolated 100ms in the past, the
    // local body is predicted and reconciled against the server's ack.
    this.predict = Predict.get(room, { mode: "lerp", delay: INTERP_DELAY_MS });
    this.predict.attachAll("players", { x: "lerp", y: "lerp", aim: "lerp" });

    this.input = room.input({ type: MoveInput });

    const self = this.state.players.get(this.sessionId);
    if (self && this.input) {
      this.reconciler = this.predict.reconciler(self, {
        input: this.input,
        fields: ["x", "y", "aim", "speedMul"],
        step: (ctx: { dt: number }, state: PlayerStateInstance, command: unknown) =>
          applyInput(state, command as MoveInputPayload, ctx.dt, MAP),
        smoothMs: 65,
      });
    }

    const callbacks = Callbacks.get(room);
    callbacks.onAdd("players", (player: unknown, sessionId: unknown) => {
      this.handlers.onPlayerAdd?.(player as PlayerStateInstance, String(sessionId));
    });
    callbacks.onRemove("players", (player: unknown, sessionId: unknown) => {
      this.handlers.onPlayerRemove?.(player as PlayerStateInstance, String(sessionId));
    });

    room.onMessage("shot", (payload: ShotPayload) => this.handlers.onShot?.(payload));
    room.onMessage("footstep", (payload: FootstepPayload) => this.handlers.onFootstep?.(payload));
    room.onMessage("giggle", (payload: GigglePayload) => this.handlers.onGiggle?.(payload));
    room.onMessage("shatter", (payload: ShatterPayload) => this.handlers.onShatter?.(payload));
    room.onMessage("eliminated", (payload: EliminatedPayload) => this.handlers.onEliminated?.(payload));
    room.onMessage("phase", (payload: PhasePayload) => this.handlers.onPhase?.(payload));
    room.onMessage("denied", (payload: DeniedPayload) => this.handlers.onDenied?.(payload));
    room.onMessage("morphResult", (payload: { ok: boolean; propId: number }) =>
      this.handlers.onMorph?.(payload),
    );

    // Lobby ping: echo the probe immediately, from inside the SDK callback. It
    // must not wait for a frame, or the number would include our own jitter.
    room.onMessage("pingProbe", (payload: { t?: number }) => {
      if (typeof payload?.t === "number") room.send("pong", { t: payload.t });
    });

    room.onLeave((code: number) => {
      // Drop the cached snapshot before notifying: the DOM polls `state` to
      // decide which screen to show, and a stale snapshot would put the player
      // straight back into the lobby they were just ejected from.
      this.state = null;
      this.predict = null;
      this.input = null;
      this.reconciler = null;
      this.handlers.onLeave?.(code);
    });
  }

  private join(request: JoinRequest): Promise<Room<any, any>> {
    const client = this.client;
    if (!client) throw new Error("no-client");

    switch (request.kind) {
      case "create":
        return client.create("match", {
          name: request.name,
          isPrivate: request.isPrivate,
        }) as Promise<Room<any, any>>;

      case "code":
        return resolveRoomCode(request.code).then(
          (roomId) =>
            client.joinById(roomId, {
              name: request.name,
              code: request.code,
            }) as Promise<Room<any, any>>,
        );

      case "room":
        return client.joinById(request.roomId, {
          name: request.name,
          code: request.code,
        }) as Promise<Room<any, any>>;

      default:
        throw new Error("unsupported-join");
    }
  }

  private waitForState(room: Room<any, any>, timeoutMs = 6000): Promise<GameStateInstance> {
    const started = performance.now();

    return new Promise((resolve, reject) => {
      const poll = () => {
        const state = room.state as GameStateInstance | undefined;
        // The initial patch also has to contain our own player entry, otherwise
        // we would wire prediction to an empty state.
        if (state && state.players && state.players.get(room.sessionId)) {
          resolve(state);
          return;
        }
        if (performance.now() - started > timeoutMs) {
          reject(new Error("Timed out waiting for the initial room state"));
          return;
        }
        window.setTimeout(poll, 16);
      };

      poll();
    });
  }

  /**
   * Advances prediction once per rendered frame and emits the fixed-rate input
   * frames the server expects. Returns how many simulation steps were consumed.
   */
  tick(now: number, intent: { moveX: number; moveY: number; aim: number }): number {
    if (!this.predict || !this.input) return 0;

    const steps = this.predict.tick(now);

    for (let i = 0; i < steps; i++) {
      const data = this.input.data as MoveInputPayload;
      data.moveX = intent.moveX;
      data.moveY = intent.moveY;
      data.aim = intent.aim;
      data.seq = ++this.sequence;
      this.input.send();
    }

    return steps;
  }

  /** Interpolated/predicted render position for any player. */
  renderX(player: PlayerStateInstance): number {
    const value = this.predict?.value(player, "x");
    return Number.isFinite(value) ? (value as number) : Number(player.x);
  }

  renderY(player: PlayerStateInstance): number {
    const value = this.predict?.value(player, "y");
    return Number.isFinite(value) ? (value as number) : Number(player.y);
  }

  renderAim(player: PlayerStateInstance): number {
    const value = this.predict?.value(player, "aim");
    return Number.isFinite(value) ? (value as number) : Number(player.aim);
  }

  sendFire(aim: number): void {
    this.room?.send("fire", { aim });
  }

  sendReload(): void {
    this.room?.send("reload");
  }

  sendMorph(): void {
    this.room?.send("morph");
  }

  sendToggleLock(): void {
    this.room?.send("lock");
  }

  /** Host only; the server ignores it from anyone else. */
  sendStart(): void {
    this.room?.send("start");
  }

  /** Host only: match length in rounds (odd, 1–9). */
  sendRounds(rounds: number): void {
    this.room?.send("rounds", { rounds });
  }

  disconnect(): void {
    this.room?.leave();
    this.room = null;
    this.state = null;
    this.predict = null;
    this.input = null;
    this.reconciler = null;
  }
}
