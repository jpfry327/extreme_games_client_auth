/**
 * Adaptive interpolation delay — M2.11.
 *
 * M2.2 rendered remote entities a *fixed* `interpDelayMs` (75ms) in the past. That
 * was tuned against the zero-latency loopback / network simulator; on a real link
 * with real jitter it is simultaneously too small (a late snapshot starves the
 * buffer → remote ships jump/freeze) and, when the link is clean, larger than it
 * needs to be (needless lag on other ships). This drives the delay from the live
 * snapshot stream instead.
 *
 * Target: enough buffer to always hold a snapshot pair straddling render time
 * (≈ a multiple of the mean inter-arrival spacing) plus a cushion proportional to
 * measured jitter:
 *
 *   target = clamp(meanIntervalMs * spacingFactor + jitterMs * jitterFactor,
 *                  minMs, maxMs)
 *
 * The live value eases toward `target` with an **asymmetric** half-life — raise
 * fast (outrun a starving buffer *now*), lower slowly (so transient jitter doesn't
 * make the delay itself jitter, which would visibly time-warp remote ships). When
 * disabled, or before any snapshot timing exists, it simply holds its initial
 * value, so the rest of the client is unchanged.
 *
 * Pure and deterministic given its inputs (no clock reads) — `update` takes the
 * elapsed `dtSeconds` explicitly, so it's unit-testable like the sim systems.
 */

export interface AdaptiveInterpConfig {
  enabled: boolean;
  minMs: number;
  maxMs: number;
  spacingFactor: number;
  jitterFactor: number;
  raiseHalfLifeMs: number;
  lowerHalfLifeMs: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export class AdaptiveInterpDelay {
  private current: number;
  private target: number;

  constructor(
    private readonly cfg: AdaptiveInterpConfig,
    initialMs: number,
  ) {
    this.current = initialMs;
    this.target = initialMs;
  }

  /**
   * Re-aim and ease the delay toward the link's needs. `meanIntervalMs` /
   * `jitterMs` come from `NetHealth`; `dtSeconds` is the render frame's elapsed
   * time. No-op (holds the initial value) while disabled or before timing exists.
   */
  update(meanIntervalMs: number, jitterMs: number, dtSeconds: number): void {
    if (!this.cfg.enabled || meanIntervalMs <= 0) return;

    this.target = clamp(
      meanIntervalMs * this.cfg.spacingFactor + jitterMs * this.cfg.jitterFactor,
      this.cfg.minMs,
      this.cfg.maxMs,
    );

    // Asymmetric exponential ease: fast up, slow down.
    const halfLife =
      this.target > this.current ? this.cfg.raiseHalfLifeMs : this.cfg.lowerHalfLifeMs;
    const k = 1 - Math.pow(0.5, (dtSeconds * 1000) / halfLife);
    this.current += (this.target - this.current) * k;
  }

  /** The live interpolation delay (ms) to render remote entities at. */
  get ms(): number {
    return this.current;
  }
  /** The current steady-state target (ms) — for the debug overlay. */
  get targetMs(): number {
    return this.target;
  }
}
