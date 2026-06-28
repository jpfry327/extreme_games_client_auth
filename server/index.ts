/**
 * Headless relay server — client-authoritative ("defender authority") model.
 *
 * The server is a **mirror + scoreboard relay**, not a combat authority
 * (`net/relayHost.ts`). It does NOT simulate human ships: it ingests each client's
 * authoritative `StateReportMsg` into a mirror world, runs only its own bot's
 * self-sim, scores human deaths from `DeathReportMsg` ("defender names the
 * killer"), and broadcasts per-client AOI-culled, delta-compressed binary
 * snapshots assembled from the mirror at ~33Hz. The snapshot pipeline
 * (codec/AOI/delta — M2.13/M2.14) is unchanged; only the *source* of the rows
 * moved from `world.step()` to client reports.
 *
 * Accepts WebSocket connections on PORT (default 3000). The Vite dev server
 * proxies `/ws` → `ws://localhost:3000`.
 *
 * Protocol (src/net/protocol.ts):
 *   Client → server: hello | state | death   (JSON text)
 *   Server → client: welcome | reject (JSON text) | snapshot (binary)
 *
 * Run with: npx tsx server/index.ts  (or `npm run server`).
 */

import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { WARBIRD, TICK_DT } from "../src/config";
import { quantizeSnapshot } from "../src/net/snapshotCodec";
import { SnapshotChannel } from "../src/net/serverSnapshots";
import { RelayHost } from "../src/net/relayHost";
import type { PlayerId } from "../src/sim/types";
import type { ClientMsg, ServerMsg } from "../src/net/protocol";
import { loadMapSync } from "./loadMap";

// Railway (and most PaaS hosts) inject the port to bind via process.env.PORT;
// fall back to 3000 so `npm run server` keeps working locally with no env set.
const PORT = parseInt(process.env.PORT ?? "3000", 10);
/** Broadcast a snapshot every N advance steps: 100 / 2 = 50 Hz. Higher than the
 *  old 33Hz to tighten the cadence of newly-fired remote projectiles (~+50%
 *  downstream, AOI-scoped to on-screen ships). */
const BROADCAST_EVERY = 2;
/** Measure each socket's round-trip time this often (ms) via WS ping/pong. */
const PING_EVERY_MS = 1000;

// ---------- sanity caps (M2.7) ------------------------------------------------
// Minimal abuse guards — not anti-cheat (which is deferred). They bound resource
// use so one bad/hostile client can't exhaust the server or bloat snapshots.

/** Max simultaneous human players. */
const MAX_PLAYERS = 16;
/** Max client→server messages per socket per second. State reports are ~60/s plus
 *  death re-sends; 300 leaves generous headroom while capping a flood. */
const MAX_MSGS_PER_SEC = 300;

// ---------- relay setup -------------------------------------------------------

const map = loadMapSync();
const relay = new RelayHost(map);

// Binary snapshot delta channel (M2.13) + per-client AOI culling (M2.14). Holds
// each client's acked baseline ring of the *filtered* snapshots it was sent.
const snapshots = new SnapshotChannel();

// ---------- client registry ---------------------------------------------------

interface Session {
  ws: WebSocket;
  playerId: PlayerId;
  name: string;
  /** Last measured round-trip time (ms), from WS ping/pong. */
  rttMs: number;
  /** `performance.now()` of the outstanding ping, or 0 if none is in flight. */
  pingSentAt: number;
  /** Messages received from this socket in the current rate-limit window. */
  msgsThisSec: number;
}
const sessions: Session[] = [];
let nextId = 1;

/** RTT (ms) by player id, rebuilt from the live sessions each broadcast and sent
 *  in every snapshot so clients can show ping on nametags (M2.7). */
function pingMap(): Record<PlayerId, number> {
  const pings: Record<PlayerId, number> = {};
  for (const s of sessions) pings[s.playerId] = s.rttMs;
  return pings;
}

function send(ws: WebSocket, msg: ServerMsg): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(): void {
  // Assemble the shared snapshot from the mirror once, quantize once (the encode
  // source + next baseline), then AOI-filter + delta-encode per client.
  const shared = relay.assembleSnapshot(pingMap());
  const quantized = quantizeSnapshot(shared);
  for (const s of sessions) {
    if (s.ws.readyState !== WebSocket.OPEN) continue;
    const ack = relay.ack(s.playerId);
    const bytes = snapshots.encodeFor(s.playerId, quantized, ack.lastProcessedInputSeq, ack.inputBufferDepth);
    s.ws.send(bytes);
  }
  relay.clearEvents();
}

// ---------- WebSocket server --------------------------------------------------

const httpServer = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("extreme_games server ok\n");
});
// Disable Nagle on every TCP connection (the WS upgrades ride these) so tiny
// per-frame report/snapshot/ping frames aren't batched into added latency (M2.11).
httpServer.on("connection", (socket) => socket.setNoDelay(true));
const wss = new WebSocketServer({ server: httpServer, perMessageDeflate: false });
httpServer.listen(PORT, () => {
  console.info(`[server] listening on port ${PORT}`);
});

wss.on("connection", (ws) => {
  let session: Session | null = null;

  ws.on("message", (raw) => {
    // Rate clamp (M2.7): drop messages past the per-second cap. Counter resets on
    // the 1Hz ping timer below.
    if (session) {
      if (session.msgsThisSec >= MAX_MSGS_PER_SEC) return;
      session.msgsThisSec++;
    }

    let msg: ClientMsg;
    try {
      msg = JSON.parse((raw as Buffer).toString()) as ClientMsg;
    } catch {
      return; // ignore malformed frames
    }

    if (msg.type === "hello") {
      if (session) return; // ignore a second hello on a live session
      if (sessions.length >= MAX_PLAYERS) {
        send(ws, { type: "reject", reason: "Arena full" });
        ws.close();
        console.info(`[x] ${msg.name} rejected — arena full (${sessions.length}/${MAX_PLAYERS})`);
        return;
      }
      const playerId: PlayerId = `p${nextId++}`;
      // Server assigns the spawn (returned in welcome); the client seeds its
      // LocalSim there and from then on owns its ship.
      const spawn = relay.pickSpawn();
      relay.addHuman(playerId, msg.name, 0, WARBIRD, spawn.x, spawn.y);
      session = { ws, playerId, name: msg.name, rttMs: 0, pingSentAt: 0, msgsThisSec: 0 };
      sessions.push(session);
      send(ws, { type: "welcome", playerId, spawnX: spawn.x, spawnY: spawn.y, seed: nextId });
      console.info(`[+] ${msg.name} → ${playerId}  (${sessions.length} connected)`);
    } else if (msg.type === "state" && session) {
      relay.ingestState(session.playerId, msg);
      // M2.13: the client piggybacks the newest snapshot tick it has decoded;
      // record it as that client's delta baseline for the next broadcast.
      if (msg.ackSnapshotTick !== undefined) {
        snapshots.onAck(session.playerId, msg.ackSnapshotTick);
      }
    } else if (msg.type === "death" && session) {
      relay.ingestDeath(msg);
    }
  });

  // WS-level pong → round-trip time for this socket (M2.7).
  ws.on("pong", () => {
    if (session && session.pingSentAt > 0) {
      session.rttMs = Math.round(performance.now() - session.pingSentAt);
      session.pingSentAt = 0;
    }
  });

  ws.on("close", () => {
    if (!session) return;
    relay.removeHuman(session.playerId);
    snapshots.remove(session.playerId);
    const i = sessions.indexOf(session);
    if (i !== -1) sessions.splice(i, 1);
    console.info(`[-] ${session.name} (${session.playerId}) left  (${sessions.length} connected)`);
    session = null;
  });

  ws.on("error", (err) => console.error("[server] socket error:", err.message));
});

// ---------- liveness / ping ---------------------------------------------------
// Once a second: WS-ping each socket (RTT) and reset the per-socket rate counter.
setInterval(() => {
  for (const s of sessions) {
    s.msgsThisSec = 0;
    if (s.ws.readyState === WebSocket.OPEN) {
      s.pingSentAt = performance.now();
      s.ws.ping();
    }
  }
}, PING_EVERY_MS);

// ---------- tick loop ---------------------------------------------------------

let last = performance.now();
let stepsSinceBroadcast = 0;

setInterval(() => {
  const now = performance.now();
  const dt = (now - last) / 1000;
  last = now;

  // Advance only the bot's self-sim (the human ships are mirrored from reports).
  relay.advance(dt);

  stepsSinceBroadcast++;
  if (stepsSinceBroadcast >= BROADCAST_EVERY) {
    // Events accumulate across the broadcast window and drain on broadcast (so an
    // event produced between broadcasts still rides a snapshot). `broadcast` clears
    // them via `relay.clearEvents()`.
    broadcast();
    stepsSinceBroadcast = 0;
  }
}, Math.round(TICK_DT * 1000));
