/**
 * Wire protocol v0 — M2.1 / M2.3 message shapes for client↔server communication.
 *
 * JSON framing for now; binary is a later optimization. Three message types
 * cover the lifecycle: handshake (hello/welcome), input streaming, and state
 * delivery (snapshot). Chat, items, and ship-change will extend ClientMsg in
 * later milestones.
 *
 * M2.3 introduces the **fixed-tick input model**: the client produces exactly
 * one command per 10ms sim tick (not one per render frame), stamps each with a
 * monotonic `seq`, and sends every one. The server consumes them in order, one
 * per tick, and acks the highest `seq` it has processed in each snapshot. This
 * is the data plane client prediction & reconciliation (M2.4) will ride on.
 */

import type { InputCommand, PlayerId } from "../sim/types";
import type { Snapshot } from "./snapshot";

// --- Client → Server ---

/** First message from a new connection. Server responds with `welcome`. */
export interface HelloMsg {
  type: "hello";
  name: string;
}

/**
 * One player command, stamped for sequencing (M2.3). The client produces one
 * per sim tick and never drops them, so the server sees a continuous, ordered
 * command stream.
 *
 * - `seq`        — monotonic per client, starting at 1. The unit the server
 *                  acks and the client keys its un-acked ring buffer by.
 * - `clientTick` — the client sim tick this command was sampled for. Carried
 *                  for M2.4 (mapping replayed inputs back to ticks) and the
 *                  debug overlay's client-tick vs server-tick readout. In M2.3
 *                  it equals `seq` (one command per tick), but they are kept
 *                  distinct because the two counters diverge once prediction
 *                  resends / reorders inputs.
 */
export interface SequencedInput {
  seq: number;
  clientTick: number;
  cmd: InputCommand;
}

/** A single sequenced command. Sent once per sim tick, immediately — coalesced
 *  render frames still emit every tick's command so the stream has no gaps. */
export interface InputMsg {
  type: "input";
  input: SequencedInput;
  /** M2.13 — the newest snapshot tick the client has decoded, piggybacked on the
   *  input stream (client → server). The server delta-encodes the next snapshot
   *  against this acked baseline. Cumulative/monotonic: a lost input just delays
   *  the ack by one, the server keeps using the last tick it heard. Absent until
   *  the first snapshot is decoded. */
  ackSnapshotTick?: number;
}

export type ClientMsg = HelloMsg | InputMsg;

// --- Server → Client ---

/** Server's reply to `hello` — assigns the player's canonical id for this
 *  session. The client must wait for this before starting the game loop. */
export interface WelcomeMsg {
  type: "welcome";
  playerId: PlayerId;
}

/** Snapshot pushed at ~33Hz. **M2.13: the wire form is now a binary frame**, not
 *  this JSON envelope — snapshots are sent as WebSocket *binary* messages encoded
 *  by `snapshotCodec.ts` (delta-compressed against the client's acked baseline),
 *  while the control messages here stay JSON *text* frames. The transport tells
 *  them apart by frame type (string vs ArrayBuffer). This interface is retained
 *  for the in-process loopback path, which still passes a plain `Snapshot`. */
export interface SnapshotMsg {
  type: "snapshot";
  snap: Snapshot;
}

/** Server's refusal of a `hello` — e.g. the arena is at its player cap (M2.7).
 *  Sent in place of `welcome`; the server then closes the socket. The client
 *  shows `reason` and stops, rather than hanging forever in "connecting…". */
export interface RejectMsg {
  type: "reject";
  reason: string;
}

export type ServerMsg = WelcomeMsg | SnapshotMsg | RejectMsg;
