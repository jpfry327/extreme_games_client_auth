/**
 * Client-side transport abstraction — the boundary between the client and the
 * authoritative server (architecture §5).
 *
 * `Transport` is the interface every client uses: send your `InputCommand`,
 * register a handler for incoming snapshots. M2.0 ships a `LoopbackTransport`
 * (in-process, zero latency); M2.1 will add `WebSocketTransport` that swaps in
 * over the same interface with a one-line change in main.ts.
 *
 * `LoopbackTransport` also implements `ClientConnection` (server.ts) so the
 * server can call `deliverSnapshot` on it directly.
 */

import type { InputCommand, PlayerId } from "../sim/types";
import { type ClientConnection, type GameServer } from "./server";
import type { Snapshot } from "./snapshot";

export type SnapshotHandler = (snap: Snapshot) => void;

/** The client-side view of the transport. One instance per client session. */
export interface Transport {
  /** Send the local player's intent for this tick to the server. */
  sendInput(cmd: InputCommand): void;
  /** Register the callback that receives each incoming snapshot. */
  setSnapshotHandler(cb: SnapshotHandler): void;
  start(): void;
  dispose(): void;
}

/**
 * In-process transport with zero latency. Used in M2.0 to test the snapshot
 * model before any sockets exist. The `GameServer.advance()` call delivers the
 * snapshot synchronously by calling `deliverSnapshot` on this object.
 *
 * `sendInputAs` is a loopback-only escape hatch for feeding the M1 bot from
 * main.ts. It is NOT on the `Transport` interface (real clients can only send
 * their own input). The bot moves server-side in M2.7 and this method goes away.
 */
export class LoopbackTransport implements Transport, ClientConnection {
  private snapshotHandler: SnapshotHandler | null = null;

  constructor(
    private readonly server: GameServer,
    /** The player id this client controls (used as the per-client snapshot key). */
    readonly localPlayerId: PlayerId,
  ) {
    server.connectClient(this);
  }

  /** Send the local player's input to the server. */
  sendInput(cmd: InputCommand): void {
    this.server.enqueueInput(this.localPlayerId, cmd);
  }

  /**
   * Inject input for any player id — loopback only, not on `Transport`.
   * Used to route the M1 bot's AI-computed inputs into the server until
   * the bot moves server-side in M2.7.
   */
  sendInputAs(playerId: PlayerId, cmd: InputCommand): void {
    this.server.enqueueInput(playerId, cmd);
  }

  setSnapshotHandler(cb: SnapshotHandler): void {
    this.snapshotHandler = cb;
  }

  /** Called by `GameServer.advance()` to deliver a snapshot synchronously. */
  deliverSnapshot(snap: Snapshot): void {
    this.snapshotHandler?.(snap);
  }

  start(): void {}

  dispose(): void {
    this.server.disconnectClient(this);
  }
}
