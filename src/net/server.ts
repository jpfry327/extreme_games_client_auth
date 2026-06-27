/**
 * In-process relay server — the loopback counterpart of the headless
 * `server/index.ts`, for running with no socket (the commented loopback block in
 * main.ts).
 *
 * **Client-authoritative relay model:** `GameServer` is a thin wrapper over
 * `RelayHost` (the shared mirror + bot-defender + scoreboard). It does not
 * simulate the human — it ingests the client's `StateReportMsg` / `DeathReportMsg`,
 * advances only its bot's self-sim, and delivers a per-client AOI-culled snapshot
 * assembled from the mirror world.
 *
 * The server imports only `sim/` + `net/` + `config`, never rendering — proving
 * `sim/` stays pure (architecture §1).
 */

import { WARBIRD } from "../config";
import { RelayHost } from "./relayHost";
import type { PlayerId } from "../sim/types";
import { LOCAL_PLAYER_ID } from "../sim/world";
import type { GameMap } from "../sim/gamemap";
import type { DeathReportMsg, StateReportMsg } from "./protocol";
import { cullAndCloneFor, type Snapshot } from "./snapshot";

/**
 * The interface the server uses to deliver snapshots to clients.
 * `LoopbackTransport` implements this. Kept here to avoid a circular import:
 * server.ts → snapshot.ts; transport.ts → server.ts (one-way).
 */
export interface ClientConnection {
  /** The player id this client is controlling. */
  readonly localPlayerId: PlayerId;
  /** Called synchronously (loopback) after each advance to deliver the latest
   *  per-client AOI-culled snapshot. */
  deliverSnapshot(snap: Snapshot): void;
}

export class GameServer {
  private readonly relay: RelayHost;
  private clients: ClientConnection[] = [];

  /** The spawn the server assigned the loopback human — main.ts seeds its
   *  `LocalSim` local player here so client and server agree on the start pose. */
  readonly localSpawn: { x: number; y: number };

  /** Seed for the loopback client's `LocalSim` RNG (mirrors the welcome `seed`). */
  readonly seed = 1;

  constructor(map: GameMap) {
    this.relay = new RelayHost(map, this.seed);
    this.localSpawn = this.relay.pickSpawn();
    this.relay.addHuman(LOCAL_PLAYER_ID, "Player", 0, WARBIRD, this.localSpawn.x, this.localSpawn.y);
  }

  /** Register a client to receive snapshots. Called by the transport on connect. */
  connectClient(client: ClientConnection): void {
    this.clients.push(client);
  }

  /** Remove a client on disconnect. */
  disconnectClient(client: ClientConnection): void {
    this.clients = this.clients.filter((c) => c !== client);
  }

  /** Ingest a client's authoritative state report (mirror it). */
  ingestState(id: PlayerId, report: StateReportMsg): void {
    this.relay.ingestState(id, report);
  }

  /** Ingest a client's self-reported death (score it + relay). */
  ingestDeath(report: DeathReportMsg): void {
    this.relay.ingestDeath(report);
  }

  /**
   * Advance the bot's self-sim by `dtSeconds` and deliver a per-client snapshot.
   * The loopback transport delivers synchronously inside this call. There is no
   * interpolation alpha to return any more — the client free-runs its own
   * `LocalSim` for the local ship — so this returns nothing.
   */
  advance(dtSeconds: number): void {
    this.relay.advance(dtSeconds);

    const shared = this.relay.assembleSnapshot();
    for (const client of this.clients) {
      const snap = cullAndCloneFor(shared, client.localPlayerId, this.relay.ack(client.localPlayerId));
      client.deliverSnapshot(snap);
    }
    this.relay.clearEvents();
  }

  /** The local player id the loopback human controls. */
  get localPlayerId(): PlayerId {
    return LOCAL_PLAYER_ID;
  }
}
