import Phaser from "phaser";
import {
  MAG_SIZE,
  MAP,
  type PlayerStateInstance,
  Phase,
  PlayerForm,
  PlayerRole,
  TILE,
  type DeniedPayload,
  type EliminatedPayload,
  type GigglePayload,
  type ShatterPayload,
} from "@impropster/shared";
import type { NetClient } from "../net/NetClient";
import { TEX } from "../render/textures";
import { hudBarHeight } from "../render/layout";

/**
 * How long a sound clue stays on screen. A giggle fires roughly every 30–40
 * seconds and is the single most important piece of information a seeker gets,
 * so it gets a long, legible readout rather than a blink.
 */
const CLUE_MS = 2500;
const GIGGLE_COLOR = 0xe8563c;
const SHATTER_COLOR = 0xd1573f;

interface Ripple {
  x: number;
  y: number;
  born: number;
  color: number;
}

interface Notice {
  text: string;
  color: string;
  born: number;
}

const MINIMAP_W = 150;
const MINIMAP_H = 105;
const MINIMAP_SCALE = MINIMAP_W / MAP.width;
/** Kill-feed lines live this long before the next one takes their place. */
const KILL_FEED_MS = 4500;
const KILL_FEED_MAX = 4;

const PHASE_LABEL: Record<number, string> = {
  [Phase.Lobby]: "Lobby",
  [Phase.Teams]: "Teams",
  [Phase.Hide]: "Hide",
  [Phase.Hunt]: "Hunt",
  [Phase.Results]: "Results",
};

interface FeedLine {
  text: string;
  born: number;
  highlight: boolean;
}

export class HudScene extends Phaser.Scene {
  private net!: NetClient;

  private timerText?: Phaser.GameObjects.Text;
  private phaseText?: Phaser.GameObjects.Text;
  private roleText?: Phaser.GameObjects.Text;
  private hintText?: Phaser.GameObjects.Text;
  private ammoText?: Phaser.GameObjects.Text;
  private lockoutText?: Phaser.GameObjects.Text;
  private blindText?: Phaser.GameObjects.Text;

  private weaponGfx?: Phaser.GameObjects.Graphics;
  private statusGfx?: Phaser.GameObjects.Graphics;
  private minimapGfx?: Phaser.GameObjects.Graphics;
  private minimapBase?: Phaser.GameObjects.Graphics;
  private edgeGfx?: Phaser.GameObjects.Graphics;
  private crosshair?: Phaser.GameObjects.Graphics;
  private vignette?: Phaser.GameObjects.Image;
  private blindOverlay?: Phaser.GameObjects.Rectangle;

  private ripples: Ripple[] = [];
  private notices: Notice[] = [];
  private readonly feed: FeedLine[] = [];
  private readonly feedTexts: Phaser.GameObjects.Text[] = [];
  private barGfx?: Phaser.GameObjects.Graphics;
  private barTop = 0;
  private blind = false;
  private threat = 0;

  constructor() {
    super("hud");
  }

  create(): void {
    this.net = this.registry.get("net") as NetClient;

    this.vignette = this.add.image(0, 0, TEX.vignette).setOrigin(0, 0).setAlpha(0).setDepth(5);
    this.barGfx = this.add.graphics().setDepth(6);
    this.minimapBase = this.add.graphics().setDepth(10);
    this.minimapGfx = this.add.graphics().setDepth(11);
    this.weaponGfx = this.add.graphics().setDepth(12);
    this.statusGfx = this.add.graphics().setDepth(12);
    this.edgeGfx = this.add.graphics().setDepth(13);
    this.crosshair = this.add.graphics().setDepth(20);

    this.timerText = this.add
      .text(0, 0, "--:--", { fontFamily: "Trebuchet MS", fontSize: "26px", color: "#f2ece1" })
      .setOrigin(0.5, 0)
      .setDepth(14);

    this.phaseText = this.add
      .text(0, 0, "", { fontFamily: "Trebuchet MS", fontSize: "12px", color: "#a89f92" })
      .setOrigin(0.5, 0)
      .setDepth(14);

    this.roleText = this.add
      .text(0, 0, "", { fontFamily: "Trebuchet MS", fontSize: "15px", color: "#e0a458" })
      .setOrigin(0, 0)
      .setDepth(14);

    this.hintText = this.add
      .text(0, 0, "", { fontFamily: "Trebuchet MS", fontSize: "12px", color: "#a89f92" })
      .setOrigin(0, 0)
      .setDepth(14);

    this.ammoText = this.add
      .text(0, 0, "", { fontFamily: "Trebuchet MS", fontSize: "13px", color: "#a89f92" })
      .setOrigin(1, 1)
      .setDepth(14);

    this.lockoutText = this.add
      .text(0, 0, "", { fontFamily: "Trebuchet MS", fontSize: "13px", color: "#d1573f" })
      .setOrigin(1, 1)
      .setDepth(14);

    this.blindOverlay = this.add.rectangle(0, 0, 10, 10, 0x000000, 1).setOrigin(0, 0).setDepth(18).setVisible(false);
    this.blindText = this.add
      .text(0, 0, "You are blind until the hunt begins", {
        fontFamily: "Trebuchet MS",
        fontSize: "18px",
        color: "#f2ece1",
      })
      .setOrigin(0.5)
      .setDepth(19)
      .setVisible(false);

    this.layout();
    this.scale.on("resize", () => this.layout());

    this.game.events.on("hud:giggle", this.onGiggle, this);
    this.game.events.on("hud:shatter", this.onShatter, this);
    this.game.events.on("hud:eliminated", this.onEliminated, this);
    this.game.events.on("hud:denied", this.onDenied, this);
    this.game.events.on("hud:blind", (visible: boolean) => {
      this.blind = visible;
    });

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.game.events.off("hud:giggle", this.onGiggle, this);
      this.game.events.off("hud:shatter", this.onShatter, this);
      this.game.events.off("hud:eliminated", this.onEliminated, this);
      this.game.events.off("hud:denied", this.onDenied, this);
    });
  }

  // ---------------------------------------------------------------- layout

  private layout(): void {
    const w = this.scale.width;
    const h = this.scale.height;
    const bar = hudBarHeight(h);
    this.barTop = h - bar;

    this.timerText?.setPosition(w / 2, 16);
    this.phaseText?.setPosition(w / 2, 48);
    this.roleText?.setPosition(20, 18);
    this.hintText?.setPosition(20, 40);
    this.ammoText?.setPosition(w - 20, h - 16);
    this.lockoutText?.setPosition(w - 20, h - 40);

    // Overlays stop at the bar so the chrome never dims the HUD itself.
    this.vignette?.setDisplaySize(w, this.barTop);
    this.blindOverlay?.setSize(w, this.barTop).setPosition(0, 0);
    this.blindText?.setPosition(w / 2, this.barTop / 2);

    this.drawBar(w, bar);
    this.drawMinimapBase(w, h);
  }

  /** Reserved chrome strip below the play area. */
  private drawBar(w: number, bar: number): void {
    const g = this.barGfx;
    if (!g) return;

    g.clear();
    g.fillStyle(0x080b11, 0.97);
    g.fillRect(0, this.barTop, w, bar);
    g.fillStyle(0xe0a458, 0.16);
    g.fillRect(0, this.barTop, w, 1);
  }

  private drawMinimapBase(w: number, h: number): void {
    const g = this.minimapBase;
    if (!g) return;

    const originX = 20;
    const originY = this.barTop + Math.max(10, (h - this.barTop - MINIMAP_H) / 2);
    g.clear();

    g.fillStyle(0x0b0f15, 0.82);
    g.fillRoundedRect(originX - 6, originY - 6, MINIMAP_W + 12, MINIMAP_H + 12, 6);
    g.lineStyle(1, 0x2c333d, 1);
    g.strokeRoundedRect(originX - 6, originY - 6, MINIMAP_W + 12, MINIMAP_H + 12, 6);

    g.fillStyle(0x39424f, 0.9);
    for (let ty = 0; ty < MAP.rows; ty++) {
      for (let tx = 0; tx < MAP.cols; tx++) {
        if (MAP.walls[ty * MAP.cols + tx] !== 1) continue;
        g.fillRect(
          originX + tx * TILE * MINIMAP_SCALE,
          originY + ty * TILE * MINIMAP_SCALE,
          TILE * MINIMAP_SCALE + 0.6,
          TILE * MINIMAP_SCALE + 0.6,
        );
      }
    }

    // Store the origin for the dynamic pass.
    this.minimapOrigin = { x: originX, y: originY };
    void w;
  }

  private minimapOrigin = { x: 0, y: 0 };

  // ---------------------------------------------------------------- events

  private onGiggle(payload: GigglePayload): void {
    this.ripples.push({ x: payload.x, y: payload.y, born: this.time.now, color: GIGGLE_COLOR });
    this.pushNotice("A hider giggled", "#e0a458");
  }

  private onShatter(payload: ShatterPayload): void {
    this.ripples.push({ x: payload.x, y: payload.y, born: this.time.now, color: SHATTER_COLOR });
    this.pushNotice("Disguise shattered!", "#d1573f");
  }

  private onEliminated(payload: EliminatedPayload): void {
    const killer = payload.killerName || "Someone";
    const victim = payload.victimName || "a hider";
    const mine = this.net.self?.name ?? "";

    this.feed.push({
      text: `${killer} eliminated ${victim}`,
      born: this.time.now,
      highlight: killer === mine && mine !== "",
    });
    if (this.feed.length > KILL_FEED_MAX) this.feed.shift();

    this.pushNotice("A hider was eliminated", "#7fb3a3");
  }

  /**
   * Kill feed in the top-right corner: newest first, fading out on its own. It
   * is deliberately small and out of the way — it is information, not an event.
   */
  private drawKillFeed(time: number, visible: boolean): void {
    if (!visible) {
      for (const text of this.feedTexts) text.setVisible(false);
      return;
    }

    while (this.feed.length > 0 && (time - (this.feed[0]?.born ?? 0)) / KILL_FEED_MS >= 1) {
      this.feed.shift();
    }

    const w = this.scale.width;
    const top = 78;

    for (let i = 0; i < KILL_FEED_MAX; i++) {
      let text = this.feedTexts[i];
      // Newest at the top of the stack.
      const entry = this.feed[this.feed.length - 1 - i];

      if (!entry) {
        text?.setVisible(false);
        continue;
      }

      if (!text) {
        text = this.add
          .text(0, 0, "", { fontFamily: "Trebuchet MS", fontSize: "12.5px", color: "#f2ece1" })
          .setOrigin(1, 0)
          .setDepth(16);
        this.feedTexts[i] = text;
      }

      const age = (time - entry.born) / KILL_FEED_MS;
      const alpha = age < 0.06 ? age / 0.06 : age > 0.78 ? (1 - age) / 0.22 : 1;

      text
        .setText(entry.text)
        .setColor(entry.highlight ? "#e0a458" : "#d8d2c6")
        .setAlpha(Phaser.Math.Clamp(alpha, 0, 1))
        .setPosition(w - 18, top + i * 19)
        .setVisible(true);
    }
  }

  private onDenied(payload: DeniedPayload): void {
    if (payload.reason === "no-prop") this.pushNotice("Nothing to morph into", "#a89f92");
  }

  private pushNotice(text: string, color: string): void {
    this.notices.push({ text, color, born: this.time.now });
    if (this.notices.length > 4) this.notices.shift();
  }

  // ----------------------------------------------------------------- frame

  override update(time: number): void {
    const net = this.net;
    const state = net.state;
    const self = net.self;

    if (!state || !self) {
      this.timerText?.setText("");
      this.phaseText?.setText("");
      this.roleText?.setText("");
      this.hintText?.setText("");
      this.ammoText?.setText("");
      return;
    }

    const phase = state.phase;
    const playing = phase === Phase.Hide || phase === Phase.Hunt;

    this.updateTimer(state.phase, state.phaseMs);
    this.updateRole(self.role, self.form, self.alive);
    this.updateWeapon(self, phase);
    const showHud = playing || phase === Phase.Results;

    this.threat = self.threat;
    this.drawMinimap(time, net.renderX(self) / MAP.width, net.renderY(self) / MAP.height);
    this.drawEdges(time);
    this.drawCrosshair();
    this.drawNotices(time);
    this.drawKillFeed(time, showHud);

    this.blindOverlay?.setVisible(this.blind && playing);
    this.blindText?.setVisible(this.blind && playing);

    this.vignette?.setAlpha(self.alive ? Math.min(0.62, self.threat * 0.62 + 0.04 * Math.sin(time / 180)) : 0);

    this.setHudVisible(showHud);
  }

  private setHudVisible(visible: boolean): void {
    this.timerText?.setVisible(visible);
    this.phaseText?.setVisible(visible);
    this.roleText?.setVisible(visible);
    this.hintText?.setVisible(visible);
    this.ammoText?.setVisible(visible);
    this.lockoutText?.setVisible(visible);
    this.minimapBase?.setVisible(visible);
    this.minimapGfx?.setVisible(visible);
    this.weaponGfx?.setVisible(visible);
    this.crosshair?.setVisible(visible);
  }

  private updateTimer(phase: number, remainingMs: number): void {
    const seconds = Math.max(0, Math.ceil(remainingMs / 1000));
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    this.timerText?.setText(`${mins}:${secs.toString().padStart(2, "0")}`);
    this.phaseText?.setText(PHASE_LABEL[phase]?.toUpperCase() ?? "");
    this.timerText?.setColor(phase === Phase.Hunt && seconds <= 20 ? "#d1573f" : "#f2ece1");
  }

  private updateRole(role: number, form: number, alive: boolean): void {
    if (role === PlayerRole.Seeker) {
      this.roleText?.setText("SEEKER").setColor("#5c86a8");
      this.hintText?.setText("100° cone · 6 rounds · misses cost 2s");
    } else if (role === PlayerRole.Hider) {
      const disguised = form === PlayerForm.Prop;
      this.roleText?.setText(disguised ? "DISGUISED" : "HIDER").setColor(disguised ? "#7fb3a3" : "#e0a458");
      this.hintText?.setText(
        disguised ? "Stay still. Hold Space to lock." : "Walk into furniture and press F",
      );
    } else {
      this.roleText?.setText("");
      this.hintText?.setText("");
    }

    if (!alive) {
      this.roleText?.setText("SPECTATING").setColor("#a89f92");
      this.hintText?.setText("You were eliminated — watching the rest of the round");
    }
  }

  private updateWeapon(self: PlayerStateInstance, phase: number): void {
    const g = this.weaponGfx;
    if (!g) return;
    g.clear();

    if (self.role !== PlayerRole.Seeker) {
      this.ammoText?.setText("");
      this.lockoutText?.setText("");
      return;
    }

    const w = this.scale.width;
    const h = this.scale.height;
    const baseY = h - 22;
    const pipGap = 14;
    const startX = w - 24 - (MAG_SIZE - 1) * pipGap;

    for (let i = 0; i < MAG_SIZE; i++) {
      const filled = i < self.ammo;
      g.fillStyle(filled ? 0xe0a458 : 0x2a303a, filled ? 1 : 0.85);
      g.fillRoundedRect(startX + i * pipGap - 4, baseY - 8, 8, 14, 2);
    }

    if (self.reloading) {
      const progress = 1 - self.reloadMs / 2500;
      g.fillStyle(0x2a303a, 0.9);
      g.fillRect(w - 24 - 84, baseY - 22, 84, 4);
      g.fillStyle(0x7fb3a3, 1);
      g.fillRect(w - 24 - 84, baseY - 22, 84 * Phaser.Math.Clamp(progress, 0, 1), 4);
      this.ammoText?.setText("RELOADING");
    } else {
      this.ammoText?.setText(self.ammo === 0 ? "EMPTY — R" : `${self.ammo} / ${MAG_SIZE}`);
    }

    if (self.lockoutMs > 0) {
      this.lockoutText?.setText(`LOCKED ${(self.lockoutMs / 1000).toFixed(1)}s`);
      const width = 120;
      const ratio = Phaser.Math.Clamp(self.lockoutMs / 2000, 0, 1);
      g.fillStyle(0x2a303a, 0.9);
      g.fillRect(w - 24 - width, h - 58, width, 4);
      g.fillStyle(0xd1573f, 1);
      g.fillRect(w - 24 - width, h - 58, width * ratio, 4);
    } else {
      this.lockoutText?.setText("");
    }

    void phase;
  }

  private drawMinimap(time: number, nx: number, ny: number): void {
    const g = this.minimapGfx;
    if (!g) return;

    g.clear();
    const origin = this.minimapOrigin;

    const selfX = origin.x + nx * MINIMAP_W;
    const selfY = origin.y + ny * MINIMAP_H;

    g.fillStyle(0x9fe0c8, 1);
    g.fillCircle(selfX, selfY, 3);

    g.lineStyle(1, 0x9fe0c8, 0.35);
    g.strokeCircle(selfX, selfY, 7);

    for (let i = this.ripples.length - 1; i >= 0; i--) {
      const ripple = this.ripples[i];
      if (!ripple) continue;
      const age = (time - ripple.born) / CLUE_MS;
      if (age >= 1) {
        this.ripples.splice(i, 1);
        continue;
      }

      const rx = origin.x + (ripple.x / MAP.width) * MINIMAP_W;
      const ry = origin.y + (ripple.y / MAP.height) * MINIMAP_H;
      const fade = 1 - age;

      // Two rings chasing each other out of the source, plus a dot that holds
      // the exact spot: the pulse is readable for the whole 2.5s instead of
      // expanding once and vanishing before the eye arrives.
      g.lineStyle(2, ripple.color, fade);
      g.strokeCircle(rx, ry, 4 + age * 26);
      g.lineStyle(1, ripple.color, fade * 0.55);
      g.strokeCircle(rx, ry, 4 + age * 15);
      g.fillStyle(ripple.color, fade * 0.9);
      g.fillCircle(rx, ry, 2);
    }
  }

  private drawEdges(time: number): void {
    const g = this.edgeGfx;
    if (!g) return;
    g.clear();

    // Converts world -> screen with the *game* camera. The HUD runs its own
    // camera (no follow, no zoom), so asking it for world points aimed the
    // arrows at nonsense.
    const camera = this.scene.get("game")?.cameras?.main;
    if (!camera) return;

    const w = this.scale.width;
    const playH = this.barTop > 0 ? this.barTop : this.scale.height;
    const cx = w / 2;
    const cy = playH / 2;

    for (const ripple of this.ripples) {
      const age = (time - ripple.born) / CLUE_MS;
      if (age >= 1) continue;

      const sx = (ripple.x - camera.worldView.x) * camera.zoom;
      const sy = (ripple.y - camera.worldView.y) * camera.zoom;
      // The play area ends at the HUD bar; arrows belong inside it.
      const inside = sx > 24 && sx < w - 24 && sy > 24 && sy < playH - 24;
      if (inside) continue;

      const angle = Math.atan2(sy - cy, sx - cx);
      const margin = 54;
      const px = cx + Math.cos(angle) * (w / 2 - margin);
      const py = cy + Math.sin(angle) * (playH / 2 - margin);

      // Solid for the first 55% of the clue, then a soft fade — long enough to
      // read the bearing, short enough that it does not linger into the next
      // instead of feeling like a second clue.
      const fade = age < 0.55 ? 1 : 1 - (age - 0.55) / 0.45;
      const pulse = 0.82 + 0.18 * Math.sin(time / 140);
      const alpha = fade * pulse;

      g.fillStyle(ripple.color, alpha);
      g.beginPath();
      g.moveTo(px + Math.cos(angle) * 17, py + Math.sin(angle) * 17);
      g.lineTo(px + Math.cos(angle + 2.5) * 15, py + Math.sin(angle + 2.5) * 15);
      g.lineTo(px + Math.cos(angle - 2.5) * 15, py + Math.sin(angle - 2.5) * 15);
      g.closePath();
      g.fillPath();

      // Faint guide line back toward the source, so the arrow reads as a
      // direction and not as decoration.
      g.lineStyle(1, ripple.color, alpha * 0.35);
      g.beginPath();
      g.moveTo(
        cx + Math.cos(angle) * (Math.min(w, playH) * 0.18),
        cy + Math.sin(angle) * (Math.min(w, playH) * 0.18),
      );
      g.lineTo(px - Math.cos(angle) * 18, py - Math.sin(angle) * 18);
      g.strokePath();
    }
  }

  private drawCrosshair(): void {
    const g = this.crosshair;
    if (!g) return;
    const pointer = this.input.activePointer;
    g.clear();
    g.lineStyle(1, 0xf2ece1, 0.75);
    g.strokeCircle(pointer.x, pointer.y, 6);
    g.lineStyle(1, 0xf2ece1, 0.35);
    g.beginPath();
    g.moveTo(pointer.x - 11, pointer.y);
    g.lineTo(pointer.x - 8, pointer.y);
    g.moveTo(pointer.x + 8, pointer.y);
    g.lineTo(pointer.x + 11, pointer.y);
    g.moveTo(pointer.x, pointer.y - 11);
    g.lineTo(pointer.x, pointer.y - 8);
    g.moveTo(pointer.x, pointer.y + 8);
    g.lineTo(pointer.x, pointer.y + 11);
    g.strokePath();
  }

  private drawNotices(time: number): void {
    const g = this.statusGfx;
    if (!g) return;
    g.clear();

    for (let i = this.notices.length - 1; i >= 0; i--) {
      const notice = this.notices[i];
      if (!notice) continue;
      const age = (time - notice.born) / 2600;
      if (age >= 1) {
        this.notices.splice(i, 1);
        continue;
      }

      const alpha = age < 0.15 ? age / 0.15 : 1 - (age - 0.15) / 0.85;
      const y = 96 + i * 20;

      g.fillStyle(0x0b0f15, 0.5 * alpha);
      g.fillRoundedRect(this.scale.width / 2 - 110, y - 9, 220, 18, 9);

      if (!this.noticeText) {
        this.noticeText = this.add
          .text(0, 0, "", { fontFamily: "Trebuchet MS", fontSize: "13px", color: "#f2ece1" })
          .setOrigin(0.5)
          .setDepth(15);
      }
      this.noticeText.setText(notice.text).setColor(notice.color).setAlpha(alpha).setPosition(this.scale.width / 2, y);
    }

    if (this.notices.length === 0) this.noticeText?.setAlpha(0);
  }

  private noticeText?: Phaser.GameObjects.Text;
}
