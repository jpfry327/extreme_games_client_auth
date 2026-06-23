import { TICK_HZ } from "./config";
import { Keyboard } from "./input/keyboard";
import { keyboardLockSupported, toggleFullscreen } from "./input/fullscreen";
import { loadMap } from "./map/loader";
import { FixedLoop } from "./sim/loop";
import { World } from "./sim/world";
import { Renderer } from "./render/renderer";

async function main() {
  const mount = document.getElementById("app")!;
  const hud = document.getElementById("hud")!;

  // 1. Load the map, 2. build the (pure) world, 3. set up the fixed-step loop.
  const map = await loadMap();
  const world = new World(map);
  const loop = new FixedLoop(world);

  // 4. Input + renderer.
  const keyboard = new Keyboard();

  // Press F to toggle fullscreen (which also enables keyboard lock on Chromium,
  // letting us try to capture Ctrl+arrows from macOS Mission Control).
  window.addEventListener("keydown", (e) => {
    if (e.code === "KeyF") toggleFullscreen(mount).catch(console.error);
  });
  if (!keyboardLockSupported()) {
    console.info(
      "Keyboard Lock API not available in this browser (Chromium-only); " +
        "Ctrl+arrows may still trigger OS shortcuts. Use Space to fire.",
    );
  }

  const renderer = new Renderer();
  await renderer.init(mount, map);

  // 5. The render/animation loop. Sample input, advance the sim in fixed steps,
  //    then draw with interpolation. requestAnimationFrame runs at the display's
  //    refresh rate; the sim still ticks at exactly TICK_HZ.
  let last = performance.now();
  let fpsAccum = 0;
  let fpsFrames = 0;
  let fps = 0;

  function frame(now: number) {
    const dt = (now - last) / 1000;
    last = now;

    const input = keyboard.sample();
    const alpha = loop.advance(dt, input);
    renderer.draw(world, alpha, dt);

    // HUD (updated a few times a second).
    fpsAccum += dt;
    fpsFrames++;
    if (fpsAccum >= 0.25) {
      fps = Math.round(fpsFrames / fpsAccum);
      fpsAccum = 0;
      fpsFrames = 0;
    }
    const s = world.ship;
    const speed = Math.hypot(s.vx, s.vy);
    hud.textContent =
      `fps ${fps}  (sim ${TICK_HZ}Hz)\n` +
      `pos ${s.x.toFixed(0)}, ${s.y.toFixed(0)}\n` +
      `speed ${speed.toFixed(2)} px/tick\n` +
      `energy ${s.energy.toFixed(0)}\n` +
      `projectiles ${world.projectiles.length}`;

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

main().catch((err) => {
  console.error(err);
  document.getElementById("hud")!.textContent = `Error: ${err.message}`;
});
