import { describe, it, expect } from "vitest";
import { NetHealth, type FrameGauges } from "./netHealth";

const gauges = (over: Partial<FrameGauges> = {}): FrameGauges => ({
  bufferDepth: 2,
  extrapMs: 0,
  frozen: false,
  rawCompTicks: 0,
  compClamped: false,
  ...over,
});

/** Drive ~`seconds` of render frames at 60fps so the 1s rollup completes. */
function runFrames(h: NetHealth, seconds: number, g: FrameGauges): void {
  const frames = Math.ceil((seconds * 1000) / (1000 / 60));
  for (let i = 0; i < frames; i++) h.onFrame(1 / 60, g);
}

describe("NetHealth — snapshot timing", () => {
  it("tracks the mean inter-arrival interval", () => {
    const h = new NetHealth();
    let t = 1000;
    for (let i = 0; i < 50; i++) {
      h.onSnapshot(i * 3, t); // server tick steps by 3 (33Hz), 30ms apart
      t += 30;
    }
    expect(h.meanIntervalMs).toBeCloseTo(30, 0);
    expect(h.jitterMs).toBeCloseTo(0, 0);
  });

  it("reports non-zero jitter on irregular arrivals", () => {
    const h = new NetHealth();
    let t = 1000;
    const intervals = [30, 60, 20, 50, 25, 70, 30, 40];
    for (let i = 0; i < intervals.length; i++) {
      h.onSnapshot(i * 3, t);
      t += intervals[i];
    }
    expect(h.jitterMs).toBeGreaterThan(0);
  });
});

describe("NetHealth — loss & stale", () => {
  it("infers missed snapshots from a server-tick gap", () => {
    const h = new NetHealth();
    h.onSnapshot(0, 1000); // establishes the stream
    h.onSnapshot(3, 1030); // step = 3 (no loss)
    h.onSnapshot(9, 1090); // gap of 6 = one missed snapshot
    runFrames(h, 1.1, gauges());
    expect(h.perSecond.received).toBe(3);
    expect(h.perSecond.missed).toBe(1);
  });

  it("counts out-of-order snapshots as stale", () => {
    const h = new NetHealth();
    h.onStaleSnapshot();
    h.onStaleSnapshot();
    runFrames(h, 1.1, gauges());
    expect(h.perSecond.stale).toBe(2);
  });
});

describe("NetHealth — per-frame rollup", () => {
  it("counts extrapolation, freeze and clamp frames per second, then resets", () => {
    const h = new NetHealth();
    // One full second of frames that are extrapolating, frozen and clamped.
    runFrames(h, 1.1, gauges({ extrapMs: 50, frozen: true, compClamped: true }));
    expect(h.perSecond.extrapFrames).toBeGreaterThan(0);
    expect(h.perSecond.freezeFrames).toBeGreaterThan(0);
    expect(h.perSecond.clampFrames).toBeGreaterThan(0);

    // Two clean windows flush the rates (the first clean window still carries the
    // partial in-progress window left over from the dirty run).
    runFrames(h, 2.2, gauges());
    expect(h.perSecond.extrapFrames).toBe(0);
    expect(h.perSecond.freezeFrames).toBe(0);
    expect(h.perSecond.clampFrames).toBe(0);
  });

  it("exposes the latest frame gauges", () => {
    const h = new NetHealth();
    h.onFrame(1 / 60, gauges({ bufferDepth: 5, extrapMs: 12, rawCompTicks: 18 }));
    expect(h.latest.bufferDepth).toBe(5);
    expect(h.latest.extrapMs).toBe(12);
    expect(h.latest.rawCompTicks).toBe(18);
  });
});
