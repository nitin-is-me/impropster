import Phaser from "phaser";
import { createGameTextures, TEX } from "../render/textures";

export class BootScene extends Phaser.Scene {
  constructor() {
    super("boot");
  }

  create(): void {
    createGameTextures(this);

    // A tiny "loading" moment keeps the first frame from flashing an empty room.
    this.add
      .text(this.scale.width / 2, this.scale.height / 2, "IMPROPSTER", {
        fontFamily: "Trebuchet MS, sans-serif",
        fontSize: "28px",
        color: "#e0a458",
      })
      .setOrigin(0.5)
      .setAlpha(0.9);

    this.time.delayedCall(120, () => {
      this.scene.start("game");
      this.scene.launch("hud");
    });
  }

  preload(): void {
    // Nothing to load: every texture is generated in create().
    void TEX;
  }
}
