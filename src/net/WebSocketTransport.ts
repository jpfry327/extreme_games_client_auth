/**
 * Browser-side WebSocket transport — the real-network counterpart to
 * LoopbackTransport. Implements the same Transport interface so swapping back
 * to loopback in main.ts is a one-line change.
 *
 * Lifecycle:
 *   1. start() opens the socket.
 *   2. On open: sends `hello` with the player name.
 *   3. Server replies with `welcome` (assigns PlayerId); onConnected fires.
 *   4. Each sendInput() sends an `input` message.
 *   5. Incoming `snapshot` messages are forwarded to the registered handler.
 */

import type { PlayerId } from "../sim/types";
import type { Transport, SnapshotHandler } from "./transport";
import type { ClientMsg, SequencedInput, ServerMsg } from "./protocol";
import type { Snapshot } from "./snapshot";
import { decodeSnapshot, MissingBaselineError } from "./snapshotCodec";

/** Decoded snapshots retained so an incoming delta can be applied onto the
 *  baseline it references (by tick). Must comfortably exceed the server's
 *  keyframe interval; ~96 @ 33Hz ≈ 2.9s. */
const BASELINE_RING = 96;

export class WebSocketTransport implements Transport {
  private socket: WebSocket | null = null;
  private snapshotHandler: SnapshotHandler | null = null;

  /** M2.13: decoded snapshots by tick, for delta baseline lookup. Trimmed to the
   *  newest `BASELINE_RING` ticks. */
  private baselines = new Map<number, Snapshot>();
  /** The newest snapshot tick we've decoded — acked back to the server on each
   *  outgoing input so it knows which baseline to delta against. -1 = none yet. */
  private ackSnapshotTick = -1;

  /** Called once when the server sends `welcome`. After it fires, localPlayerId
   *  is valid and the game loop can begin. */
  onConnected: ((playerId: PlayerId) => void) | null = null;

  /** Called if the server refuses the join (e.g. arena full — M2.7). The socket
   *  is closed by the server right after; the client should surface `reason`. */
  onRejected: ((reason: string) => void) | null = null;

  /** Server-assigned identity for this client. Null until `welcome` arrives. */
  localPlayerId: PlayerId | null = null;

  constructor(
    private readonly url: string,
    private readonly playerName: string,
  ) {}

  start(): void {
    this.socket = new WebSocket(this.url);
    // Snapshots arrive as binary frames (M2.13); receive them as ArrayBuffers
    // rather than Blobs so they can be decoded synchronously.
    this.socket.binaryType = "arraybuffer";

    this.socket.addEventListener("open", () => {
      this.send({ type: "hello", name: this.playerName });
    });

    this.socket.addEventListener("message", (ev: MessageEvent) => {
      // Binary frame → a delta-compressed snapshot (M2.13); text frame → a JSON
      // control message (welcome / reject). Inputs go the other direction.
      if (ev.data instanceof ArrayBuffer) {
        this.onSnapshotBytes(new Uint8Array(ev.data));
        return;
      }
      const msg = JSON.parse(ev.data as string) as ServerMsg;
      if (msg.type === "welcome") {
        this.localPlayerId = msg.playerId;
        this.onConnected?.(msg.playerId);
      } else if (msg.type === "reject") {
        this.onRejected?.(msg.reason);
      }
      // A "snapshot" type never arrives as JSON over the socket (it's binary);
      // the SnapshotMsg shape is retained only for the in-process loopback.
    });

    this.socket.addEventListener("close", () => {
      console.info("[transport] disconnected from server");
    });

    this.socket.addEventListener("error", () => {
      console.error("[transport] WebSocket error");
    });
  }

  sendInput(input: SequencedInput): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    // Piggyback the snapshot ack (M2.13): tell the server the newest tick we've
    // decoded so it deltas the next snapshot against that baseline. Omit until the
    // first snapshot arrives, so the server keyframes the opening frames.
    const msg: ClientMsg =
      this.ackSnapshotTick >= 0
        ? { type: "input", input, ackSnapshotTick: this.ackSnapshotTick }
        : { type: "input", input };
    this.send(msg);
  }

  /** Decode an incoming binary snapshot frame against our retained baselines,
   *  store it as a future baseline, and forward it to the handler (M2.13). A
   *  frame whose baseline we no longer hold is dropped — the server sends a
   *  keyframe on its periodic interval, which decodes standalone and recovers. */
  private onSnapshotBytes(bytes: Uint8Array): void {
    let snap: Snapshot;
    try {
      snap = decodeSnapshot(bytes, (tick) => this.baselines.get(tick));
    } catch (err) {
      if (err instanceof MissingBaselineError) return; // wait for the next keyframe
      throw err;
    }
    this.baselines.set(snap.tick, snap);
    // Trim oldest baselines once the ring is full (decode order == wire order over
    // TCP, so the smallest tick is the oldest).
    if (this.baselines.size > BASELINE_RING) {
      let oldest = Infinity;
      for (const t of this.baselines.keys()) if (t < oldest) oldest = t;
      this.baselines.delete(oldest);
    }
    if (snap.tick > this.ackSnapshotTick) this.ackSnapshotTick = snap.tick;
    this.snapshotHandler?.(snap);
  }

  setSnapshotHandler(cb: SnapshotHandler): void {
    this.snapshotHandler = cb;
  }

  dispose(): void {
    this.socket?.close();
    this.socket = null;
  }

  private send(msg: ClientMsg): void {
    this.socket?.send(JSON.stringify(msg));
  }
}
