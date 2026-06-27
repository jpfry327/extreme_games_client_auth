/**
 * ReportSender — paces the client's authoritative state uplink in the
 * client-authoritative relay model (the counterpart to the old `InputSender`).
 *
 * In the relay model the client owns its ship and reports its *state*, not its
 * intent. State is last-wins, so it is inherently loss-tolerant — a dropped
 * datagram is simply superseded by the next, with no retransmit or server-side
 * gap to fill (unlike the input stream, which needed in-datagram redundancy). So
 * this only paces the send to ~`sendIntervalMs` (≈ one datagram per render frame
 * at the default ~16ms ≈ 60Hz); the caller assembles the `StateReportMsg`.
 *
 * Kept out of the transport so the loopback stays immediate and the pacing policy
 * is unit-testable in isolation.
 */

import { INPUT } from "../config";

/** EMA weight for the send-rate readout — smooth enough to read on the overlay. */
const RATE_SMOOTH = 0.1;

export class ReportSender {
  private accumulator = 0;
  private lastSentAtMs = -1;

  /** Smoothed datagrams-per-second, for the overlay. */
  sendRateHz = 0;

  constructor(private readonly sendIntervalMs = INPUT.sendIntervalMs) {}

  /**
   * Advance the send clock by real `dtSeconds`. Once at least `sendIntervalMs` has
   * elapsed, invoke `send` (which assembles + dispatches the current state report).
   */
  update(dtSeconds: number, nowMs: number, send: () => void): void {
    this.accumulator += dtSeconds * 1000;
    if (this.accumulator < this.sendIntervalMs) return;

    // Subtract whole intervals so a long frame doesn't burst multiple sends, but
    // the cadence stays anchored to real time.
    this.accumulator -= this.sendIntervalMs;
    if (this.accumulator >= this.sendIntervalMs) this.accumulator = this.sendIntervalMs;

    if (this.lastSentAtMs >= 0) {
      const gapMs = nowMs - this.lastSentAtMs;
      if (gapMs > 0) {
        const instHz = 1000 / gapMs;
        this.sendRateHz =
          this.sendRateHz === 0 ? instHz : this.sendRateHz + (instHz - this.sendRateHz) * RATE_SMOOTH;
      }
    }
    this.lastSentAtMs = nowMs;

    send();
  }
}
