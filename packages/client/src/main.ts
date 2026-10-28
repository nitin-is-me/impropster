import Phaser from "phaser";
import { BootScene } from "./scenes/BootScene";
import { GameScene } from "./scenes/GameScene";
import { HudScene } from "./scenes/HudScene";
import { NetClient } from "./net/NetClient";
import { AudioController } from "./audio/AudioController";
import { DomUI } from "./ui/DomUI";

const net = new NetClient();
const audio = new AudioController();

const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: "game-root",
  backgroundColor: "#05070a",
  scale: {
    mode: Phaser.Scale.RESIZE,
    autoCenter: Phaser.Scale.CENTER_BOTH,
    width: window.innerWidth,
    height: window.innerHeight,
  },
  render: {
    antialias: true,
    roundPixels: false,
  },
  input: {
    mouse: { preventDefaultWheel: true },
  },
  scene: [BootScene, GameScene, HudScene],
});

game.registry.set("net", net);
game.registry.set("audio", audio);

const ui = new DomUI(net, async (request) => {
  await net.connect(request);
  await audio.unlock();
});

net.setHandlers({
  // A dropped socket is not a "reconnecting" state here: the server holds the
  // seat for a while, but the player is returned to the landing page so they
  // can pick a different room instead of staring at a frozen lobby.
  onLeave: () => {
    ui.setConnectionBanner(false);
    ui.handleDisconnect();
  },
});

// The DOM overlay polls state instead of reacting to every patch: 8 refreshes a
// second is plenty for a roster, and it keeps the render loop untouched.
window.setInterval(() => ui.update(), 120);

// First gesture unlocks the audio context (browser autoplay policy).
const unlock = () => {
  void audio.unlock();
  window.removeEventListener("pointerdown", unlock);
  window.removeEventListener("keydown", unlock);
};
window.addEventListener("pointerdown", unlock);
window.addEventListener("keydown", unlock);

// Handy while developing: inspect the live client from the console.
(window as unknown as { __impropster: unknown }).__impropster = { net, game, audio };

window.addEventListener("contextmenu", (event) => event.preventDefault());
window.addEventListener("beforeunload", () => net.disconnect());

export { game };
