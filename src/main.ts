import { COMBAT, NET, TICK_DT, TICK_HZ, WARBIRD } from "./config";
import { Keyboard } from "./input/keyboard";
import { keyboardLockSupported, toggleFullscreen } from "./input/fullscreen";
import { loadMap } from "./map/loader";
import { isAlive } from "./sim/player";
import { World } from "./sim/world";
import type { Player, PlayerId } from "./sim/types";
import { Renderer } from "./render/renderer";
import { WebSocketTransport } from "./net/WebSocketTransport";
import { SimulatedTransport } from "./net/networkSimulator";
import { SnapshotInterpolator, pickStraddlingPair } from "./net/interpolation";
import { RemoteProjectileSimulator } from "./net/remoteProjectiles";
import { LocalSim } from "./net/localSim";
import { CosmeticHitDetector } from "./net/cosmeticHits";
import { ReportSender } from "./net/reportSender";
import type { DeathReportMsg, StateReportMsg } from "./net/protocol";
import { NetHealth } from "./net/netHealth";
import { AdaptiveInterpDelay } from "./net/adaptiveInterp";
import { AudioKeepAlive } from "./audioKeepAlive";

// To run without a server (in-process loopback), add these imports and use the
// loopback block below in place of the WebSocket one:
//   import { GameServer } from "./net/server";
//   import { LoopbackTransport } from "./net/transport";

async function main() {
  const mount = document.getElementById("app")!;
  const hud = document.getElementById("hud")!;
  const killfeed = document.getElementById("killfeed")!;
  const netdebug = document.getElementById("netdebug")!;

  // 1. Load the map.
  const map = await loadMap();

  // 2. The view world — never stepped. The interpolator rebuilds it each frame
  //    from buffered snapshots: remote ships are interpolated ~interpDelay in the
  //    past (they glide instead of snapping at ~33Hz); the local ship is overlaid
  //    from our own authoritative LocalSim below.
  const view = new World(map, 1, false);
  const interp = new SnapshotInterpolator();
  // Remote players' projectiles are simulated deterministically forward from the
  // latest snapshot (so they bounce off walls in real time) and rendered at the
  // same render time as remote ships (now − interpDelay).
  const remoteProjectiles = new RemoteProjectileSimulator(map);
  // Visual-only hit feedback: in the defender-authority model our own shots are
  // never tested against enemies on our screen, so they sail *through* them until
  // the relayed reaction returns. This detects an own shot overlapping an enemy as
  // drawn and lets us show the spark/blast immediately (never touches damage).
  const cosmeticHits = new CosmeticHitDetector();

  // --- Client-authoritative relay model ---
  // LocalSim is our ship's authoritative self-sim (created on `welcome`). We free-
  // run it at 100Hz, adjudicate incoming remote shots against it, and report our
  // state; the server is a mirror/relay. Null until connected.
  let localSim: LocalSim | null = null;
  let localId: PlayerId | null = null;
  // Paces the state uplink (~60Hz). State is last-wins, so loss needs no redundancy.
  const reportSender = new ReportSender();
  let reportSeq = 0;
  // The fixed-timestep accumulator that drives LocalSim at 100Hz (like FixedLoop).
  let simAccumulator = 0;
  // Our self-reported death, set when we die on our own screen and re-sent every
  // report-tick until we respawn (so a dropped death datagram still lands — the
  // server dedups by death count). Null while alive.
  let localDeath: DeathReportMsg | null = null;
  // The server's copy of our own player from the latest snapshot — we ignore its
  // pose/energy (LocalSim is authoritative) but read the server-owned scoreboard
  // fields (kills, score) from it for the HUD.
  let serverLocal: Player | null = null;

  // Net-health telemetry for the overlay + the adaptive interpolation-delay feed.
  const health = new NetHealth();
  const adaptiveInterp = new AdaptiveInterpDelay(NET.adaptiveInterp, NET.interpDelayMs);
  let latestPings: Record<string, number> = {};
  // Newest snapshot tick accepted; jitter can deliver snapshots out of order, so an
  // older-tick snapshot is stale and dropped to keep the buffer monotonic.
  let newestSnapTick = -1;

  // 3. Input + renderer — initialize NOW so the canvas is on screen while we
  //    connect. The game loop runs in "connecting…" mode until welcome.
  const keyboard = new Keyboard();
  // Background-tab keep-alive: started on the first keypress (a user gesture, as
  // the autoplay policy requires) so the authoritative self-sim keeps running when
  // the tab is hidden instead of freezing into an unkillable ghost (relay model).
  const keepAlive = new AudioKeepAlive();

  window.addEventListener("keydown", (e) => {
    keepAlive.start();
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

  // 4. Connect to the relay server over WebSocket (Vite proxies /ws → :3000).
  const serverUrl = import.meta.env.VITE_SERVER_URL ?? `ws://${location.host}/ws`;
  const playerName = resolvePlayerName();
  const socket = new WebSocketTransport(serverUrl, playerName);

  // --- loopback alternative (no server needed) ---
  // const server = new GameServer(map);
  // const socket = new LoopbackTransport(server, server.localPlayerId);
  // // `socket.start()` fires `onConnected` (below) synchronously with the spawn +
  // // seed, exactly like the WebSocket welcome — onConnected/onRejected work as-is.
  // // Then drive the in-process server once per frame: add `server.advance(dt);`
  // // inside frame() right after `reportSender.update(...)`, so the state report is
  // // ingested before the snapshot is delivered.
  // ------------------------------------------------

  // Wrap the real transport in the network simulator (latency / jitter / loss).
  const transport = new SimulatedTransport(socket, NET.netSim);

  // Snapshot handler: buffer for interpolation, feed incoming remote shots to our
  // LocalSim for adjudication, and capture the server-owned scoreboard for us. We
  // do NOT reconcile our own ship — LocalSim is authoritative for it.
  transport.setSnapshotHandler((snap) => {
    if (snap.tick <= newestSnapTick) {
      health.onStaleSnapshot();
      return;
    }
    newestSnapTick = snap.tick;

    const now = performance.now();
    health.onSnapshot(snap.tick, now);
    interp.push(snap, now);

    if (localSim && localId !== null) {
      // Adjudicate incoming remote shots against our own ship: inject every shot we
      // don't own (deduped by id inside LocalSim). LocalSim holds each by the interp
      // delay so it's hit-tested where it's drawn ("what you see is what hits you").
      const incoming = snap.projectiles.filter((p) => p.owner !== localId);
      localSim.injectIncoming(incoming);
      // Retract any previously-injected shot that has vanished from this report — the
      // owner's copy died (wall / a third player) before our copy finished flying, so
      // it must stop being a threat instead of soldiering on as a ghost bullet.
      localSim.reconcileIncoming(new Set(incoming.map((p) => p.id)));
      serverLocal = snap.players.find((p) => p.id === localId) ?? serverLocal;
    }

    latestPings = snap.pings;
  });

  // `connected` flips true once the server sends `welcome` and we know our id +
  // spawn. The render loop runs in "connecting…" mode until then.
  let connected = false;
  let rejected: string | null = null;
  socket.onConnected = (playerId, spawn, seed) => {
    localId = playerId;
    view.localPlayerId = playerId;
    localSim = new LocalSim(map, [playerId], seed);
    localSim.addOwned(playerId, playerName, 0, WARBIRD, spawn.x, spawn.y);
    connected = true;
    console.info(`[client] connected as ${playerId} @ (${spawn.x.toFixed(0)}, ${spawn.y.toFixed(0)})`);
  };
  socket.onRejected = (reason) => {
    rejected = reason;
    console.warn(`[client] join rejected: ${reason}`);
  };
  transport.start();

  setupNetSimPanel(transport);

  // 5. Render loop. Starts immediately so the canvas is live during "connecting…".
  let last = performance.now();
  let fpsAccum = 0;
  let fpsFrames = 0;
  let fps = 0;

  // Keep the authoritative self-sim alive across tab backgrounding (relay model).
  // While hidden, rAF is paused, so `scheduleNext` drives the loop off a timer and
  // the audio keep-alive stops that timer being throttled to 1Hz — the ship keeps
  // moving, reporting, and dying normally. On return to the foreground, drop any
  // incoming-shot backlog (so a stall doesn't flush a lethal barrage in one tick)
  // and reset the catch-up clock so we don't run a giant accumulator step.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      keepAlive.start();
    } else {
      localSim?.clearIncoming();
      simAccumulator = 0;
      last = performance.now();
    }
  });

  // rAF is paused for hidden tabs, so when hidden we step the loop off a timer at
  // ~sim cadence (kept near real-time by the keep-alive); visible, we use rAF.
  function scheduleNext(): void {
    if (document.hidden) {
      setTimeout(() => frame(performance.now()), 1000 / TICK_HZ);
    } else {
      requestAnimationFrame(frame);
    }
  }

  function frame(now: number) {
    const dt = (now - last) / 1000;
    last = now;

    if (rejected) {
      hud.textContent = `Couldn't join: ${rejected}`;
      return; // stop the loop — the server closed the socket
    }
    if (!connected || !localSim || localId === null) {
      hud.textContent = "connecting…";
      scheduleNext();
      return;
    }

    // Ease the interpolation delay toward the measured link, then use it everywhere
    // this frame so ships and bullets stay on one timeline.
    adaptiveInterp.update(health.meanIntervalMs, health.jitterMs, dt);
    const interpMs = adaptiveInterp.ms;
    // Hold incoming remote shots by the same delay their drawn copies lag by, so the
    // overlap that kills us is the overlap we can see (no "dodged it on screen but
    // died"). Tracks the adaptive delay so a jittery link stays consistent.
    localSim.setIncomingDelayMs(interpMs);

    // (a) Advance our authoritative LocalSim at fixed 100Hz with this frame's input.
    //     Each catch-up tick shares the one keyboard sample (the human pressed keys
    //     once this frame). LocalSim injects any pending incoming shots before each
    //     step, so they're flown + adjudicated against our ship at the present.
    const sample = keyboard.sample();
    const input = new Map([[localId, sample]]);
    simAccumulator += Math.min(dt, 0.25);
    while (simAccumulator >= TICK_DT) {
      localSim.step(input);
      simAccumulator -= TICK_DT;
    }

    // (b) Drain LocalSim's own events (our perspective): our death → a death report;
    //     hit/bomb/spawn effects → the renderer. Captured before the server's relayed
    //     copies so we can suppress the server's duplicate of our own death below.
    const me = localSim.owned(localId)!;
    const localEvents = localSim.world.events.slice();
    localSim.world.events.length = 0;
    for (const e of localEvents) {
      if (e.type === "shipDied" && e.victim === localId) {
        // We died on our own screen — authoritative. Name the killer and report it
        // (re-sent each report-tick until respawn; the server dedups by death count).
        localDeath = {
          type: "death",
          victim: localId,
          deaths: me.combat.deaths,
          killer: e.killer,
          bounty: e.bounty,
          x: e.x,
          y: e.y,
        };
      }
    }
    if (me.combat.respawnAt === 0) localDeath = null; // alive again — stop reporting the death

    // (c) Report our authoritative state (+ the death while dead), paced ~60Hz.
    reportSender.update(dt, now, () => {
      reportSeq++;
      const report: StateReportMsg = {
        type: "state",
        seq: reportSeq,
        tick: localSim!.world.tick,
        player: me,
        projectiles: localSim!.ownProjectiles(),
      };
      transport.sendState(report);
      if (localDeath) transport.sendDeath(localDeath);
    });

    // While hidden the sim + report above still run (so we float + die normally),
    // but there's nothing to draw — rAF is paused and the canvas is offscreen — so
    // skip all the view/render/HUD work below and reschedule off the timer.
    if (document.hidden) {
      scheduleNext();
      return;
    }

    // (d) Build the view from snapshots (remotes interpolated in the past), then
    //     overlay our own ship from LocalSim (present, authoritative). Kills/score
    //     come from the server (serverLocal); everything else from LocalSim.
    interp.buildView(view, now, interpMs, localId, NET.extrapolateMaxMs);
    if (serverLocal) {
      me.combat.kills = serverLocal.combat.kills;
      me.combat.score = serverLocal.combat.score;
    }
    view.players.set(localId, me);

    // Drop the server's relayed duplicates of our *own* effects — we draw them
    // locally instead, so they aren't shown twice (~1 RTT late):
    //   • our death (from our local shipDied event),
    //   • our bomb detonations (a local wall/expiry blast, or a cosmetic blast on
    //     an enemy below), and
    //   • our hit sparks (the cosmetic spark below).
    if (view.events.length > 0) {
      view.events = view.events.filter(
        (e) =>
          !(e.type === "shipDied" && e.victim === localId) &&
          !(e.type === "bombExploded" && e.owner === localId) &&
          !(e.type === "shipHit" && e.by === localId),
      );
    }
    for (const e of localEvents) view.events.push(e);

    // (e) Projectiles: our own shots from LocalSim (present), everyone else's from
    //     the deterministic remote simulator (rendered at the ships' render time).
    //
    //     Visual-only hit feedback (defender-authority model): our own shots are
    //     never adjudicated against enemies on our screen, so they'd sail *through*
    //     them. Detect an own shot overlapping an enemy *as drawn* and: show the
    //     spark (bullet) / blast (bomb) immediately, stop drawing that shot, and
    //     drop our local copy. The defender still owns the real hit — this is
    //     purely cosmetic (and may, like Subspace, occasionally mark a miss).
    const ownShots = localSim.ownProjectiles();
    const enemies = [...view.players.values()].filter((p) => p.id !== localId);
    for (const h of cosmeticHits.detect(ownShots, enemies)) {
      if (h.kind === "bomb") {
        view.events.push({ type: "bombExploded", x: h.x, y: h.y, owner: localId });
      } else {
        view.events.push({ type: "shipHit", target: h.target, by: localId, damage: 0, x: h.x, y: h.y, fatal: false });
      }
    }
    for (const p of ownShots) {
      if (!cosmeticHits.isHit(p.id)) view.projectiles.push(p);
    }
    // Drop the spent copies so a bullet doesn't fly on and a missed bomb doesn't
    // stray-detonate on a far wall (the defender's injected copy is unaffected).
    localSim.dropOwnProjectiles((id) => cosmeticHits.isHit(id));
    const remoteShots = remoteProjectiles.simulate(
      interp.snapshots,
      now,
      interpMs,
      localId,
      NET.extrapolateMaxMs,
    );
    for (const p of remoteShots) view.projectiles.push(p);

    renderer.draw(view, 1, dt, latestPings);

    // Drain events for the kill feed + our own bounty credit. The renderer already
    // drew the effects above.
    for (const e of view.events) {
      if (e.type !== "shipDied") continue;
      feed.add(killLine(view, e.killer, e.victim), now);
      // We killed someone (server-relayed credit): bump our own bounty — bounty is
      // client-owned in the relay model, the server only tracks kills/score. Known
      // trade-off: if the snapshot carrying this event is dropped (only possible
      // under the #netsim simulator — the real WebSocket is TCP-reliable), this +N
      // is missed; kills/score are unaffected and bounty resets on our next death.
      if (e.killer === localId && e.victim !== localId) {
        me.combat.bounty += COMBAT.bountyIncreaseForKill;
      }
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
    const k = me.kinematics;
    const speed = Math.hypot(k.vx, k.vy);
    const status = isAlive(me)
      ? `energy ${me.resources.energy.toFixed(0)}`
      : `RESPAWNING in ${((me.combat.respawnAt - localSim.world.tick) / TICK_HZ).toFixed(1)}s`;
    hud.textContent =
      `fps ${fps}  (sim ${TICK_HZ}Hz)\n` +
      `pos ${k.x.toFixed(0)}, ${k.y.toFixed(0)}\n` +
      `speed ${speed.toFixed(2)} px/tick\n` +
      `${status}\n` +
      `bounty ${me.combat.bounty}  score ${me.combat.score}  ` +
      `${me.combat.kills}-${me.combat.deaths} (K-D)\n` +
      `projectiles ${view.projectiles.length}`;

    // Netcode debug overlay — relay model: link health + the upstream report rate.
    const straddle = pickStraddlingPair(interp.snapshots, now - interpMs, NET.extrapolateMaxMs);
    const extrapMs = straddle?.extrapMs ?? 0;
    health.onFrame(dt, {
      bufferDepth: interp.snapshots.length,
      extrapMs,
      frozen: extrapMs >= NET.extrapolateMaxMs - 0.5,
      rawCompTicks: 0,
      compClamped: false,
    });
    const hps = health.perSecond;
    const ping = Math.round(latestPings[localId] ?? 0);
    netdebug.textContent =
      `── netcode (relay) ──\n` +
      `ping ${ping}ms\n` +
      `jitter ±${health.jitterMs.toFixed(0)}ms\n` +
      `up ${reportSender.sendRateHz.toFixed(0)}/s (state reports)\n` +
      `interp ${interpMs.toFixed(0)}ms  buf ${interp.snapshots.length}\n` +
      `loss ${hps.missed}/s  stale ${hps.stale}/s\n` +
      `extrap ${hps.extrapFrames}/s  freeze ${hps.freezeFrames}/s`;

    scheduleNext();
  }
  scheduleNext();
}

/**
 * Resolve the local player's name client-side, sent to the server in the `hello`
 * handshake. Precedence: `?name=` query param, then a stored choice, then a
 * one-time prompt, falling back to a random `Player-NNNN`.
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
 * live simulator params. Mutating `transport.params` in place changes the
 * conditions immediately, so bad networks are reproducible on demand.
 */
function setupNetSimPanel(transport: SimulatedTransport): void {
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const enabled = $<HTMLInputElement>("ns-enabled");
  const latency = $<HTMLInputElement>("ns-latency");
  const jitter = $<HTMLInputElement>("ns-jitter");
  const loss = $<HTMLInputElement>("ns-loss");
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
