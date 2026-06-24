/**
 * In-process authoritative game server — the M2.0 foundation.
 *
 * `GameServer` owns the authoritative `World` and its `FixedLoop`. It ingests
 * per-player `InputCommand`s and advances the sim at 100Hz, then broadcasts a
 * snapshot to every connected client. In M2.0 the only transport is the
 * `LoopbackTransport` (zero-delay, in-process); M2.1 swaps in a WebSocket
 * transport over the same `ClientConnection` interface.
 *
 * The server is deliberately ignorant of rendering: it imports only `sim/` and
 * `config`, proving that `sim/` is pure (architecture §1 — the golden rule).
 */

import { WARBIRD } from "../config";
import { FixedLoop } from "../sim/loop";
import type { PlayerId, StepContext, InputCommand } from "../sim/types";
import { LOCAL_PLAYER_ID, World } from "../sim/world";
import type { GameMap } from "../sim/gamemap";
import { serializeSnapshotFor, type Snapshot } from "./snapshot";

/** The M1 bot — stays a second player driven by AI until M2.7 moves it here
 *  fully server-side. Defined here so server and client share the same id. */
export const BOT_PLAYER_ID: PlayerId = "bot";

/**
 * The interface the server uses to deliver snapshots to clients.
 * `LoopbackTransport` implements this; a future `WebSocketSession` will too.
 * Keeping it here avoids a circular import: server.ts → snapshot.ts;
 * transport.ts → server.ts (one-way).
 */
export interface ClientConnection {
  /** The player id this client is controlling. */
  readonly localPlayerId: PlayerId;
  /** Called synchronously (loopback) or asynchronously (WebSocket) by the
   *  server after each advance to deliver the latest state. */
  deliverSnapshot(snap: Snapshot): void;
}

export class GameServer {
  private readonly world: World;
  private readonly loop: FixedLoop;
  private readonly inputBuffer = new Map<PlayerId, InputCommand>();
  private clients: ClientConnection[] = [];

  constructor(map: GameMap) {
    // World auto-adds the LOCAL_PLAYER_ID; we also add the combat bot.
    this.world = new World(map);
    this.world.addPlayer(BOT_PLAYER_ID, "Roaming Bot", 1, WARBIRD);
    this.loop = new FixedLoop(this.world);
  }

  /** Register a client to receive snapshots. Called by the transport on connect. */
  connectClient(client: ClientConnection): void {
    this.clients.push(client);
  }

  /** Remove a client on disconnect. */
  disconnectClient(client: ClientConnection): void {
    this.clients = this.clients.filter((c) => c !== client);
  }

  /** Buffer an input command for a player. The server applies buffered inputs on
   *  the next advance() call. Each player's latest input overwrites any earlier
   *  one from the same frame (last-write-wins within a render frame). */
  enqueueInput(playerId: PlayerId, cmd: InputCommand): void {
    this.inputBuffer.set(playerId, cmd);
  }

  /**
   * Advance the authoritative sim by `dtSeconds` (same semantics as
   * `FixedLoop.advance`) and broadcast a snapshot to every connected client.
   * Returns the interpolation alpha so the caller can pass it to the renderer.
   *
   * Events are cleared at the top of each advance so each snapshot carries only
   * the events produced *this frame*. The previous frame's events were already
   * captured in the last snapshot and delivered to clients.
   *
   * In M2.0 this is called once per render frame; the loopback transport delivers
   * snapshots synchronously inside this call before it returns.
   */
  advance(dtSeconds: number): number {
    // Clear events from the previous frame before ticking. The sim accumulates
    // new events during step(); the snapshot below captures them fresh.
    this.world.events.length = 0;

    const ctx: StepContext = { inputs: new Map(this.inputBuffer) };
    const alpha = this.loop.advance(dtSeconds, ctx);

    for (const client of this.clients) {
      const snap = serializeSnapshotFor(this.world, client.localPlayerId);
      client.deliverSnapshot(snap);
    }

    return alpha;
  }

  /**
   * Direct access to the authoritative world — valid in the in-process loopback
   * only. Used by main.ts to set the player name before the first tick and to
   * run the bot AI against the latest world state.
   * M2.1 removes this: over a real socket the client never touches server state.
   */
  get authoritativeWorld(): World {
    return this.world;
  }

  /** The local player id the server recognizes (mirrors World.localPlayerId). */
  get localPlayerId(): PlayerId {
    return LOCAL_PLAYER_ID;
  }
}
