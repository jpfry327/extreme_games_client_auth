/**
 * The Node relay (netcode §6). Deliberately thin: **no `World`, no `step()`.**
 * It accepts WebSocket connections, keeps a roster, and does three jobs —
 * assign identity, announce enter/leave, and fan out position packets. It runs
 * no physics; this mirrors eg-asss (a relay + validator + fan-out, not a
 * simulator).
 *
 * It imports the very same `protocol.ts` the client does, so the two can never
 * disagree about packet shape.
 *
 * M2.0 area-of-interest = **send everyone everything** (netcode §6.4: build the
 * per-client seam but ship the trivial version first). The `fanOut` helper is
 * that seam — later it filters by screen distance.
 *
 * Run with: `npm run server` (tsx). Listens on :8080.
 */

import { WebSocketServer, WebSocket } from "ws";
import {
  decode,
  encode,
  type NetMessage,
  type PositionMessage,
  type RemoteInfo,
} from "../src/net/protocol";

const PORT = 8080;

interface Client {
  id: string;
  ws: WebSocket;
  info: RemoteInfo | null; // null until `hello` arrives
}

const clients = new Map<string, Client>();
let nextId = 1;

const wss = new WebSocketServer({ port: PORT });
console.log(`[relay] listening :${PORT}`);

wss.on("connection", (ws) => {
  const id = `p${nextId++}`;
  const client: Client = { id, ws, info: null };
  clients.set(id, client);
  console.log(`[relay] connect ${id} (${clients.size} online)`);

  ws.on("message", (raw) => {
    let msg: NetMessage;
    try {
      msg = decode(raw.toString());
    } catch {
      return; // drop malformed frames
    }
    handle(client, msg);
  });

  ws.on("close", () => {
    clients.delete(id);
    console.log(`[relay] disconnect ${id} (${clients.size} online)`);
    broadcast({ t: "leave", id }, id);
  });

  ws.on("error", () => ws.close());
});

function handle(client: Client, msg: NetMessage): void {
  switch (msg.t) {
    case "hello": {
      // Learn the joiner's identity, then admit them to the arena.
      client.info = {
        id: client.id,
        name: msg.name,
        team: msg.team,
        shipType: msg.shipType,
        x: 0, // real pose arrives with the first position packet (<100ms)
        y: 0,
      };
      const roster = [...clients.values()]
        .filter((c) => c.info && c.id !== client.id)
        .map((c) => c.info!);
      send(client, { t: "welcome", id: client.id, players: roster });
      broadcast({ t: "enter", player: client.info }, client.id);
      break;
    }
    case "pos": {
      // Stamp the sender, remember last pose (for future AOI), fan out to all
      // other clients. The relay never simulates — it only relabels and relays.
      if (client.info) {
        client.info.x = msg.x;
        client.info.y = msg.y;
      }
      const stamped: PositionMessage = { ...msg, id: client.id };
      fanOut(client, encode(stamped));
      break;
    }
    // welcome/enter/leave are S2C only; a client should never send them.
  }
}

/** Fan a position packet out to every *other* client. M2.0: everyone, no AOI. */
function fanOut(from: Client, data: string): void {
  for (const c of clients.values()) {
    if (c.id === from.id) continue;
    if (c.ws.readyState === WebSocket.OPEN) c.ws.send(data);
  }
}

/** Send a reliable control message to every client except `exceptId`. */
function broadcast(msg: NetMessage, exceptId?: string): void {
  const data = encode(msg);
  for (const c of clients.values()) {
    if (c.id === exceptId) continue;
    if (c.ws.readyState === WebSocket.OPEN) c.ws.send(data);
  }
}

/** Send one message to a single client. */
function send(client: Client, msg: NetMessage): void {
  if (client.ws.readyState === WebSocket.OPEN) client.ws.send(encode(msg));
}
