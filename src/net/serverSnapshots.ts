/**
 * Server-side delta channel — M2.13.
 *
 * Owns the per-client baseline bookkeeping that turns one authoritative world
 * into a delta-compressed binary frame for each client, using the acked-baseline
 * model described in `snapshotCodec.ts`:
 *
 *   - `record(quantized)` — once per broadcast, hand it the *quantized* shared
 *     snapshot (built once from the live world, not cloned per client). It's kept
 *     in a small ring so it can serve as a future baseline.
 *   - `encodeFor(clientId, quantized, ack…)` — pick that client's acked baseline
 *     from the ring and delta-encode against it; send a keyframe when there's no
 *     usable baseline (fresh join, ack not yet arrived, baseline aged out) or when
 *     the periodic keyframe interval elapses.
 *   - `onAck(clientId, tick)` — the client told us (piggybacked on its input
 *     stream) the newest snapshot tick it has decoded; future deltas ride on it.
 *
 * Because the content is identical across clients pre-AOI (M2.14), the ring is
 * shared: one quantize per broadcast replaces the old O(players × clients)
 * `structuredClone`. When AOI culling makes per-client content differ, this grows
 * a per-client ring — the encode/baseline machinery is unchanged.
 */

import type { PlayerId } from "../sim/types";
import type { Snapshot } from "./snapshot";
import { encodeSnapshot } from "./snapshotCodec";

/** Quantized snapshots retained as potential baselines. Must exceed
 *  `KEYFRAME_INTERVAL` plus a comfortable RTT of broadcasts so an acked tick is
 *  always still present. ~96 @ 33Hz ≈ 2.9s. */
const RING_SIZE = 96;

/** Force a keyframe at least this often (broadcasts) per client, even on a clean
 *  link. Bounds delta-chain length and gives a periodic recovery point for a
 *  lossy transport. ~60 @ 33Hz ≈ 1.8s. */
const KEYFRAME_INTERVAL = 60;

export class SnapshotChannel {
  /** Shared ring of quantized snapshots, ascending by tick. */
  private ring: Snapshot[] = [];
  /** Newest snapshot tick each client has confirmed decoding. */
  private acked = new Map<PlayerId, number>();
  /** Broadcasts since each client's last keyframe (drives the periodic keyframe). */
  private sinceKeyframe = new Map<PlayerId, number>();

  /** Retain this broadcast's quantized snapshot as a future baseline. Call once
   *  per broadcast, before `encodeFor`. */
  record(quantized: Snapshot): void {
    this.ring.push(quantized);
    if (this.ring.length > RING_SIZE) this.ring.shift();
  }

  /**
   * Encode the (already quantized) shared snapshot for one client: delta against
   * its acked baseline, or a keyframe when none is usable / the interval elapsed.
   * The per-client input ack fields are written in full (they're tiny and differ
   * per client, so they're not part of the delta).
   */
  encodeFor(
    clientId: PlayerId,
    quantized: Snapshot,
    lastProcessedInputSeq: number,
    inputBufferDepth: number,
  ): Uint8Array {
    const ackedTick = this.acked.get(clientId);
    let since = this.sinceKeyframe.get(clientId) ?? Number.MAX_SAFE_INTEGER;

    let baseline: Snapshot | null = null;
    if (ackedTick !== undefined && since < KEYFRAME_INTERVAL) {
      baseline = this.ring.find((s) => s.tick === ackedTick) ?? null;
    }
    // Keyframe whenever no baseline was found (new client, lost ack, aged-out, or
    // the periodic interval); otherwise it's a delta and the chain grows by one.
    this.sinceKeyframe.set(clientId, baseline === null ? 0 : since + 1);

    const perClient: Snapshot = { ...quantized, lastProcessedInputSeq, inputBufferDepth };
    return encodeSnapshot(perClient, baseline);
  }

  /** Record a client's snapshot ack (monotonic — a reordered older ack is
   *  ignored). The acked tick becomes the baseline for that client's next delta. */
  onAck(clientId: PlayerId, tick: number): void {
    const prev = this.acked.get(clientId) ?? -1;
    if (tick > prev) this.acked.set(clientId, tick);
  }

  /** Forget a disconnected client. */
  remove(clientId: PlayerId): void {
    this.acked.delete(clientId);
    this.sinceKeyframe.delete(clientId);
  }
}
