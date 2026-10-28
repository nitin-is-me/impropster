import Phaser from "phaser";
import { PROP_KINDS, PROP_SIZE, type PropKind } from "@impropster/shared";

/**
 * Every sprite and particle in the game is painted here at boot. No binary
 * assets means the whole project is text, and the art is tuned in one place.
 */

export const TEX = {
  floor: "tex-floor",
  wall: "tex-wall",
  glow: "tex-glow",
  vignette: "tex-vignette",
  shadow: "tex-shadow",
  ring: "tex-ring",
  spark: "tex-spark",
  playerSeeker: "tex-player-seeker",
  playerHider: "tex-player-hider",
  prop: (kind: PropKind) => `tex-prop-${kind}`,
} as const;

const PALETTE = {
  floor: 0x3a2f26,
  floorAlt: 0x342a22,
  floorLine: 0x2b231c,
  wall: 0x272b34,
  wallTop: 0x353b47,
  wallMortar: 0x1a1d24,
  wood: 0x8a5a34,
  woodDark: 0x5e3a20,
  woodLight: 0xa8724a,
  metal: 0x8f9aa6,
  leaf: 0x4f7f4a,
  leafDark: 0x35592f,
  cloth: 0xb0a48f,
  lamp: 0xf0c46a,
  // Roles are colour-coded hard on purpose: a seeker is crimson with ice
  // trim, a hider is teal with cream trim. Both carry a dark outline so the
  // silhouette survives against dark flooring and lit walls.
  seeker: 0xc0392b,
  seekerTrim: 0xffe3d2,
  hider: 0x2f9e87,
  hiderTrim: 0xd6fff4,
  outline: 0x120d0a,
} as const;

function painter(scene: Phaser.Scene, key: string, width: number, height: number, draw: (g: Phaser.GameObjects.Graphics) => void): void {
  if (scene.textures.exists(key)) return;
  const graphics = scene.make.graphics({ x: 0, y: 0 }, false);
  draw(graphics);
  graphics.generateTexture(key, width, height);
  graphics.destroy();
}

function box(
  g: Phaser.GameObjects.Graphics,
  x: number,
  y: number,
  w: number,
  h: number,
  fill: number,
  stroke?: number,
  radius = 2,
): void {
  g.fillStyle(fill, 1);
  if (radius > 0) g.fillRoundedRect(x, y, w, h, radius);
  else g.fillRect(x, y, w, h);
  if (stroke !== undefined) {
    g.lineStyle(1, stroke, 0.9);
    if (radius > 0) g.strokeRoundedRect(x, y, w, h, radius);
    else g.strokeRect(x, y, w, h);
  }
}

function paintFloor(scene: Phaser.Scene): void {
  painter(scene, TEX.floor, 32, 32, (g) => {
    g.fillStyle(PALETTE.floor, 1);
    g.fillRect(0, 0, 32, 32);
    g.fillStyle(PALETTE.floorAlt, 1);
    g.fillRect(0, 0, 32, 4);
    g.fillRect(0, 16, 32, 4);
    g.lineStyle(1, PALETTE.floorLine, 0.9);
    g.beginPath();
    g.moveTo(0, 8);
    g.lineTo(32, 8);
    g.moveTo(0, 24);
    g.lineTo(32, 24);
    g.moveTo(12, 8);
    g.lineTo(12, 16);
    g.moveTo(26, 24);
    g.lineTo(26, 32);
    g.strokePath();
  });
}

function paintWall(scene: Phaser.Scene): void {
  painter(scene, TEX.wall, 32, 32, (g) => {
    g.fillStyle(PALETTE.wallMortar, 1);
    g.fillRect(0, 0, 32, 32);

    g.fillStyle(PALETTE.wall, 1);
    g.fillRect(1, 1, 30, 14);
    g.fillRect(1, 17, 14, 14);
    g.fillRect(17, 17, 14, 14);

    g.fillStyle(PALETTE.wallTop, 1);
    g.fillRect(1, 1, 30, 3);
    g.fillRect(1, 17, 14, 2);
    g.fillRect(17, 17, 14, 2);

    g.fillStyle(0x000000, 0.18);
    g.fillRect(1, 13, 30, 2);
    g.fillRect(1, 29, 30, 2);
  });
}

function paintProps(scene: Phaser.Scene): void {
  for (const kind of PROP_KINDS) {
    const { width, height } = PROP_SIZE[kind];
    painter(scene, TEX.prop(kind), width, height, (g) => {
      switch (kind) {
        case "cabinet": {
          box(g, 1, 1, width - 2, height - 2, PALETTE.woodDark, 0x2a1a0d, 2);
          box(g, 3, 3, width - 6, 7, PALETTE.wood, 0x2a1a0d, 1);
          box(g, 3, 12, width - 6, 7, PALETTE.wood, 0x2a1a0d, 1);
          g.fillStyle(PALETTE.metal, 1);
          g.fillCircle(width / 2, 7, 1.4);
          g.fillCircle(width / 2, 16, 1.4);
          break;
        }
        case "crate": {
          box(g, 1, 1, width - 2, height - 2, PALETTE.wood, 0x2f1c0e, 2);
          g.lineStyle(2, PALETTE.woodDark, 0.9);
          g.beginPath();
          g.moveTo(3, 3);
          g.lineTo(width - 3, height - 3);
          g.moveTo(width - 3, 3);
          g.lineTo(3, height - 3);
          g.strokePath();
          g.lineStyle(1, PALETTE.woodLight, 0.7);
          g.strokeRect(2, 2, width - 4, height - 4);
          break;
        }
        case "barrel": {
          g.fillStyle(PALETTE.woodDark, 1);
          g.fillCircle(width / 2, height / 2, width / 2 - 1);
          g.fillStyle(PALETTE.wood, 1);
          g.fillCircle(width / 2, height / 2, width / 2 - 3);
          g.lineStyle(1.5, PALETTE.metal, 0.85);
          g.strokeCircle(width / 2, height / 2, width / 2 - 3);
          g.fillStyle(0x000000, 0.25);
          g.fillCircle(width / 2, height / 2, 2.5);
          break;
        }
        case "plant": {
          g.fillStyle(PALETTE.woodDark, 1);
          g.fillRoundedRect(width / 2 - 5, height - 12, 10, 11, 2);
          g.fillStyle(PALETTE.leafDark, 1);
          for (let i = 0; i < 5; i++) {
            const angle = (i / 5) * Math.PI * 2;
            g.fillEllipse(width / 2 + Math.cos(angle) * 4, height / 2 - 2 + Math.sin(angle) * 4, 9, 12);
          }
          g.fillStyle(PALETTE.leaf, 1);
          g.fillEllipse(width / 2, height / 2 - 3, 11, 14);
          break;
        }
        case "chair": {
          box(g, 2, 3, width - 4, height - 5, PALETTE.woodDark, 0x2a1a0d, 2);
          box(g, 3, 4, width - 6, height - 8, PALETTE.cloth, 0x2a1a0d, 2);
          g.fillStyle(PALETTE.woodDark, 1);
          g.fillRect(2, 1, width - 4, 3);
          break;
        }
        case "table": {
          box(g, 1, 1, width - 2, height - 2, PALETTE.woodDark, 0x2a1a0d, 3);
          box(g, 3, 3, width - 6, height - 6, PALETTE.woodLight, 0x3a2412, 2);
          g.lineStyle(1, PALETTE.woodDark, 0.6);
          g.beginPath();
          g.moveTo(4, height / 2);
          g.lineTo(width - 4, height / 2);
          g.strokePath();
          break;
        }
        case "lamp": {
          g.fillStyle(PALETTE.woodDark, 1);
          g.fillEllipse(width / 2, height - 2, 10, 4);
          g.fillRect(width / 2 - 1, 8, 2, height - 10);
          g.fillStyle(PALETTE.lamp, 1);
          g.fillTriangle(width / 2 - 7, 10, width / 2 + 7, 10, width / 2, 1);
          g.fillStyle(0xfff2c8, 0.8);
          g.fillTriangle(width / 2 - 4, 9, width / 2 + 4, 9, width / 2, 3);
          break;
        }
        case "vase": {
          g.fillStyle(0x6a8f9c, 1);
          g.fillEllipse(width / 2, height - 6, width - 2, height - 4);
          g.fillStyle(0x86aebb, 1);
          g.fillEllipse(width / 2 - 2, height - 8, width - 8, height - 10);
          g.fillStyle(0x3f5a66, 1);
          g.fillRect(width / 2 - 3, 0, 6, 6);
          break;
        }
        case "bench": {
          box(g, 0, 2, width, height - 4, PALETTE.woodDark, 0x2a1a0d, 2);
          g.fillStyle(PALETTE.wood, 1);
          for (let i = 0; i < 3; i++) {
            g.fillRect(2, 4 + i * 4, width - 4, 3);
          }
          break;
        }
        default:
          break;
      }
    });
  }
}

function paintPlayers(scene: Phaser.Scene): void {
  const SIZE = 24;
  const c = SIZE / 2;

  /** Shared torso: dark outline, coat, trim ring, facing wedge. */
  const torso = (g: Phaser.GameObjects.Graphics, coat: number, trim: number): void => {
    g.fillStyle(PALETTE.outline, 0.85);
    g.fillCircle(c, c, 10);
    g.fillStyle(coat, 1);
    g.fillCircle(c, c, 9);
    g.fillStyle(trim, 1);
    g.fillCircle(c, c, 5.5);
    g.fillStyle(coat, 1);
    g.fillCircle(c, c, 3.6);
    // Facing wedge. The art faces +x (right) on purpose: Phaser rotates by the
    // value of atan2(dy, dx), whose zero is 3 o'clock, so a texture drawn
    // facing up would sit 90° counter-clockwise of the crosshair.
    g.fillStyle(trim, 1);
    g.fillTriangle(SIZE - 0.5, c, SIZE - 6, c - 3.5, SIZE - 6, c + 3.5);
  };

  // Seeker: crimson coat plus a drawn sidearm, so the silhouette reads as
  // "hunter" at a glance even in a dim corridor.
  painter(scene, TEX.playerSeeker, SIZE, SIZE, (g) => {
    g.fillStyle(0x000000, 0.3);
    g.fillEllipse(c, c + 2, 19, 16);
    torso(g, PALETTE.seeker, PALETTE.seekerTrim);
    // Sidearm held straight out along the facing axis (+x).
    g.fillStyle(0x2b313a, 1);
    g.fillRect(c + 1, c - 1.5, 9, 3);
    g.fillStyle(0xfff3cd, 1);
    g.fillRect(SIZE - 3, c - 1, 2, 2);
  });

  // Hider: teal coat, cream trim, small shoulder pads instead of a weapon.
  painter(scene, TEX.playerHider, SIZE, SIZE, (g) => {
    g.fillStyle(0x000000, 0.3);
    g.fillEllipse(c, c + 2, 19, 16);
    torso(g, PALETTE.hider, PALETTE.hiderTrim);
    // Shoulder pads sit across the facing axis, so they read as a body rather
    // than as decorations on one side.
    g.fillStyle(PALETTE.outline, 0.7);
    g.fillCircle(c, c - 7, 2.2);
    g.fillCircle(c, c + 7, 2.2);
  });

  painter(scene, TEX.shadow, 26, 12, (g) => {
    g.fillStyle(0x000000, 0.35);
    g.fillEllipse(13, 6, 24, 10);
  });

  painter(scene, TEX.ring, 40, 40, (g) => {
    g.lineStyle(2, 0xf0c46a, 0.9);
    g.strokeCircle(20, 20, 17);
    g.lineStyle(1, 0xf0c46a, 0.35);
    g.strokeCircle(20, 20, 12);
  });

  painter(scene, TEX.spark, 6, 6, (g) => {
    g.fillStyle(0xffe6b0, 1);
    g.fillCircle(3, 3, 3);
  });
}

function paintGradients(scene: Phaser.Scene): void {
  if (!scene.textures.exists(TEX.glow)) {
    const canvas = scene.textures.createCanvas(TEX.glow, 256, 256);
    const ctx = canvas?.getContext();
    if (ctx) {
      const gradient = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
      gradient.addColorStop(0, "rgba(255,255,255,1)");
      gradient.addColorStop(0.45, "rgba(236,236,236,1)");
      gradient.addColorStop(0.78, "rgba(96,96,96,1)");
      gradient.addColorStop(1, "rgba(0,0,0,1)");
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, 256, 256);
      canvas?.refresh();
    }
  }

  if (!scene.textures.exists(TEX.vignette)) {
    const canvas = scene.textures.createCanvas(TEX.vignette, 512, 512);
    const ctx = canvas?.getContext();
    if (ctx) {
      const gradient = ctx.createRadialGradient(256, 256, 90, 256, 256, 256);
      gradient.addColorStop(0, "rgba(160, 24, 24, 0)");
      gradient.addColorStop(0.6, "rgba(160, 24, 24, 0.18)");
      gradient.addColorStop(1, "rgba(150, 12, 12, 0.72)");
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, 512, 512);
      canvas?.refresh();
    }
  }
}

export function createGameTextures(scene: Phaser.Scene): void {
  paintFloor(scene);
  paintWall(scene);
  paintProps(scene);
  paintPlayers(scene);
  paintGradients(scene);
}
