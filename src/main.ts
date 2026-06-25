import { LAGCOMP, NET, TICK_DT, TICK_HZ } from "./config";
import { Keyboard } from "./input/keyboard";
import { keyboardLockSupported, toggleFullscreen } from "./input/fullscreen";
import { loadMap } from "./map/loader";
import { isAlive } from "./sim/player";
import { World } from "./sim/world";
import { Renderer } from "./render/renderer";
import { WebSocketTransport } from "./net/WebSocketTransport";
import { SimulatedTransport } from "./net/networkSimulator";
import { SnapshotInterpolator, pickStraddlingPair } from "./net/interpolation";
import { RemoteProjectileSimulator } from "./net/remoteProjectiles";
import { ClientInputManager } from "./net/clientInput";
import { Predictor } from "./net/prediction";
import { ReconciliationSmoother } from "./net/reconciliationSmoother";
import { NetHealth } from "./net/netHealth";
import { AdaptiveInterpDelay } from "./net/adaptiveInterp";

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
  //    the past so they glide instead of snapping at the ~33Hz broadcast rate.
  const view = new World(map, 1, false);
  const interp = new SnapshotInterpolator();
  // M2.8: remote players' projectiles are simulated deterministically (forward
  // from the latest snapshot) instead of interpolated, so enemy bullets bounce
  // off walls in real time instead of teleporting through corners. Rendered at
  // the same render time as remote ships (now − interpDelay), reading the
  // interpolator's buffer so the two stay on one timeline.
  const remoteProjectiles = new RemoteProjectileSimulator(map);

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
  // M2.11: network-health telemetry (jitter, snapshot loss/stalls, buffer depth,
  // extrapolation/freeze + comp-clamp rates) for the debug overlay, and the
  // interval/jitter feed for the adaptive interpolation delay below.
  const health = new NetHealth();
  // M2.11: drive the interpolation delay from the measured link instead of a fixed
  // 75ms, so a jittery connection stops starving the buffer (remote ships jumping).
  const adaptiveInterp = new AdaptiveInterpDelay(NET.adaptiveInterp, NET.interpDelayMs);
  // Latest server-measured RTT (ms) per player, from the snapshot — drives the
  // ping shown on nametags (M2.7).
  let latestPings: Record<string, number> = {};
  // Newest snapshot tick we've accepted. Jitter (esp. with the network sim) can
  // deliver snapshots out of order; an older-tick snapshot is stale — we already
  // have something newer — so it's dropped to keep the buffer monotonic and stop
  // the predictor from rewinding to an old authoritative pose.
  let newestSnapTick = -1;
  // M2.9 debug counter: total hits the server awarded via lag-comp rewind.
  let rewindHitCount = 0;
  // M2.10: local bomb detonations we've already drawn from prediction (instant),
  // so the delayed server copy of the same explosion can be suppressed instead of
  // drawn a second time. Each entry expires on its own in case the server copy
  // never arrives (e.g. the bomb was retracted). A match is consumed (1:1) so two
  // distinct explosions can't both be cancelled by one prediction.
  const shownLocalBooms: { x: number; y: number; expiresMs: number }[] = [];
  // Suppression match radius (px). Predicted and server detonations share the same
  // deterministic trajectory so land within ~1px; the slack only absorbs float
  // drift / a small prediction error, and owner+time scoping keeps it from
  // cancelling a genuinely different explosion.
  const BOOM_MATCH_PX = 16;
  // How long a predicted boom waits for its server twin before expiring (ms):
  // comfortably past interpDelay + a full RTT so the real duplicate is caught.
  const BOOM_TTL_MS = 600;

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
  //
  //    The server URL is environment-driven: in a production build (GitHub Pages)
  //    VITE_SERVER_URL is baked in pointing at the deployed Railway server
  //    (wss://…). With no env var — i.e. local `npm run dev` — it falls back to the
  //    same-origin `/ws`, which the Vite proxy routes to ws://localhost:3000.
  const serverUrl = import.meta.env.VITE_SERVER_URL ?? `ws://${location.host}/ws`;
  const socket = new WebSocketTransport(serverUrl, resolvePlayerName());

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
    if (snap.tick <= newestSnapTick) {
      health.onStaleSnapshot(); // M2.11
      return;
    }
    newestSnapTick = snap.tick;

    const now = performance.now();
    health.onSnapshot(snap.tick, now); // M2.11: jitter + tick-gap loss tracking
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
    latestPings = snap.pings;
  });

  // `connected` flips true once the server sends `welcome` and we know our
  // PlayerId. The render loop runs in "connecting…" mode until then. The
  // handshake is on the raw socket, so simulated loss never blocks a join.
  let connected = false;
  let rejected: string | null = null;
  socket.onConnected = (playerId) => {
    view.localPlayerId = playerId;
    connected = true;
    console.info(`[client] connected as ${playerId}`);
  };
  // M2.7: the server can refuse a join (e.g. arena full). Surface it in the HUD
  // instead of hanging in "connecting…".
  socket.onRejected = (reason) => {
    rejected = reason;
    console.warn(`[client] join rejected: ${reason}`);
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

  // M2.10: remove from `view.events` the server's delayed copy of any own-bomb
  // explosion we already drew from prediction, and expire stale predictions. Runs
  // before the renderer drains events, so a suppressed boom is never spawned.
  function suppressShownLocalBooms(world: World, nowMs: number): void {
    // Expire predictions whose server twin never came (e.g. a retracted bomb).
    for (let i = shownLocalBooms.length - 1; i >= 0; i--) {
      if (shownLocalBooms[i].expiresMs <= nowMs) shownLocalBooms.splice(i, 1);
    }
    // Compact `events` in place, dropping each own-bomb detonation that matches a
    // shown prediction and consuming that match (so it's strictly 1:1).
    const events = world.events;
    let w = 0;
    for (let r = 0; r < events.length; r++) {
      const e = events[r];
      if (e.type === "bombExploded" && e.owner === world.localPlayerId) {
        const mi = shownLocalBooms.findIndex(
          (b) => Math.hypot(b.x - e.x, b.y - e.y) <= BOOM_MATCH_PX,
        );
        if (mi !== -1) {
          shownLocalBooms.splice(mi, 1);
          continue; // suppress: we already drew this one from prediction
        }
      }
      events[w++] = e;
    }
    events.length = w;
  }

  function frame(now: number) {
    const dt = (now - last) / 1000;
    last = now;

    if (rejected) {
      hud.textContent = `Couldn't join: ${rejected}`;
      return; // stop the loop — the server closed the socket
    }
    if (!connected) {
      hud.textContent = "connecting…";
      requestAnimationFrame(frame);
      return;
    }

    // M2.11: ease the interpolation delay toward the measured link (snapshot
    // spacing + jitter), then use this single value everywhere this frame
    // (renderTick stamping, buildView, remote projectiles) so ships and bullets
    // stay on one timeline. Falls back to the fixed NET.interpDelayMs when adaptive
    // is off or before any snapshot timing exists.
    adaptiveInterp.update(health.meanIntervalMs, health.jitterMs, dt);
    const interpMs = adaptiveInterp.ms;

    // Produce one stamped command per elapsed sim tick (not per render frame)
    // and send every one, so the server gets a continuous, ordered stream. M2.9:
    // stamp the command with the server tick our render view corresponds to (the
    // ghost positions we're aiming at), so the server rewinds targets to exactly
    // this view when adjudicating our shots ("what you see is what you hit"). All
    // catch-up ticks this frame share it, like they share the keyboard sample.
    const renderTick = interp.renderTick(now, interpMs, NET.extrapolateMaxMs);
    const sample = keyboard.sample();
    const stamped = renderTick !== null ? { ...sample, renderTick } : sample;
    for (const input of inputMgr.produce(dt, stamped, now)) {
      transport.sendInput(input);
    }

    // --- loopback only: advance the in-process server (bot runs server-side) ---
    // const alpha = server.advance(dt);
    // --------------------------------------------------------------------------

    // Rebuild the view world from buffered snapshots: remote ships/bullets are
    // interpolated ~interpDelay in the past (smooth); the local ship is pinned
    // to the latest snapshot (still laggy — M2.4 adds prediction). The pose is
    // baked in with prev*===current, so alpha is a no-op here.
    interp.buildView(view, now, interpMs, view.localPlayerId, NET.extrapolateMaxMs);

    // M2.10: drop the delayed server copy of any *own* bomb explosion we already
    // drew from prediction. Only own-bomb (`owner === localId`) events are
    // candidates — everyone else's detonations come from the snapshot as usual —
    // and a match is consumed so it can't cancel a second, distinct explosion.
    // Ship-hit detonations (which prediction can't reproduce — the predicted world
    // has no remote ships) won't match a shown boom, so they still draw.
    suppressShownLocalBooms(view, now);

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
      // M2.10: surface this frame's predicted own-bomb detonations (deduped) as
      // real bombExploded events so the renderer draws them *now*, not a round-trip
      // later. Record each so its delayed server twin is suppressed above next
      // frame. The bomb still detonates server-authoritatively for damage — this
      // is the explosion *animation* only.
      for (const boom of predictor.drainNewExplosions()) {
        view.events.push({ type: "bombExploded", x: boom.x, y: boom.y, owner: view.localPlayerId });
        shownLocalBooms.push({ x: boom.x, y: boom.y, expiresMs: now + BOOM_TTL_MS });
      }
    }

    // M2.8: everyone else's shots come from the deterministic simulator (forward
    // from the latest snapshot to the ships' render time) instead of being lerped.
    // Bounces trace the real path; server-killed bullets retract via b-snapshot
    // cross-check. Appended alongside the predicted own-shots above.
    const remoteShots = remoteProjectiles.simulate(
      interp.snapshots,
      now,
      interpMs,
      view.localPlayerId,
      NET.extrapolateMaxMs,
    );
    for (const p of remoteShots) view.projectiles.push(p);

    renderer.draw(view, 1, dt, latestPings);

    // Drain events the interpolator released (in interpolated time) this frame.
    for (const e of view.events) {
      if (e.type === "shipDied")
        feed.add(killLine(view, e.killer, e.victim), now);
      // M2.9: tally hits the server awarded via lag-comp rewind, so the overlay
      // can show that "what you see is what you hit" is actually firing.
      if (e.type === "shipHit" && e.rewound) rewindHitCount++;
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

    // Netcode debug overlay — streamlined for the M2.12 decision (roadmap): is the
    // pain TCP loss/stalls (→ UDP transport) or just tuning we can still do? The
    // headline rows are `loss/stale` (snapshots the wire dropped / reordered — the
    // TCP head-of-line signal) and `extrap/freeze` (buffer starvation, the "ships
    // jump" symptom). `lagcomp …ms` + `clamp` show whether shots are still
    // under-compensated; `pred err` is prediction health. Per-milestone verification
    // detail (seqs, ticks, queue depths, proj counts) lived here through M2.10 — see
    // git history if a regression needs it back.

    // The rewind our shots carry: a predicted shot in flight carries the exact
    // server `compTicks`; otherwise show the un-clamped view delay clamped to the
    // cap. `compClamped` flags when the wanted rewind exceeds LAGCOMP.maxCompTicks —
    // the "bombs hit but don't register" failure mode.
    const predictedComp = predictor.predictedProjectiles.find((p) => (p.compTicks ?? 0) > 0)?.compTicks;
    const rawCompTicks = renderTick !== null ? Math.max(0, view.tick - renderTick) : 0;
    const compTicks = predictedComp ?? Math.min(rawCompTicks, LAGCOMP.maxCompTicks);
    const compMs = compTicks * TICK_DT * 1000;
    const compClamped = rawCompTicks > LAGCOMP.maxCompTicks;

    // Record this frame's health gauges (buffer/extrapolation from the same straddle
    // the interpolator used) and roll up the per-second rates shown below.
    const straddle = pickStraddlingPair(interp.snapshots, now - interpMs, NET.extrapolateMaxMs);
    const extrapMs = straddle?.extrapMs ?? 0;
    health.onFrame(dt, {
      bufferDepth: interp.snapshots.length,
      extrapMs,
      frozen: extrapMs >= NET.extrapolateMaxMs - 0.5,
      rawCompTicks,
      compClamped,
    });
    const hps = health.perSecond;

    netdebug.textContent =
      `── netcode (M2.11) ──\n` +
      `rtt ${inputMgr.rttMs.toFixed(0)}ms  jitter ±${health.jitterMs.toFixed(0)}ms\n` +
      `interp ${interpMs.toFixed(0)}ms  buf ${interp.snapshots.length}\n` +
      `loss ${hps.missed}/s  stale ${hps.stale}/s\n` +
      `extrap ${hps.extrapFrames}/s  freeze ${hps.freezeFrames}/s\n` +
      `lagcomp ${compMs.toFixed(0)}ms${compClamped ? " CLAMPED" : ""}  clamp ${hps.clampFrames}/s\n` +
      `rewind ${rewindHitCount}  pred err ${predictor.predictionErrorPx.toFixed(1)}px`;

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

/**
 * Resolve the local player's name client-side (M2.7), sent to the server in the
 * `hello` handshake. Precedence: an explicit `?name=` query param wins (handy for
 * opening two differently-named tabs), then a previously stored choice, then a
 * one-time prompt, falling back to a random `Player-NNNN` if the user dismisses
 * it. The chosen name is persisted so refreshes keep the same identity. The
 * polished in-game name entry is M3 (the bitmap-font UI toolkit); this is the
 * deliberately minimal debug-quality version.
 */
function resolvePlayerName(): string {
  const clamp = (s: string) => s.trim().slice(0, 20);

  const fromQuery = new URLSearchParams(location.search).get("name");
  if (fromQuery && clamp(fromQuery)) {
    const name = clamp(fromQuery);
    localStorage.setItem("playerName", name);
    return name;
  }

  const stored = localStorage.getItem("playerName");
  if (stored && clamp(stored)) return clamp(stored);

  const fallback = `Player-${Math.floor(1000 + Math.random() * 9000)}`;
  // `prompt` throws in sandboxed/embedded contexts (e.g. some preview iframes);
  // fall back to a random name there rather than crashing the client.
  let entered: string | null = null;
  try {
    entered = window.prompt("Choose your name:", fallback);
  } catch {
    entered = null;
  }
  const name = entered && clamp(entered) ? clamp(entered) : fallback;
  localStorage.setItem("playerName", name);
  return name;
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
