/**
 * Client-side transport abstraction — the boundary between the client and the
 * relay server (architecture §5).
 *
 * **Client-authoritative relay model:** the client owns its ship and sends its
 * authoritative *state* (`StateReportMsg`) and a *death report* when it dies, not
 * intent. `Transport` is the interface every client uses; `LoopbackTransport`
 * (in-process, zero latency) and `WebSocketTransport` are interchangeable.
 *
 * `LoopbackTransport` also implements `ClientConnection` (server.ts) so the relay
 * server can call `deliverSnapshot` on it directly.
 */

import type { PlayerId } from "../sim/types";
import type { DeathReportMsg, StateReportMsg } from "./protocol";
import { type ClientConnection, type GameServer } from "./server";
import type { Snapshot } from "./snapshot";

export type SnapshotHandler = (snap: Snapshot) => void;

/** The client-side view of the transport. One instance per client session. */
export interface Transport {
  /** Report the client's own authoritative state (pose/energy/status + own live
   *  shots). State is last-wins, so a dropped datagram is simply superseded. */
  sendState(report: StateReportMsg): void;
  /** Report the client's own death (defender names the killer) for the server to
   *  score and relay. */
  sendDeath(report: DeathReportMsg): void;
  /** Register the callback that receives each incoming snapshot. */
  setSnapshotHandler(cb: SnapshotHandler): void;
  start(): void;
  dispose(): void;
}

/**
 * In-process transport with zero latency. The `GameServer.advance()` call delivers
 * the snapshot synchronously by calling `deliverSnapshot` on this object.
 *
 * Reports are `structuredClone`d on the way in to simulate the serialize→
 * deserialize a real wire does, so the in-process server never aliases the
 * client's live `LocalSim` objects (the server mutates the mirror's kills/score).
 */
export class LoopbackTransport implements Transport, ClientConnection {
  private snapshotHandler: SnapshotHandler | null = null;

  /** Fired from `start()` with the server-assigned id, spawn, and seed — the
   *  in-process equivalent of the WebSocket `welcome`, so main.ts can seed its
   *  `LocalSim` identically on either transport. */
  onConnected: ((playerId: PlayerId, spawn: { x: number; y: number }, seed: number) => void) | null =
    null;
  /** Never fired (the loopback never refuses a join); present for interface parity
   *  with `WebSocketTransport` so main.ts can swap transports unchanged. */
  onRejected: ((reason: string) => void) | null = null;

  constructor(
    private readonly server: GameServer,
    /** The player id this client controls (used as the per-client snapshot key). */
    readonly localPlayerId: PlayerId,
  ) {
    server.connectClient(this);
  }

  sendState(report: StateReportMsg): void {
    this.server.ingestState(this.localPlayerId, structuredClone(report));
  }

  sendDeath(report: DeathReportMsg): void {
    this.server.ingestDeath(structuredClone(report));
  }

  setSnapshotHandler(cb: SnapshotHandler): void {
    this.snapshotHandler = cb;
  }

  /** Called by `GameServer.advance()` to deliver a snapshot synchronously. */
  deliverSnapshot(snap: Snapshot): void {
    this.snapshotHandler?.(snap);
  }

  start(): void {
    // Synchronously "welcome" the client (zero latency), the loopback equivalent
    // of the WebSocket handshake.
    this.onConnected?.(this.localPlayerId, this.server.localSpawn, this.server.seed);
  }

  dispose(): void {
    this.server.disconnectClient(this);
  }
}
