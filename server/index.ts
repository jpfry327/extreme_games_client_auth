/**
 * Headless game server — M2.1.
 *
 * Runs the authoritative World + FixedLoop at 100Hz and broadcasts snapshots
 * to all connected clients at ~20Hz (every BROADCAST_EVERY ticks). The sim
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

import { WebSocketServer, WebSocket } from "ws";
import { WARBIRD, TICK_DT } from "../src/config";
import { World } from "../src/sim/world";
import { FixedLoop } from "../src/sim/loop";
import { serializeSnapshotFor } from "../src/net/snapshot";
import { ServerInputBuffer } from "../src/net/serverInput";
import { computeBotInput } from "../src/sim/bot";
import type { InputCommand, PlayerId, StepContext } from "../src/sim/types";
import type { ClientMsg, ServerMsg } from "../src/net/protocol";
import { loadMapSync } from "./loadMap";

const PORT = 3000;
/** Broadcast a snapshot every N sim ticks: 100 / 5 = 20 Hz. */
const BROADCAST_EVERY = 5;
const BOT_ID: PlayerId = "bot";

// ---------- world setup -------------------------------------------------------

const map = loadMapSync();
// seed=1 matches the client world seed for determinism; no local player on the server.
const world = new World(map, 1, false);
const loop = new FixedLoop(world);

// Seed the server with one bot so a solo player has someone to fight.
// The bot is just another player whose InputCommands come from the AI, not a socket.
world.addPlayer(BOT_ID, "ChaosBot", 1, WARBIRD);

// Per-player sequenced input queues (M2.3). Consumed one command per tick in
// the step provider below; acked back to each client in its snapshot.
const inputs = new ServerInputBuffer();

// ---------- client registry ---------------------------------------------------

interface Session {
  ws: WebSocket;
  playerId: PlayerId;
  name: string;
}
const sessions: Session[] = [];
let nextId = 1;

function send(ws: WebSocket, msg: ServerMsg): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(): void {
  for (const s of sessions) {
    const snap = serializeSnapshotFor(world, s.playerId, {
      lastProcessedInputSeq: inputs.ack(s.playerId),
      inputBufferDepth: inputs.depth(s.playerId),
    });
    send(s.ws, { type: "snapshot", snap });
  }
}

// ---------- WebSocket server --------------------------------------------------

const wss = new WebSocketServer({ port: PORT });
console.info(`[server] listening on ws://localhost:${PORT}`);

wss.on("connection", (ws) => {
  let session: Session | null = null;

  ws.on("message", (raw) => {
    const msg = JSON.parse((raw as Buffer).toString()) as ClientMsg;

    if (msg.type === "hello") {
      const playerId: PlayerId = `p${nextId++}`;
      world.addPlayer(playerId, msg.name, 0, WARBIRD);
      session = { ws, playerId, name: msg.name };
      sessions.push(session);
      send(ws, { type: "welcome", playerId });
      console.info(`[+] ${msg.name} → ${playerId}  (${sessions.length} connected)`);
    } else if (msg.type === "input" && session) {
      inputs.push(session.playerId, msg.input);
    }
  });

  ws.on("close", () => {
    if (!session) return;
    world.players.delete(session.playerId);
    inputs.remove(session.playerId);
    const i = sessions.indexOf(session);
    if (i !== -1) sessions.splice(i, 1);
    console.info(`[-] ${session.name} (${session.playerId}) left  (${sessions.length} connected)`);
    session = null;
  });

  ws.on("error", (err) => console.error("[server] socket error:", err.message));
});

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
    // only broadcast at 20Hz; clearing every tick (the old bug) wiped events
    // produced on the 4 in-between ticks before any snapshot could carry them,
    // so kills/explosions/hits on those ticks never reached the client. Letting
    // world.events accumulate across the whole broadcast window and clearing it
    // immediately after serializing (serializeSnapshotFor deep-clones it per
    // client) makes world.events the buffer that drains on broadcast.
    broadcast();
    world.events.length = 0;
    ticksSinceBroadcast = 0;
  }
}, Math.round(TICK_DT * 1000));
