/**
 * Client-side network-health telemetry — M2.11.
 *
 * The full netcode model (M2.0–M2.10) is correct but, over the real internet, can
 * *feel* wrong in ways that are invisible without instrumentation: a jittery link
 * starves the interpolation buffer (remote ships jump), lost snapshots stall the
 * stream, and shots get under-compensated when the lag-comp rewind clamps. This
 * class turns all of that into numbers for the debug overlay, and feeds the two it
 * needs downstream — `meanIntervalMs` and `jitterMs` — into the forward-lead
 * estimate (`computeLeadMs` in main.ts).
 *
 * It is **pure measurement**: no sim state, no mutation of anything else. Two
 * inputs drive it — `onSnapshot`/`onStaleSnapshot` from the snapshot handler, and
 * `onFrame` from the render loop — and everything is read back through getters.
 *
 * Two clocks, deliberately: **snapshot timing** (jitter, loss) is measured from
 * wall-clock arrival + the snapshot's server tick; **per-frame events**
 * (extrapolation, freeze, comp-clamp) are counted in the render loop and rolled up
 * into per-second rates over a 1s window. Loss is derived from server-**tick gaps**
 * (a fixed broadcast step, so a gap that's a multiple of it = that many missed)
 * rather than from time, which is far more robust to jitter.
 */

/** Per-second event tallies, reset each rollup window. */
interface Counters {
  /** Snapshots accepted (in-order, applied). */
  received: number;
  /** Snapshots inferred missing from a server-tick gap (loss). */
  missed: number;
  /** Snapshots dropped as out-of-order / stale (arrived after a newer one). */
  stale: number;
  /** Render frames that had to extrapolate (buffer had no newer sample). */
  extrapFrames: number;
  /** Render frames frozen at the extrapolation cap (buffer fully starved). */
  freezeFrames: number;
  /** Render frames where the shot's lag-comp rewind hit its cap (under-comp). */
  clampFrames: number;
}

const freshCounters = (): Counters => ({
  received: 0,
  missed: 0,
  stale: 0,
  extrapFrames: 0,
  freezeFrames: 0,
  clampFrames: 0,
});

/** What the render loop reports each frame so health can tally rates + hold the
 *  latest gauge values for the overlay. */
export interface FrameGauges {
  /** Snapshots currently buffered in the interpolator. */
  bufferDepth: number;
  /** Extrapolation window in use this frame (0 = a real straddling pair exists). */
  extrapMs: number;
  /** True when extrapolation is clamped at its max (remote entities frozen). */
  frozen: boolean;
  /** The *un-clamped* rewind (ticks) our shots would want this frame. */
  rawCompTicks: number;
  /** True when `rawCompTicks` exceeds the lag-comp cap (shots under-compensated). */
  compClamped: boolean;
}

export class NetHealth {
  // --- snapshot arrival timing (for jitter + the adaptive delay) ---
  private lastSnapMs = -1;
  private meanInterval = 0; // EWMA of inter-arrival ms
  private jitter = 0; // EWMA of |interval − meanInterval|
  /** EWMA smoothing factor for the interval/jitter estimates. */
  private static readonly ALPHA = 0.1;

  // --- snapshot tick tracking (for loss) ---
  private lastSnapTick = -1;
  /** The broadcast step = the **most common** positive server-tick gap (the mode),
   *  discovered from the stream so the client needn't know the server's
   *  `BROADCAST_EVERY`. Loss is then any gap that's a larger multiple of it.
   *  (A plain *minimum* would lock onto a single early small gap — e.g. a hiccup on
   *  connect — and then count every normal gap as loss, the M2.11 "loss 33/s while
   *  jitter ±1ms" artifact.) */
  private tickStep = 0;
  private tickStepCount = 0;
  private readonly gapCounts = new Map<number, number>();

  // --- per-second rollup ---
  private windowMs = 0;
  private accruing = freshCounters();
  /** The last completed 1s window — what the overlay reads as "per second". */
  private rate = freshCounters();

  // --- latest gauges (overlay reads these directly) ---
  private gauges: FrameGauges = {
    bufferDepth: 0,
    extrapMs: 0,
    frozen: false,
    rawCompTicks: 0,
    compClamped: false,
  };

  /** Record an accepted (in-order) snapshot. `tick` is its server tick, `nowMs` the
   *  `performance.now()` at receipt. */
  onSnapshot(tick: number, nowMs: number): void {
    this.accruing.received++;

    if (this.lastSnapMs >= 0) {
      const interval = nowMs - this.lastSnapMs;
      if (this.meanInterval === 0) {
        this.meanInterval = interval;
      } else {
        this.meanInterval += NetHealth.ALPHA * (interval - this.meanInterval);
        this.jitter += NetHealth.ALPHA * (Math.abs(interval - this.meanInterval) - this.jitter);
      }
    }
    this.lastSnapMs = nowMs;

    if (this.lastSnapTick >= 0) {
      const gap = tick - this.lastSnapTick;
      if (gap > 0) {
        // Track the mode of gaps as the broadcast step (robust to an early outlier).
        const c = (this.gapCounts.get(gap) ?? 0) + 1;
        this.gapCounts.set(gap, c);
        if (c > this.tickStepCount) {
          this.tickStep = gap;
          this.tickStepCount = c;
        }
        if (this.tickStep > 0) {
          // A gap of k× the broadcast step means (k−1) snapshots never arrived.
          this.accruing.missed += Math.max(0, Math.round(gap / this.tickStep) - 1);
        }
      }
    }
    this.lastSnapTick = tick;
  }

  /** Record a snapshot dropped as out-of-order (an older tick after a newer one). */
  onStaleSnapshot(): void {
    this.accruing.stale++;
  }

  /** Record one render frame's gauges and advance the 1s rollup. */
  onFrame(dtSeconds: number, gauges: FrameGauges): void {
    this.gauges = gauges;
    if (gauges.extrapMs > 0) this.accruing.extrapFrames++;
    if (gauges.frozen) this.accruing.freezeFrames++;
    if (gauges.compClamped) this.accruing.clampFrames++;

    this.windowMs += dtSeconds * 1000;
    if (this.windowMs >= 1000) {
      this.rate = this.accruing;
      this.accruing = freshCounters();
      this.windowMs = 0;
    }
  }

  /** EWMA of the snapshot inter-arrival interval (ms). 0 before two snapshots. */
  get meanIntervalMs(): number {
    return this.meanInterval;
  }
  /** EWMA of inter-arrival jitter (ms) — mean absolute deviation of the interval. */
  get jitterMs(): number {
    return this.jitter;
  }

  /** Latest per-frame gauges. */
  get latest(): Readonly<FrameGauges> {
    return this.gauges;
  }
  /** The last completed 1-second window's event counts. */
  get perSecond(): Readonly<Counters> {
    return this.rate;
  }
}
