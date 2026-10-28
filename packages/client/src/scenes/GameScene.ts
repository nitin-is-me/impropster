import Phaser from "phaser";
import {
  MAP,
  Phase,
  PlayerForm,
  PlayerRole,
  TILE,
  propById,
  type PlayerStateInstance,
  type ShotPayload,
} from "@impropster/shared";
import type { NetClient } from "../net/NetClient";
import type { AudioController } from "../audio/AudioController";
import { FogOfWar } from "../render/FogOfWar";
import { actorDepth, DEPTH } from "../render/depths";
import { hudBarHeight } from "../render/layout";
import { TEX } from "../render/textures";

interface Tracer {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  life: number;
}

export class GameScene extends Phaser.Scene {
  private net!: NetClient;
  private audio!: AudioController;
  private fog!: FogOfWar;

  private readonly propSprites = new Map<number, Phaser.GameObjects.Image>();
  private readonly bodies = new Map<string, Phaser.GameObjects.Container>();
  private readonly bodyImages = new Map<string, Phaser.GameObjects.Image>();
  /** The furniture sprite a disguised body wears, one per player container. */
  private readonly bodyProps = new Map<string, Phaser.GameObjects.Image>();
  /** Props destroyed this round; they stay gone until the next round reset. */
  private readonly destroyedProps = new Set<number>();
  /** Props whose shatter animation is still playing — they stay visible.
   *  Without this the reconcile pass would hide the sprite on the same frame the
   *  shot lands, and the break would never be seen. */
  private readonly shattering = new Set<number>();
  private lastRound = -1;

  private selfRing?: Phaser.GameObjects.Image;
  private morphRing?: Phaser.GameObjects.Image;
  private overlay!: Phaser.GameObjects.Graphics;
  private tracers: Tracer[] = [];

  private aim = 0;
  private lastFireAt = 0;
  private keys?: Record<string, Phaser.Input.Keyboard.Key>;

  constructor() {
    super("game");
  }

  create(): void {
    this.net = this.registry.get("net") as NetClient;
    this.audio = this.registry.get("audio") as AudioController;

    this.buildMap();
    this.buildProps();

    // Markers sit under the y-sorted actor band so a body always covers them.
    this.morphRing = this.add
      .image(0, 0, TEX.ring)
      .setVisible(false)
      .setDepth(DEPTH.marker)
      .setTint(0xf0c46a);
    this.selfRing = this.add
      .image(0, 0, TEX.ring)
      .setDepth(DEPTH.marker)
      .setAlpha(0.35)
      .setTint(0x9fe0c8);
    this.overlay = this.add.graphics().setDepth(DEPTH.tracer);

    this.fog = new FogOfWar(this, MAP);

    const camera = this.cameras.main;
    camera.setBounds(0, 0, MAP.width, MAP.height);
    camera.setZoom(1.4);
    camera.setBackgroundColor("#05070a");
    this.applyViewport();

    // `enableCapture: false` on purpose. Phaser's default key capture calls
    // preventDefault() on keydown for every registered key, which swallows
    // W/A/S/D/Space/letters before they reach the DOM name and room-code
    // fields. Scrolling is suppressed instead by the guarded listener in
    // main.ts, which only acts while focus is outside a text field.
    this.keys = this.input.keyboard?.addKeys(
      "W,A,S,D,UP,DOWN,LEFT,RIGHT,F,R,SPACE",
      false,
    ) as Record<string, Phaser.Input.Keyboard.Key> | undefined;

    this.bindKeys();
    this.bindPointer();
    this.bindNetwork();

    this.scale.on("resize", () => this.applyViewport());
  }

  /**
   * The play area stops above the HUD bar. The minimap and the ammo/lockout
   * readout live down there, so the world is never covered by that furniture.
   * Only the small kill-feed lines float over the playfield, top-right.
   */
  private applyViewport(): void {
    const width = this.scale.width;
    const height = Math.max(160, this.scale.height - hudBarHeight(this.scale.height));
    this.cameras.main.setViewport(0, 0, width, height);
  }

  // ------------------------------------------------------------------ world

  private buildMap(): void {
    const rt = this.add.renderTexture(0, 0, MAP.width, MAP.height).setOrigin(0, 0).setDepth(DEPTH.map);

    const floor = this.add.tileSprite(0, 0, MAP.width, MAP.height, TEX.floor).setOrigin(0, 0);
    rt.draw(floor);
    floor.destroy();

    for (let ty = 0; ty < MAP.rows; ty++) {
      for (let tx = 0; tx < MAP.cols; tx++) {
        if (MAP.walls[ty * MAP.cols + tx] !== 1) continue;
        rt.draw(TEX.wall, tx * TILE, ty * TILE);
      }
    }
  }

  private buildProps(): void {
    for (const prop of MAP.props) {
      const sprite = this.add
        .image(prop.x, prop.y, TEX.prop(prop.kind))
        .setRotation(prop.angle)
        .setDepth(actorDepth(prop.y));
      sprite.setData("baseAngle", prop.angle);
      sprite.setData("baseDepth", actorDepth(prop.y));
      this.propSprites.set(prop.id, sprite);
    }
  }

  /**
   * Static decor is only ever drawn when nobody is wearing it. A disguised
   * hider is the same texture in the same pose, so the swap is invisible: the
   * furniture never "moves", the body underneath simply is that furniture.
   */
  private reconcileProps(worn: Set<number>): void {
    const shattered = this.net.state?.shattered;

    for (const [id, sprite] of this.propSprites) {
      if (this.shattering.has(id)) continue;
      const gone = this.destroyedProps.has(id) || (shattered ? shattered.includes(id) : false);
      const hidden = gone || worn.has(id);
      if (sprite.visible !== !hidden) sprite.setVisible(!hidden);
    }
  }

  /** A new round rebuilds the furniture that was shot up last round. */
  private resetProps(): void {
    this.destroyedProps.clear();
    this.shattering.clear();

    for (const sprite of this.propSprites.values()) {
      this.tweens.killTweensOf(sprite);
      sprite
        .setVisible(true)
        .setAlpha(1)
        .setScale(1)
        .setRotation(sprite.getData("baseAngle") as number)
        .setDepth(sprite.getData("baseDepth") as number);
    }
  }

  // ------------------------------------------------------------------ input

  private bindKeys(): void {
    if (!this.keys) return;

    const morph = this.keys["F"];
    morph?.on("down", () => {
      this.net.sendMorph();
      this.audio.unlock();
    });

    const lock = this.keys["SPACE"];
    lock?.on("down", () => this.net.sendToggleLock());

    const reload = this.keys["R"];
    reload?.on("down", () => this.net.sendReload());
  }

  private bindPointer(): void {
    this.input.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
      if (pointer.rightButtonDown()) return;
      this.audio.unlock();
      this.tryFire();
    });
  }

  private tryFire(): void {
    const self = this.net.self;
    if (!self || !self.alive) return;
    if (self.role !== PlayerRole.Seeker) return;
    if (this.time.now - this.lastFireAt < 240) return;
    this.lastFireAt = this.time.now;
    this.net.sendFire(this.aim);
  }

  // ---------------------------------------------------------------- network

  private bindNetwork(): void {
    this.net.setHandlers({
      onShot: (payload) => this.onShot(payload),
      onFootstep: (payload) => this.audio.footstep(payload.x, payload.y, payload.step),
      onGiggle: (payload) => {
        this.audio.giggle(payload.x, payload.y, payload.variant);
        this.game.events.emit("hud:giggle", payload);
      },
      onShatter: (payload) => {
        this.audio.shatter(payload.x, payload.y);
        this.game.events.emit("hud:shatter", payload);
        this.shatterProp(payload.propId);
      },
      onEliminated: (payload) => {
        this.audio.shatter(payload.x, payload.y);
        this.game.events.emit("hud:eliminated", payload);
      },
      onDenied: (payload) => this.game.events.emit("hud:denied", payload),
    });
  }

  private onShot(payload: ShotPayload): void {
    this.tracers.push({
      x1: payload.x,
      y1: payload.y,
      x2: payload.impactX,
      y2: payload.impactY,
      life: 1,
    });

    const self = this.net.self;
    const local = self && Math.hypot(self.x - payload.x, self.y - payload.y) < 40;
    if (local) this.audio.shot();
    else this.audio.shot(payload.x, payload.y);

    if (!payload.hit) this.game.events.emit("hud:miss", payload);
  }

  private shatterProp(propId: number): void {
    const sprite = this.propSprites.get(propId);
    if (!sprite || this.destroyedProps.has(propId) || this.shattering.has(propId)) return;

    // Keep the game object around (hidden) instead of destroying it: the next
    // round has to put the furniture back, and a disposed sprite cannot be
    // revived. It only counts as destroyed once the break animation ends.
    this.shattering.add(propId);

    this.tweens.add({
      targets: sprite,
      alpha: 0,
      scaleX: 1.35,
      scaleY: 1.35,
      angle: sprite.angle + 12,
      duration: 260,
      ease: "Quad.easeOut",
      onComplete: () => {
        this.shattering.delete(propId);
        this.destroyedProps.add(propId);
        sprite.setVisible(false);
      },
    });
  }

  // ------------------------------------------------------------------ frame

  override update(time: number): void {
    const net = this.net;
    const self = net.self;

    if (!self || !net.state) {
      this.fog.setEnabled(true);
      return;
    }

    const selfX = net.renderX(self);
    const selfY = net.renderY(self);
    const selfAim = this.computeAim(selfX, selfY, net.renderAim(self));
    this.aim = selfAim;

    const input = this.readMovement();
    net.tick(time, { moveX: input.x, moveY: input.y, aim: selfAim });

    if (this.input.activePointer.isDown && this.time.now - this.lastFireAt > 260) {
      this.tryFire();
    }

    if (net.state.round !== this.lastRound) {
      this.lastRound = net.state.round;
      this.resetProps();
    }

    this.syncBodies();

    const phase = net.state.phase;
    const playable = phase === Phase.Hide || phase === Phase.Hunt;
    const blinded = phase === Phase.Hide && self.role === PlayerRole.Seeker;

    // Fog is a property of being alive and holding a role. A seeker during the
    // hide phase has their eyes shut: the darkness stays, the light does not.
    // The team card is a full-screen overlay on a frozen map, so the fog (and
    // the seeker's blind curtain) has no business drawing under it.
    const fogActive = self.alive && self.role !== PlayerRole.None && phase !== Phase.Teams;
    this.fog.setEnabled(fogActive);
    if (fogActive) {
      if (blinded) this.fog.hideLight();
      else this.fog.update(time, selfX, selfY, selfAim, self.role);
    }

    this.audio.updateListener(selfX, selfY, selfAim);
    this.audio.updateHeartbeat(self.threat, time);

    this.selfRing?.setPosition(selfX, selfY).setVisible(self.alive && playable);

    this.updateMorphHint(self, selfX, selfY);
    this.drawTracers();
    this.updateBlindOverlay(blinded && self.alive);

    this.game.events.emit("hud:self", { x: selfX, y: selfY, aim: selfAim });
  }

  private computeAim(x: number, y: number, fallback: number): number {
    const pointer = this.input.activePointer;
    if (!pointer.manager) return fallback;
    const world = pointer.positionToCamera(this.cameras.main) as Phaser.Math.Vector2;
    const dx = world.x - x;
    const dy = world.y - y;
    if (Math.hypot(dx, dy) < 4) return fallback;
    return Math.atan2(dy, dx);
  }

  private readMovement(): { x: number; y: number } {
    if (!this.keys) return { x: 0, y: 0 };
    const left = this.keys["A"]?.isDown || this.keys["LEFT"]?.isDown;
    const right = this.keys["D"]?.isDown || this.keys["RIGHT"]?.isDown;
    const up = this.keys["W"]?.isDown || this.keys["UP"]?.isDown;
    const down = this.keys["S"]?.isDown || this.keys["DOWN"]?.isDown;

    return {
      x: (right ? 1 : 0) - (left ? 1 : 0),
      y: (down ? 1 : 0) - (up ? 1 : 0),
    };
  }

  private syncBodies(): void {
    const state = this.net.state;
    const self = this.net.self;
    if (!state || !self) return;

    const seen = new Set<string>();
    const worn = new Set<number>();

    for (const [id, player] of state.players) {
      seen.add(id);
      const isSelf = id === this.net.sessionId;

      let container = this.bodies.get(id);
      let propImage = this.bodyProps.get(id);
      let body = this.bodyImages.get(id);

      if (!container || !propImage || !body) {
        container = this.add.container(0, 0);
        const shadow = this.add.image(0, 7, TEX.shadow).setAlpha(0.45);
        propImage = this.add.image(0, 0, TEX.prop("crate")).setVisible(false);
        body = this.add.image(0, 0, TEX.playerHider);
        container.add([shadow, propImage, body]);
        this.bodies.set(id, container);
        this.bodyImages.set(id, body);
        this.bodyProps.set(id, propImage);

        if (isSelf) this.cameras.main.startFollow(container, true, 0.18, 0.18);
      }

      // `disguiseId` is the public echo of the private `propId`, so this works
      // identically for your own body and for furniture someone else is
      // wearing. A disguise with no matching prop falls back to the human
      // sprite rather than drawing nothing.
      const prop = player.form === PlayerForm.Prop ? propById(player.disguiseId) : undefined;

      const x = this.net.renderX(player);
      const y = this.net.renderY(player);
      const aim = this.net.renderAim(player);

      container.setPosition(x, y);
      container.setDepth(actorDepth(y));
      container.setVisible(player.alive && player.connected !== false);

      if (prop) {
        worn.add(prop.id);

        const texture = TEX.prop(prop.kind);
        if (propImage.texture.key !== texture) propImage.setTexture(texture);
        propImage.setRotation(prop.angle).setVisible(true);
        body.setVisible(false);

        // The disguise must sit exactly like the decor it replaced, so the
        // body stops rotating and the prop carries the furniture's own angle.
        container.setRotation(0);
      } else {
        const texture = player.role === PlayerRole.Seeker ? TEX.playerSeeker : TEX.playerHider;
        if (body.texture.key !== texture) body.setTexture(texture);
        body.setVisible(true);
        propImage.setVisible(false);
        container.setRotation(aim);
      }
    }

    for (const [id, container] of this.bodies) {
      if (seen.has(id)) continue;
      container.destroy();
      this.bodies.delete(id);
      this.bodyImages.delete(id);
      this.bodyProps.delete(id);
    }

    this.reconcileProps(worn);
  }

  private updateMorphHint(self: PlayerStateInstance, x: number, y: number): void {
    const target = self.canMorph && self.morphTargetId >= 0 ? propById(self.morphTargetId) : undefined;
    if (!target || self.role !== PlayerRole.Hider) {
      this.morphRing?.setVisible(false);
      return;
    }

    this.morphRing?.setVisible(true).setPosition(target.x, target.y);
    this.morphRing?.setScale(0.9 + Math.sin(this.time.now / 160) * 0.08);
    void x;
    void y;
  }

  private drawTracers(): void {
    const g = this.overlay;
    g.clear();

    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const tracer = this.tracers[i];
      if (!tracer) continue;

      tracer.life -= 0.11;
      if (tracer.life <= 0) {
        this.tracers.splice(i, 1);
        continue;
      }

      // Two passes: a wide warm bloom, then a hot core. Both fade with the
      // tracer's life, so a fresh shot pops and an old one smears out.
      g.lineStyle(6, 0xffc65a, tracer.life * 0.22);
      g.beginPath();
      g.moveTo(tracer.x1, tracer.y1);
      g.lineTo(tracer.x2, tracer.y2);
      g.strokePath();

      g.lineStyle(2, 0xfff6c4, tracer.life * 0.95);
      g.beginPath();
      g.moveTo(tracer.x1, tracer.y1);
      g.lineTo(tracer.x2, tracer.y2);
      g.strokePath();

      g.fillStyle(0xffce7a, tracer.life * 0.5);
      g.fillCircle(tracer.x2, tracer.y2, 8 * tracer.life);
      g.fillStyle(0xfffbe6, tracer.life);
      g.fillCircle(tracer.x2, tracer.y2, 3 * tracer.life);
    }
  }

  private lastBlindState = false;

  private updateBlindOverlay(visible: boolean): void {
    if (visible === this.lastBlindState) return;
    this.lastBlindState = visible;
    this.game.events.emit("hud:blind", visible);
  }
}
