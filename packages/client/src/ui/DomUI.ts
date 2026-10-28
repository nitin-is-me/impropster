import {
  NAME_MAX,
  NAME_MIN,
  Phase,
  PlayerRole,
  Winner,
  type GameStateInstance,
} from "@impropster/shared";
import type { JoinRequest, NetClient } from "../net/NetClient";
import { fetchPublicRooms, type PublicRoom } from "../net/endpoint";

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
}

/** How often the landing page re-reads the public room list. */
const ROOM_REFRESH_MS = 4000;

interface RosterRow {
  id: string;
  name: string;
  ping: number;
  host: boolean;
  self: boolean;
  online: boolean;
  team: number;
}

/**
 * DOM chrome: the parts of the game that are text and buttons. Phaser owns the
 * playfield and the in-game HUD; HTML owns forms, rosters and scoreboards.
 */
export class DomUI {
  // ---- landing ------------------------------------------------------------
  private readonly menu = el("screen-menu");
  private readonly nameInput = el<HTMLInputElement>("input-name");
  private readonly codeInput = el<HTMLInputElement>("input-code");
  private readonly createPrivate = el<HTMLButtonElement>("btn-create-private");
  private readonly createPublic = el<HTMLButtonElement>("btn-create-public");
  private readonly joinCodeButton = el<HTMLButtonElement>("btn-join-code");
  private readonly refreshButton = el<HTMLButtonElement>("btn-refresh-rooms");
  private readonly roomList = el("room-list");
  private readonly menuError = el("menu-error");

  // ---- lobby --------------------------------------------------------------
  private readonly lobby = el("screen-lobby");
  private readonly lobbyCode = el("lobby-code");
  private readonly lobbyVisibility = el("lobby-visibility");
  private readonly lobbyCount = el("lobby-count");
  private readonly lobbyStatus = el("lobby-status");
  private readonly lobbyRoster = el("lobby-roster");
  private readonly lobbyHint = el("lobby-hint");
  private readonly startButton = el<HTMLButtonElement>("btn-start");
  private readonly copyButton = el<HTMLButtonElement>("btn-copy-code");
  private readonly leaveButton = el<HTMLButtonElement>("btn-leave");
  private readonly roundsSelect = el<HTMLSelectElement>("select-rounds");
  private readonly roundsMeta = el("rounds-meta");

  // ---- team card ----------------------------------------------------------
  private readonly teamsScreen = el("screen-teams");
  private readonly teamsEyebrow = el("teams-eyebrow");
  private readonly teamsCountdown = el("teams-countdown");
  private readonly teamACol = el("team-a");
  private readonly teamBCol = el("team-b");
  private readonly teamARole = el("team-a-role");
  private readonly teamBRole = el("team-b-role");
  private readonly teamAList = el("team-a-list");
  private readonly teamBList = el("team-b-list");

  // ---- results ------------------------------------------------------------
  private readonly results = el("screen-results");
  private readonly resultsTitle = el("results-title");
  private readonly resultsEyebrow = el("results-eyebrow");
  private readonly resultsScore = el("results-score");
  private readonly resultsBoard = el("results-board");
  private readonly resultsNext = el("results-next");
  private readonly resultsLeave = el<HTMLButtonElement>("btn-results-leave");

  private readonly toastEl = el("toast");
  private readonly connectionEl = el("connection");

  private connected = false;
  private busy = false;
  private roomsLoading = false;
  private lastRoomFetch = 0;
  private rosterSignature = "";
  private toastTimer = 0;

  constructor(
    private readonly net: NetClient,
    private readonly join: (request: JoinRequest) => Promise<void>,
  ) {
    // Invite links carry the code: /?code=X7K9 pre-fills the join field.
    const inviteCode = new URLSearchParams(window.location.search).get("code");
    if (inviteCode) this.codeInput.value = inviteCode.toUpperCase().slice(0, 4);

    this.createPrivate.addEventListener("click", () => void this.createRoom(true));
    this.createPublic.addEventListener("click", () => void this.createRoom(false));
    this.joinCodeButton.addEventListener("click", () => void this.joinByCode());
    this.refreshButton.addEventListener("click", () => void this.refreshRooms(true));
    this.startButton.addEventListener("click", () => this.net.sendStart());
    this.copyButton.addEventListener("click", () => void this.copyCode());
    this.leaveButton.addEventListener("click", () => this.leave());
    this.resultsLeave.addEventListener("click", () => this.leave());

    this.nameInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") void this.createRoom(true);
    });

    // Round count is a host decision made in the lobby, not at creation: the
    // host can size the match once they know who turned up.
    this.roundsSelect.addEventListener("change", () => {
      this.net.sendRounds(Number(this.roundsSelect.value));
    });

    this.codeInput.addEventListener("input", () => {
      this.codeInput.value = this.codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
    });
    this.codeInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") void this.joinByCode();
    });

    this.applyPhase(Phase.Lobby);
    void this.refreshRooms(true);
  }

  // ---------------------------------------------------------------- landing

  /**
   * The typed name, or null after surfacing why it was rejected. There is no
   * fallback: a seat has to be taken deliberately, and an empty field would
   * otherwise land someone in a room as "Anonymous Chair".
   */
  private playerName(): string | null {
    const name = this.nameInput.value.replace(/\s+/g, " ").trim();

    if (name.length < NAME_MIN) {
      this.setError(`Type a name of at least ${NAME_MIN} characters to take a seat.`);
      this.nameInput.focus();
      return null;
    }

    return name.slice(0, NAME_MAX);
  }

  private createRoom(isPrivate: boolean): Promise<void> {
    const name = this.playerName();
    if (name === null) return Promise.resolve();
    return this.submit({ kind: "create", name, isPrivate });
  }

  private joinByCode(): Promise<void> {
    const code = this.codeInput.value.trim().toUpperCase();
    if (code.length < 4) {
      this.setError("Room codes are four characters.");
      return Promise.resolve();
    }

    const name = this.playerName();
    if (name === null) return Promise.resolve();
    return this.submit({ kind: "code", name, code });
  }

  private async submit(request: JoinRequest): Promise<void> {
    if (this.busy) return;

    this.busy = true;
    this.setError("");
    this.syncButtons();

    try {
      await this.join(request);
      this.connected = true;
      this.menu.classList.add("hidden");
      // Switch screens now rather than waiting for the next poll: a background
      // tab throttles timers, and an empty screen for a second looks broken.
      this.applyPhase(this.net.state?.phase ?? Phase.Lobby);
      this.update();
    } catch (error) {
      this.setError(this.describeError(error));
    } finally {
      this.busy = false;
      this.syncButtons();
    }
  }

  private describeError(error: unknown): string {
    const raw = error instanceof Error ? error.message : String(error);
    const message = raw.replace(/^\d{3}[:\s-]+/, "").trim();

    // Names are claimed game-wide; this is the one rejection a player will see
    // often enough that it needs plain words rather than a code.
    if (/name-taken/i.test(raw)) return "That name is already in use. Pick a different one.";
    if (/name-invalid/i.test(raw)) return `Names need ${NAME_MIN}–${NAME_MAX} characters.`;
    if (/in progress/i.test(raw)) return "That match has already started.";
    if (/not-found/i.test(message)) return "No room with that code. Check the letters.";
    if (/failed to fetch|networkerror|websocket|econnrefused|load failed|aborted/i.test(message)) {
      return "Could not reach the server. Is it running?";
    }
    return message || "Something went wrong.";
  }

  private setError(message: string): void {
    this.menuError.textContent = message;
    this.menuError.classList.toggle("hidden", message === "");
  }

  private syncButtons(): void {
    this.createPrivate.disabled = this.busy;
    this.createPublic.disabled = this.busy;
    this.joinCodeButton.disabled = this.busy;
    this.createPrivate.textContent = this.busy ? "Connecting…" : "Create private room";
  }

  private async refreshRooms(force = false): Promise<void> {
    if (this.roomsLoading) return;
    if (!force && performance.now() - this.lastRoomFetch < ROOM_REFRESH_MS) return;

    this.roomsLoading = true;
    this.lastRoomFetch = performance.now();

    try {
      this.renderRooms(await fetchPublicRooms(), false);
    } catch {
      this.renderRooms([], true);
    } finally {
      this.roomsLoading = false;
    }
  }

  private renderRooms(rooms: PublicRoom[], offline: boolean): void {
    this.roomList.innerHTML = "";

    if (rooms.length === 0) {
      const empty = document.createElement("p");
      empty.className = "rooms__empty";
      empty.textContent = offline
        ? "Server unreachable — is it running?"
        : "No open public rooms. Create one.";
      this.roomList.appendChild(empty);
      return;
    }

    for (const room of rooms) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "room";

      const host = document.createElement("span");
      host.className = "room__host";
      host.textContent = `${room.hostName || "Someone"}'s manor`;

      const meta = document.createElement("span");
      meta.className = "room__meta";
      meta.textContent = `${room.code} · ${room.players}/${room.maxPlayers}`;

      button.append(host, meta);
      button.addEventListener("click", () => {
        const name = this.playerName();
        if (name === null) return;
        void this.submit({ kind: "room", name, roomId: room.roomId, code: room.code });
      });

      this.roomList.appendChild(button);
    }
  }

  // ------------------------------------------------------------------ lobby

  private renderLobby(state: GameStateInstance): void {
    this.lobbyCode.textContent = state.roomCode || "----";
    this.lobbyVisibility.textContent = state.isPrivate
      ? "Private room — share the code to invite."
      : "Public room — listed on the landing page.";

    const count = state.playerCount;
    const min = state.minPlayers;
    const isHost = state.hostId !== "" && state.hostId === this.net.sessionId;
    const starting = state.lobbyMs > 0;

    this.lobbyCount.textContent = `${count} / ${state.maxPlayers}`;

    if (starting) {
      this.lobbyStatus.textContent = `Starting in ${Math.ceil(state.lobbyMs / 1000)}…`;
    } else if (count < min) {
      const missing = min - count;
      this.lobbyStatus.textContent = `Waiting for ${missing} more player${missing === 1 ? "" : "s"}…`;
    } else {
      this.lobbyStatus.textContent = isHost
        ? "Everyone's here — start when ready."
        : "Waiting for the host to start…";
    }

    this.startButton.classList.toggle("hidden", !isHost);
    this.startButton.disabled = !isHost || count < min || starting;
    this.startButton.textContent = starting ? "Starting…" : "Start match";

    const rounds = Number(state.roundsTotal);
    if (this.roundsSelect.value !== String(rounds)) this.roundsSelect.value = String(rounds);
    this.roundsSelect.disabled = !isHost || starting;

    const legs = rounds * 2;
    this.roundsMeta.textContent = isHost
      ? `You choose. ${rounds} round${rounds === 1 ? "" : "s"} = ${legs} legs; both teams hide and seek once per round.`
      : `The host picked ${rounds} round${rounds === 1 ? "" : "s"} (${legs} legs).`;

    if (count < min) {
      this.lobbyHint.textContent = `A match needs at least ${min} players.`;
    } else {
      this.lobbyHint.textContent = `Teams are fixed for the match; roles swap every leg.`;
    }

    this.renderRoster(state);
  }

  private renderRoster(state: GameStateInstance): void {
    const rows: RosterRow[] = [];

    for (const [id, player] of state.players) {
      rows.push({
        id,
        name: player.name || "Player",
        ping: Number(player.ping),
        host: id === state.hostId,
        self: id === this.net.sessionId,
        online: player.connected !== false,
        team: player.team,
      });
    }

    rows.sort((a, b) => {
      if (a.host !== b.host) return a.host ? -1 : 1;
      if (a.self !== b.self) return a.self ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    // The roster refreshes eight times a second; only rebuild it when a value
    // that is actually rendered has changed.
    const signature = rows
      .map(
        (row) =>
          `${row.id}:${row.name}:${row.ping}:${row.host ? "h" : ""}:${row.online ? "" : "x"}:${row.team}`,
      )
      .join("|");
    if (signature === this.rosterSignature) return;
    this.rosterSignature = signature;

    this.lobbyRoster.innerHTML = "";

    for (const row of rows) {
      const rowEl = document.createElement("div");
      rowEl.className = "roster__row";
      if (row.self) rowEl.classList.add("roster__row--self");
      if (!row.online) rowEl.classList.add("roster__row--offline");

      const name = document.createElement("span");
      name.className = "roster__name";
      name.textContent = row.name;
      if (row.self) {
        const you = document.createElement("em");
        you.textContent = " (you)";
        name.appendChild(you);
      }

      const team = document.createElement("span");
      team.className = `roster__team roster__team--${row.team === 0 ? "a" : "b"}`;
      team.textContent = row.team === 0 ? "A" : "B";

      const tag = document.createElement("span");
      tag.className = "roster__tag";
      tag.textContent = row.host ? "Host" : "";

      const ping = document.createElement("span");
      ping.className = "roster__ping";
      ping.textContent = !row.online ? "away" : row.ping > 0 ? `${row.ping} ms` : "…";

      rowEl.append(name, team, tag, ping);
      this.lobbyRoster.appendChild(rowEl);
    }
  }

  private async copyCode(): Promise<void> {
    const code = this.net.state?.roomCode ?? "";
    if (!code) return;

    try {
      await navigator.clipboard.writeText(code);
      this.toast(`Code ${code} copied`);
    } catch {
      this.toast(`Room code: ${code}`);
    }
  }

  private leave(): void {
    this.net.disconnect();
    this.handleDisconnect("Left the room");
  }

  /** Returns to the landing page; also the fallback when the socket drops. */
  handleDisconnect(message = "Disconnected from the manor"): void {
    if (!this.connected) return;

    this.connected = false;
    this.busy = false;
    this.rosterSignature = "";
    this.menu.classList.remove("hidden");
    this.lobby.classList.add("hidden");
    this.results.classList.add("hidden");
    this.setError("");
    this.syncButtons();
    this.toast(message);
    void this.refreshRooms(true);
  }

  // --------------------------------------------------------------- lifecycle

  setConnectionBanner(visible: boolean): void {
    this.connectionEl.classList.toggle("hidden", !visible);
  }

  toast(message: string): void {
    this.toastEl.textContent = message;
    this.toastEl.classList.remove("hidden");
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toastEl.classList.add("hidden"), 2600);
  }

  /** Called on a timer; the DOM only needs a few refreshes per second. */
  update(): void {
    const state = this.net.state;

    if (!state) {
      if (!this.connected && !this.busy) void this.refreshRooms();
      return;
    }

    this.connected = true;

    // Screen visibility is derived from state every tick: a patch can land in
    // the middle of connect(), so "only on phase change" can miss the flip.
    this.applyPhase(state.phase);

    if (state.phase === Phase.Lobby) this.renderLobby(state);
    if (state.phase === Phase.Teams) this.renderTeams(state);
    if (state.phase === Phase.Results) this.renderResults(state);
  }

  private applyPhase(phase: number): void {
    const inLobby = this.connected && phase === Phase.Lobby;
    const inTeams = this.connected && phase === Phase.Teams;
    const inResults = this.connected && phase === Phase.Results;

    this.menu.classList.toggle("hidden", this.connected);
    this.lobby.classList.toggle("hidden", !inLobby);
    this.teamsScreen.classList.toggle("hidden", !inTeams);
    this.results.classList.toggle("hidden", !inResults);
  }

  /** Five-second card before each leg: who is on which side, and which way. */
  private renderTeams(state: GameStateInstance): void {
    this.teamsEyebrow.textContent = `Round ${state.round} of ${state.roundsTotal} · leg ${state.leg + 1}`;

    const seekingA = state.seekingTeam === 0;
    this.teamARole.textContent = seekingA ? "Seeking" : "Hiding";
    this.teamBRole.textContent = seekingA ? "Hiding" : "Seeking";
    this.teamARole.dataset["role"] = seekingA ? "seeker" : "hider";
    this.teamBRole.dataset["role"] = seekingA ? "hider" : "seeker";

    const mine = this.teamOfSelf(state);
    this.teamACol.classList.toggle("team--you", mine === 0);
    this.teamBCol.classList.toggle("team--you", mine === 1);

    const lists: [HTMLElement, number][] = [
      [this.teamAList, 0],
      [this.teamBList, 1],
    ];
    for (const [list, team] of lists) {
      const names = [...state.players.entries()]
        .filter(([, player]) => player.team === team)
        .map(([id, player]) => `${player.name || "Player"}${id === this.net.sessionId ? " (you)" : ""}`);

      const signature = names.join("|");
      if (list.dataset["signature"] === signature) continue;
      list.dataset["signature"] = signature;
      list.innerHTML = "";

      for (const name of names) {
        const row = document.createElement("span");
        row.className = "team__member";
        row.textContent = name;
        list.appendChild(row);
      }
    }

    this.teamsCountdown.textContent = `Hiding starts in ${Math.max(1, Math.ceil(state.phaseMs / 1000))}…`;
    void state;
  }

  private teamOfSelf(state: GameStateInstance): number {
    return state.players.get(this.net.sessionId)?.team ?? -1;
  }

  private renderResults(state: GameStateInstance): void {
    const winnerTeam = state.winner === Winner.Seekers ? state.seekingTeam : 1 - state.seekingTeam;

    this.resultsEyebrow.textContent = `Round ${state.round} of ${state.roundsTotal} · leg ${state.leg + 1}`;
    this.resultsScore.textContent = `Team A ${state.teamAScore} — ${state.teamBScore} Team B`;

    this.resultsTitle.textContent = state.matchOver
      ? state.matchWinner === 1
        ? "Team A wins the match"
        : "Team B wins the match"
      : `Team ${winnerTeam === 0 ? "A" : "B"} takes the leg`;

    // Rebuild only when the scoreboard content actually changed.
    const rows = [...state.players.entries()]
      .map(([id, player]) => ({
        id,
        name: player.name || "Player",
        score: Number(player.score),
        role: player.role,
        alive: player.alive,
        team: player.team,
      }))
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

    const signature = rows
      .map((row) => `${row.id}:${row.name}:${row.score}:${row.role}:${row.alive}:${row.team}`)
      .join("|");
    if (this.resultsBoard.dataset["signature"] !== signature) {
      this.resultsBoard.dataset["signature"] = signature;
      this.resultsBoard.innerHTML = "";

      for (const row of rows) {
        const rowEl = document.createElement("div");
        rowEl.className = `board__row${row.id === this.net.sessionId ? " board__row--self" : ""}`;

        const name = document.createElement("span");
        name.textContent = row.name;

        const tag = document.createElement("span");
        tag.className = "board__tag";
        const role =
          row.role === PlayerRole.Seeker
            ? "Seeker"
            : row.role === PlayerRole.Hider
              ? row.alive
                ? "Survived"
                : "Found"
              : "—";
        tag.textContent = `${row.team === 0 ? "A" : "B"} · ${role}`;

        const score = document.createElement("span");
        score.className = "board__score";
        score.textContent = String(row.score);

        rowEl.append(name, tag, score);
        this.resultsBoard.appendChild(rowEl);
      }
    }

    const seconds = Math.max(0, Math.ceil(state.phaseMs / 1000));
    this.resultsNext.textContent = state.matchOver
      ? `Back to the lobby in ${seconds}s…`
      : `Next leg in ${seconds}s…`;
  }
}
