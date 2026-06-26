/**
 * Headless game server — M2.1.
 *
 * Runs the authoritative World + FixedLoop at 100Hz and broadcasts snapshots
 * to all connected clients at ~33Hz (every BROADCAST_EVERY ticks). The sim
 * rate and broadcast rate are intentionally decoupled: the game stays smooth
 * regardless of how many clients are serializing snapshots.
 *
 * Accepts WebSocket connections on PORT (default 3000). The Vite dev server
 * proxies `/ws` → `ws://localhost:3000`, so browser code always connects to
 * `/ws` and works identically in dev and production.
 *
 * Protocol: JSON per src/net/protocol.ts.
 *   Client → server: hello | input
 *   Server → client: welcome | snapshot
 *
 * Run with: npx tsx server/index.ts
 *   (or `npm run server` after the package.json script is wired up)
 */

import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { WARBIRD, TICK_DT } from "../src/config";
import { World } from "../src/sim/world";
import { FixedLoop } from "../src/sim/loop";
import type { Snapshot } from "../src/net/snapshot";
import { quantizeSnapshot } from "../src/net/snapshotCodec";
import { SnapshotChannel } from "../src/net/serverSnapshots";
import { ServerInputBuffer } from "../src/net/serverInput";
import { BOT_ID, BOT_NAME, computeBotInput } from "../src/sim/bot";
import type { InputCommand, PlayerId, StepContext } from "../src/sim/types";
import type { ClientMsg, ServerMsg } from "../src/net/protocol";
import { loadMapSync } from "./loadMap";

// Railway (and most PaaS hosts) inject the port to bind via process.env.PORT;
// fall back to 3000 so `npm run server` keeps working locally with no env set.
const PORT = parseInt(process.env.PORT ?? "3000", 10);
/** Broadcast a snapshot every N sim ticks: 100 / 3 ≈ 33 Hz. */
const BROADCAST_EVERY = 3;
/** Measure each socket's round-trip time this often (ms) via WS ping/pong. */
const PING_EVERY_MS = 1000;

// ---------- sanity caps (M2.7) ------------------------------------------------
// Minimal abuse guards — not anti-cheat. They bound resource use so one bad or
// hostile client can't exhaust the server or bloat snapshots.

/** Max simultaneous human players. Bounds snapshot size and the sim's per-tick
 *  cost; a `hello` past this is rejected and the socket closed. */
const MAX_PLAYERS = 16;
/** Max client→server messages per socket per second. At 100Hz the legit input
 *  stream is ~100 msg/s; this leaves generous headroom while capping a flood.
 *  Messages over the limit in a given second are dropped, not disconnected, so a
 *  brief burst (e.g. catch-up after a stall) is tolerated. */
const MAX_MSGS_PER_SEC = 300;

// ---------- world setup -------------------------------------------------------

const map = loadMapSync();
// seed=1 matches the client world seed for determinism; no local player on the server.
const world = new World(map, 1, false);
const loop = new FixedLoop(world);

// Seed the server with one bot so a solo player has someone to fight.
// The bot is just another player whose InputCommands come from the AI, not a
// socket — it lives fully server-side (M2.7). Its id/name are shared from
// sim/bot.ts so the buildCtx wiring below can route its input to the AI.
world.addPlayer(BOT_ID, BOT_NAME, 1, WARBIRD);

// Per-player sequenced input queues (M2.3). Consumed one command per tick in
// the step provider below; acked back to each client in its snapshot.
const inputs = new ServerInputBuffer();

// Binary snapshot delta channel (M2.13). Holds each client's acked baseline and
// a shared ring of recent quantized snapshots; turns the authoritative world into
// a per-client delta-compressed binary frame (keyframe when no baseline is usable).
const snapshots = new SnapshotChannel();

// ---------- client registry ---------------------------------------------------

interface Session {
  ws: WebSocket;
  playerId: PlayerId;
  name: string;
  /** Last measured round-trip time (ms), from WS ping/pong. 0 until the first
   *  pong returns. Mirrored into `pings` for the snapshot. */
  rttMs: number;
  /** `performance.now()` of the outstanding ping, or 0 if none is in flight. */
  pingSentAt: number;
  /** Messages received from this socket in the current rate-limit window. */
  msgsThisSec: number;
}
const sessions: Session[] = [];
let nextId = 1;

/** RTT (ms) by player id, rebuilt from the live sessions each broadcast and sent
 *  in every snapshot so clients can show ping on nametags (M2.7). The bot has no
 *  socket, so it's simply absent. */
function pingMap(): Record<PlayerId, number> {
  const pings: Record<PlayerId, number> = {};
  for (const s of sessions) pings[s.playerId] = s.rttMs;
  return pings;
}

function send(ws: WebSocket, msg: ServerMsg): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

/** Build the per-broadcast snapshot once from the *live* world — no per-client
 *  `structuredClone` (M2.13). It references the world's own player/projectile
 *  objects; it's consumed synchronously (quantized + encoded) before the next
 *  tick mutates them. The per-client input-ack fields are filled in per client by
 *  the channel, so they're left at 0 here. */
function buildSharedSnapshot(pings: Record<PlayerId, number>): Snapshot {
  return {
    tick: world.tick,
    players: [...world.players.values()],
    projectiles: world.projectiles,
    events: world.events,
    lastProcessedInputSeq: 0,
    inputBufferDepth: 0,
    pings,
  };
}

function broadcast(): void {
  const pings = pingMap();
  // One quantize per broadcast (fresh, f32-rounded objects), shared by every
  // client as both the encode source and the next baseline — this is the CPU win
  // over the old O(players × clients) clone.
  const quantized = quantizeSnapshot(buildSharedSnapshot(pings));
  snapshots.record(quantized);
  for (const s of sessions) {
    if (s.ws.readyState !== WebSocket.OPEN) continue;
    const bytes = snapshots.encodeFor(
      s.playerId,
      quantized,
      inputs.ack(s.playerId),
      inputs.depth(s.playerId),
    );
    s.ws.send(bytes);
  }
}

// ---------- WebSocket server --------------------------------------------------

// Attach the WebSocket server to a plain HTTP server rather than letting `ws`
// open its own bare socket. The HTTP layer answers Railway's health check on
// `GET /` with a 200 (a bare WebSocketServer answers nothing on plain HTTP, so
// the deploy would be marked unhealthy). WebSocket upgrades still ride this same
// port — Railway terminates TLS at its edge, so browsers connect over `wss://`.
const httpServer = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("extreme_games server ok\n");
});
// Disable Nagle's algorithm on every TCP connection (the WS upgrades ride these).
// Nagle batches small writes and, with delayed ACKs, can add tens of ms of latency
// to exactly the kind of traffic we send — tiny per-tick input frames, snapshots,
// and ping/pong — which is why the app-level ping reads well above the raw network
// path. Realtime games always want this off. (M2.11)
httpServer.on("connection", (socket) => socket.setNoDelay(true));
// `perMessageDeflate: false` — don't compress snapshots. Per-message compression
// adds CPU per broadcast (costly on a shared/free instance) and latency for no real
// win on already-small JSON; binary+delta (M2.13) is the right size lever. (M2.11)
const wss = new WebSocketServer({ server: httpServer, perMessageDeflate: false });
httpServer.listen(PORT, () => {
  console.info(`[server] listening on port ${PORT}`);
});

wss.on("connection", (ws) => {
  let session: Session | null = null;

  ws.on("message", (raw) => {
    // Rate clamp (M2.7): drop messages past the per-second cap rather than let a
    // flood grow the input buffer or burn CPU. Counter is reset by the 1Hz ping
    // timer below.
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
      // Ignore a second hello on a live session (the id is assigned once).
      if (session) return;
      // Sanity cap (M2.7): refuse joins past the arena's player limit. The bot
      // isn't a session, so `sessions.length` counts humans only.
      if (sessions.length >= MAX_PLAYERS) {
        send(ws, { type: "reject", reason: "Arena full" });
        ws.close();
        console.info(`[x] ${msg.name} rejected — arena full (${sessions.length}/${MAX_PLAYERS})`);
        return;
      }
      const playerId: PlayerId = `p${nextId++}`;
      // Server owns spawn assignment — addPlayer runs findSpawn server-side; the
      // client never picks a position (M2.7).
      world.addPlayer(playerId, msg.name, 0, WARBIRD);
      session = { ws, playerId, name: msg.name, rttMs: 0, pingSentAt: 0, msgsThisSec: 0 };
      sessions.push(session);
      send(ws, { type: "welcome", playerId });
      console.info(`[+] ${msg.name} → ${playerId}  (${sessions.length} connected)`);
    } else if (msg.type === "input" && session) {
      inputs.push(session.playerId, msg.input);
      // M2.13: the client piggybacks the newest snapshot tick it has decoded;
      // record it as that client's delta baseline for the next broadcast.
      if (msg.ackSnapshotTick !== undefined) {
        snapshots.onAck(session.playerId, msg.ackSnapshotTick);
      }
    }
  });

  // WS-level pong → round-trip time for this socket (M2.7). The ping is sent by
  // the 1Hz timer below; the latency is now minus when that ping went out.
  ws.on("pong", () => {
    if (session && session.pingSentAt > 0) {
      session.rttMs = Math.round(performance.now() - session.pingSentAt);
      session.pingSentAt = 0;
    }
  });

  ws.on("close", () => {
    if (!session) return;
    world.players.delete(session.playerId);
    inputs.remove(session.playerId);
    snapshots.remove(session.playerId);
    const i = sessions.indexOf(session);
    if (i !== -1) sessions.splice(i, 1);
    console.info(`[-] ${session.name} (${session.playerId}) left  (${sessions.length} connected)`);
    session = null;
  });

  ws.on("error", (err) => console.error("[server] socket error:", err.message));
});

// ---------- liveness / ping ---------------------------------------------------
// Once a second: send each socket a WS ping (the pong handler above turns it into
// an RTT measurement) and reset the per-socket message-rate counter.
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
let ticksSinceBroadcast = 0;

// Build the per-tick step context: pull one buffered command per human player
// (repeating their last on a gap), and compute the bot from the current world —
// i.e. the state left by the previous tick (buildCtx runs before step). Called
// once per sim tick by FixedLoop, so a frame covering several ticks consumes
// several queued commands, in order.
function buildCtx(): StepContext {
  const map = new Map<PlayerId, InputCommand>();
  for (const id of world.players.keys()) {
    map.set(id, id === BOT_ID ? computeBotInput(world, id) : inputs.next(id));
  }
  return { inputs: map };
}

setInterval(() => {
  const now = performance.now();
  const dt = (now - last) / 1000;
  last = now;

  loop.advance(dt, buildCtx);

  ticksSinceBroadcast++;
  if (ticksSinceBroadcast >= BROADCAST_EVERY) {
    // Drain events on *broadcast*, not on *tick*. The sim runs at 100Hz but we
    // only broadcast at ~33Hz; clearing every tick (the old bug) wiped events
    // produced on the 4 in-between ticks before any snapshot could carry them,
    // so kills/explosions/hits on those ticks never reached the client. Letting
    // world.events accumulate across the whole broadcast window and clearing it
    // immediately after the broadcast (which quantizes + encodes a fresh copy of
    // them per the M2.13 codec) makes world.events the buffer that drains on
    // broadcast.
    broadcast();
    world.events.length = 0;
    ticksSinceBroadcast = 0;
  }
}, Math.round(TICK_DT * 1000));
