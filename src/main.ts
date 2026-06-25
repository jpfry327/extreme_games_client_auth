import { NET, TICK_HZ } from "./config";
import { Keyboard } from "./input/keyboard";
import { keyboardLockSupported, toggleFullscreen } from "./input/fullscreen";
import { loadMap } from "./map/loader";
import { isAlive } from "./sim/player";
import { World } from "./sim/world";
import { Renderer } from "./render/renderer";
import { WebSocketTransport } from "./net/WebSocketTransport";
import { SimulatedTransport } from "./net/networkSimulator";
import { SnapshotInterpolator } from "./net/interpolation";
import { ClientInputManager } from "./net/clientInput";
import { Predictor } from "./net/prediction";
import { ReconciliationSmoother } from "./net/reconciliationSmoother";

// To run without a server (in-process loopback, M2.0 mode), swap the import
// above for these two and uncomment the loopback block below:
//   import { GameServer } from "./net/server";
//   import { LoopbackTransport } from "./net/transport";

async function main() {
  const mount = document.getElementById("app")!;
  const hud = document.getElementById("hud")!;
  const killfeed = document.getElementById("killfeed")!;
  const netdebug = document.getElementById("netdebug")!;

  // 1. Load the map.
  const map = await loadMap();

  // 2. Create the view world — never stepped. The interpolator rebuilds it each
  //    frame from buffered snapshots, rendering remote entities ~interpDelay in
  //    the past so they glide instead of snapping at the 20Hz broadcast rate.
  const view = new World(map, 1, false);
  const interp = new SnapshotInterpolator();

  // Input sequencing (M2.3): produces one stamped command per 10ms sim tick and
  // holds the un-acked ring buffer. Snapshots ack by seq; prediction (M2.4) will
  // replay the survivors. Nothing is corrected yet — this is the data plane only.
  const inputMgr = new ClientInputManager();
  // Prediction (M2.4): a third, predicted world holding only the local player.
  // Each frame it resets to the latest acked snapshot and replays the un-acked
  // inputs, so the local ship reacts instantly instead of lagging by RTT.
  const predictor = new Predictor(map);
  // Smoothing (M2.5): absorbs each reconciliation's residual error into a
  // render-offset that decays to zero, so a correction is a gentle pull instead
  // of a snap. Zero offset in steady state — adds no latency.
  const smoother = new ReconciliationSmoother();
  // Latest server-reported input-queue depth for us (debug overlay only).
  let serverInputDepth = 0;
  // Newest snapshot tick we've accepted. Jitter (esp. with the network sim) can
  // deliver snapshots out of order; an older-tick snapshot is stale — we already
  // have something newer — so it's dropped to keep the buffer monotonic and stop
  // the predictor from rewinding to an old authoritative pose.
  let newestSnapTick = -1;

  // 3. Input + renderer — initialize NOW so the canvas is on screen while we
  //    connect. The game loop starts immediately in "connecting…" mode.
  const keyboard = new Keyboard();

  window.addEventListener("keydown", (e) => {
    if (e.code === "KeyF") toggleFullscreen(mount).catch(console.error);
  });
  if (!keyboardLockSupported()) {
    console.info(
      "Keyboard Lock API not available (Chromium-only); " +
        "Ctrl+arrows may trigger OS shortcuts. Use Space to fire.",
    );
  }

  const renderer = new Renderer();
  await renderer.init(mount, map);
  const feed = new KillFeed(killfeed);

  // 4. Connect to the authoritative server over WebSocket.
  //    The Vite dev proxy routes /ws → ws://localhost:3000 (see vite.config.ts).
  //    Run `npm run server` in a separate terminal before opening the browser.
  //
  //    To swap back to in-process loopback (no server needed), replace these
  //    four lines with the loopback block commented out below.
  const socket = new WebSocketTransport(
    `ws://${location.host}/ws`,
    "fecundity",
  );

  // --- loopback alternative (no server needed) ---
  // const server = new GameServer(map);
  // server.authoritativeWorld.localPlayer.name = "fecundity";
  // const socket = new LoopbackTransport(server, server.localPlayerId);
  // ------------------------------------------------

  // M2.5: wrap the real transport in the network simulator (added latency /
  // jitter / loss, both directions). Off by default; toggled live from the
  // #netsim panel. The handshake (`onConnected`) is set on `socket` directly, so
  // joining is never affected by simulated loss.
  const transport = new SimulatedTransport(socket, NET.netSim);

  // Buffer each snapshot with its arrival time; the interpolator consumes the
  // buffer at render time. (M2.0 applied snapshots directly — that snapped.)
  // Also process the M2.3 ack: drop acked inputs + update RTT, and record the
  // server-side queue depth for the overlay.
  transport.setSnapshotHandler((snap) => {
    // Drop out-of-order (stale) snapshots — jitter can deliver an older tick
    // after a newer one; we already hold something fresher (M2.5).
    if (snap.tick <= newestSnapTick) return;
    newestSnapTick = snap.tick;

    const now = performance.now();
    interp.push(snap, now);
    // M2.4 reconciliation: measure prediction error *before* the ack drops the
    // un-acked inputs (so this frame's replay still recorded the acked seq).
    const local = snap.players.find((p) => p.id === view.localPlayerId);
    if (local) {
      predictor.measureError(local, snap.lastProcessedInputSeq);
      // M2.5 correction smoothing: sample the predicted "now" pose on both sides
      // of the reconciliation — before applying the new snapshot and after — so
      // their difference is the pure misprediction. Both at this same instant, so
      // no real motion is mixed in. The smoother absorbs the gap and decays it.
      const before = predictor.predict(inputMgr.unacked, view.localPlayerId);
      inputMgr.ack(snap.lastProcessedInputSeq, now);
      // M2.6: seed the predictor with our own already-acked projectiles too, so
      // its replay advances them to the leading edge alongside the ship.
      const localProjectiles = snap.projectiles.filter((p) => p.owner === view.localPlayerId);
      predictor.setAuthoritative(local, localProjectiles, snap.tick);
      const after = predictor.predict(inputMgr.unacked, view.localPlayerId);
      if (before && after) smoother.absorb(before.kinematics, after.kinematics);
    } else {
      inputMgr.ack(snap.lastProcessedInputSeq, now);
    }
    serverInputDepth = snap.inputBufferDepth;
  });

  // `connected` flips true once the server sends `welcome` and we know our
  // PlayerId. The render loop runs in "connecting…" mode until then. The
  // handshake is on the raw socket, so simulated loss never blocks a join.
  let connected = false;
  socket.onConnected = (playerId) => {
    view.localPlayerId = playerId;
    connected = true;
    console.info(`[client] connected as ${playerId}`);
  };
  transport.start();

  // M2.5: wire the #netsim debug panel to the live simulator params.
  setupNetSimPanel(transport);

  // 5. Render loop. Starts immediately — even before the server replies — so
  //    the canvas is live and the "connecting…" HUD is visible right away.
  let last = performance.now();
  let fpsAccum = 0;
  let fpsFrames = 0;
  let fps = 0;

  function frame(now: number) {
    const dt = (now - last) / 1000;
    last = now;

    if (!connected) {
      hud.textContent = "connecting…";
      requestAnimationFrame(frame);
      return;
    }

    // Produce one stamped command per elapsed sim tick (not per render frame)
    // and send every one, so the server gets a continuous, ordered stream.
    for (const input of inputMgr.produce(dt, keyboard.sample(), now)) {
      transport.sendInput(input);
    }

    // --- loopback only: advance the in-process server (bot runs server-side) ---
    // const alpha = server.advance(dt);
    // --------------------------------------------------------------------------

    // Rebuild the view world from buffered snapshots: remote ships/bullets are
    // interpolated ~interpDelay in the past (smooth); the local ship is pinned
    // to the latest snapshot (still laggy — M2.4 adds prediction). The pose is
    // baked in with prev*===current, so alpha is a no-op here.
    interp.buildView(view, now, NET.interpDelayMs, view.localPlayerId, NET.extrapolateMaxMs);

    // M2.4: replace the laggy snapshot-pinned local player with the predicted
    // one (reset to the last ack + replay of un-acked inputs). The camera and
    // local ship now track the predicted pose; remotes stay interpolated. alpha
    // is 1, so the renderer's prev→current lerp draws the predicted pose as-is.
    const predLocal = predictor.predict(inputMgr.unacked, view.localPlayerId);
    if (predLocal) {
      // M2.5: ease in any pending reconciliation correction rather than snapping.
      smoother.apply(predLocal.kinematics, dt);
      view.players.set(view.localPlayerId, predLocal);
      // M2.6: our own shots come from the predictor (leading edge) instead of the
      // interpolated snapshot stream (the interpolator skipped them). Appended so
      // they fire instantly and hand off seamlessly to their server twin on ack.
      for (const p of predictor.predictedProjectiles) view.projectiles.push(p);
    }

    renderer.draw(view, 1, dt);

    // Drain events the interpolator released (in interpolated time) this frame.
    for (const e of view.events) {
      if (e.type === "shipDied")
        feed.add(killLine(view, e.killer, e.victim), now);
    }
    view.events.length = 0;
    feed.render(now);

    // HUD.
    fpsAccum += dt;
    fpsFrames++;
    if (fpsAccum >= 0.25) {
      fps = Math.round(fpsFrames / fpsAccum);
      fpsAccum = 0;
      fpsFrames = 0;
    }
    const me = view.players.get(view.localPlayerId);
    if (me) {
      const k = me.kinematics;
      const speed = Math.hypot(k.vx, k.vy);
      const status = isAlive(me)
        ? `energy ${me.resources.energy.toFixed(0)}`
        : `RESPAWNING in ${((me.combat.respawnAt - view.tick) / TICK_HZ).toFixed(1)}s`;
      hud.textContent =
        `fps ${fps}  (sim ${TICK_HZ}Hz)\n` +
        `pos ${k.x.toFixed(0)}, ${k.y.toFixed(0)}\n` +
        `speed ${speed.toFixed(2)} px/tick\n` +
        `${status}\n` +
        `bounty ${me.combat.bounty}  score ${me.combat.score}  ` +
        `${me.combat.kills}-${me.combat.deaths} (K-D)\n` +
        `projectiles ${view.projectiles.length}`;
    }

    // Netcode debug overlay (M2.3) — the verification tool for M2.4–M2.6.
    // `view.tick` is the newest snapshot's server tick; the client tick is our
    // own input clock. Their gap = how far ahead the client is sampling. The
    // server buffer depth should sit at a small steady value (one snapshot's
    // worth of commands); ~0 means starvation, a growing number means lag.
    const sim = transport.params;
    const simLine = sim.enabled
      ? `netsim ${sim.latencyMs}±${sim.jitterMs}ms ${sim.lossPct}% loss`
      : `netsim off`;
    netdebug.textContent =
      `── netcode (M2.5) ──\n` +
      `rtt ${inputMgr.rttMs.toFixed(0)}ms (ack)\n` +
      `acked seq ${inputMgr.lastAckedSeq}\n` +
      `client tick ${inputMgr.clientTickCount}\n` +
      `server tick ${view.tick}\n` +
      `input buf (server) ${serverInputDepth}\n` +
      `un-acked (client) ${inputMgr.pendingCount}\n` +
      `pred err ${predictor.predictionErrorPx.toFixed(1)}px\n` +
      `pred proj ${predictor.predictedProjectiles.length}\n` +
      `smooth off ${smoother.offsetPx.toFixed(1)}px\n` +
      simLine;

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

function killLine(world: World, killer: string | null, victim: string): string {
  const name = (id: string) => world.players.get(id)?.name ?? id;
  if (killer && killer !== victim) return `${name(killer)} killed ${name(victim)}`;
  return `${name(victim)} was destroyed`;
}

/**
 * Wire the #netsim debug panel (a checkbox + three sliders in index.html) to the
 * live simulator params (M2.5). Mutating `transport.params` in place changes the
 * conditions immediately, so bad networks are reproducible on demand. Each slider
 * shows its current value next to it.
 */
function setupNetSimPanel(transport: SimulatedTransport): void {
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const enabled = $<HTMLInputElement>("ns-enabled");
  const latency = $<HTMLInputElement>("ns-latency");
  const jitter = $<HTMLInputElement>("ns-jitter");
  const loss = $<HTMLInputElement>("ns-loss");
  // Bail quietly if the panel isn't in the DOM (keeps the client robust).
  if (!enabled || !latency || !jitter || !loss) return;

  const p = transport.params;
  const sync = () => {
    enabled.checked = p.enabled;
    latency.value = String(p.latencyMs);
    jitter.value = String(p.jitterMs);
    loss.value = String(p.lossPct);
    $("ns-latency-val").textContent = `${p.latencyMs}ms`;
    $("ns-jitter-val").textContent = `±${p.jitterMs}ms`;
    $("ns-loss-val").textContent = `${p.lossPct}%`;
  };

  enabled.addEventListener("change", () => {
    p.enabled = enabled.checked;
    sync();
  });
  latency.addEventListener("input", () => {
    p.latencyMs = Number(latency.value);
    sync();
  });
  jitter.addEventListener("input", () => {
    p.jitterMs = Number(jitter.value);
    sync();
  });
  loss.addEventListener("input", () => {
    p.lossPct = Number(loss.value);
    sync();
  });
  sync();
}

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
