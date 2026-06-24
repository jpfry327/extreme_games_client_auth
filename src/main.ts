import { TICK_HZ } from "./config";
import { Keyboard } from "./input/keyboard";
import { keyboardLockSupported, toggleFullscreen } from "./input/fullscreen";
import { loadMap } from "./map/loader";
import { computeBotInput } from "./sim/bot";
import { isAlive } from "./sim/player";
import { World } from "./sim/world";
import { Renderer } from "./render/renderer";
import { GameServer, BOT_PLAYER_ID } from "./net/server";
import { LoopbackTransport } from "./net/transport";
import { applySnapshot } from "./net/snapshot";

async function main() {
  const mount = document.getElementById("app")!;
  const hud = document.getElementById("hud")!;
  const killfeed = document.getElementById("killfeed")!;

  // 1. Load the map.
  const map = await loadMap();

  // 2. Spin up the in-process authoritative server. It owns the World + FixedLoop
  //    and is the single source of truth for all game state.
  const server = new GameServer(map);
  server.authoritativeWorld.localPlayer.name = "fecundity";

  // 3. Create the client world — a read-only mirror populated exclusively by
  //    applySnapshot. The renderer reads this; the sim never steps it.
  //    `addLocalPlayer = false` so we start empty; the snapshot fills it in.
  const clientWorld = new World(map, 1, false);

  // 4. Loopback transport: keyboard → server; server snapshot → clientWorld.
  const transport = new LoopbackTransport(server, server.localPlayerId);
  transport.setSnapshotHandler((snap) => applySnapshot(clientWorld, snap));

  // 5. Input + renderer.
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

  // A throwaway kill feed: the real bitmap-font version arrives with the UI
  // toolkit in M3. For now we render recent kill lines into a DOM overlay.
  const feed = new KillFeed(killfeed);

  // 6. The render/animation loop. Sample input, send to server, advance the
  //    authoritative sim, then draw the client world (which was just updated
  //    synchronously by the snapshot handler).
  let last = performance.now();
  let fpsAccum = 0;
  let fpsFrames = 0;
  let fps = 0;

  function frame(now: number) {
    const dt = (now - last) / 1000;
    last = now;

    // Send the local player's intent.
    transport.sendInput(keyboard.sample());

    // Bot AI reads the client world (last snapshot — zero-latency loopback so
    // it's identical to the server world). Route bot input via the loopback
    // escape hatch until the bot moves server-side in M2.7.
    transport.sendInputAs(BOT_PLAYER_ID, computeBotInput(clientWorld, BOT_PLAYER_ID));

    // Advance the authoritative sim. The snapshot handler fires synchronously
    // inside this call, so clientWorld is up-to-date by the time we return.
    const alpha = server.advance(dt);

    // Draw from the client world — every pixel on screen has passed through the
    // serialize → deserialize round-trip. If it plays like M1, the seam is correct.
    renderer.draw(clientWorld, alpha, dt);

    // Drain events: the snapshot handler populated clientWorld.events from the
    // server's events for this tick. Kill-feed and renderer both consume them;
    // main.ts owns the clear so every consumer sees them (architecture §4).
    for (const e of clientWorld.events) {
      if (e.type === "shipDied")
        feed.add(killLine(clientWorld, e.killer, e.victim), now);
    }
    clientWorld.events.length = 0;
    feed.render(now);

    // HUD (updated a few times a second).
    fpsAccum += dt;
    fpsFrames++;
    if (fpsAccum >= 0.25) {
      fps = Math.round(fpsFrames / fpsAccum);
      fpsAccum = 0;
      fpsFrames = 0;
    }
    const me = clientWorld.localPlayer;
    if (me) {
      const k = me.kinematics;
      const speed = Math.hypot(k.vx, k.vy);
      const status = isAlive(me)
        ? `energy ${me.resources.energy.toFixed(0)}`
        : `RESPAWNING in ${((me.combat.respawnAt - clientWorld.tick) / TICK_HZ).toFixed(1)}s`;
      hud.textContent =
        `fps ${fps}  (sim ${TICK_HZ}Hz)\n` +
        `pos ${k.x.toFixed(0)}, ${k.y.toFixed(0)}\n` +
        `speed ${speed.toFixed(2)} px/tick\n` +
        `${status}\n` +
        `bounty ${me.combat.bounty}  score ${me.combat.score}  ` +
        `${me.combat.kills}-${me.combat.deaths} (K-D)\n` +
        `projectiles ${clientWorld.projectiles.length}`;
    }

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

/** Build a kill-feed line from a death event, looking names up on the world. */
function killLine(world: World, killer: string | null, victim: string): string {
  const name = (id: string) => world.players.get(id)?.name ?? id;
  if (killer && killer !== victim) return `${name(killer)} killed ${name(victim)}`;
  return `${name(victim)} was destroyed`;
}

/** A tiny self-expiring kill feed rendered into a DOM element. Throwaway until
 *  M3's bitmap-font UI replaces it. */
class KillFeed {
  private static readonly TTL_MS = 5000;
  private static readonly MAX_LINES = 5;
  private lines: { text: string; bornMs: number }[] = [];

  constructor(private readonly el: HTMLElement) {}

  add(text: string, nowMs: number): void {
    this.lines.push({ text, bornMs: nowMs });
    if (this.lines.length > KillFeed.MAX_LINES) this.lines.shift();
  }

  render(nowMs: number): void {
    this.lines = this.lines.filter((l) => nowMs - l.bornMs < KillFeed.TTL_MS);
    this.el.textContent = this.lines.map((l) => l.text).join("\n");
  }
}

main().catch((err) => {
  console.error(err);
  document.getElementById("hud")!.textContent = `Error: ${err.message}`;
});
