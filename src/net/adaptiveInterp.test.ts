import { describe, it, expect } from "vitest";
import { AdaptiveInterpDelay, type AdaptiveInterpConfig } from "./adaptiveInterp";

const cfg: AdaptiveInterpConfig = {
  enabled: true,
  minMs: 50,
  maxMs: 200,
  spacingFactor: 1.5,
  jitterFactor: 2,
  raiseHalfLifeMs: 150,
  lowerHalfLifeMs: 3000,
};

describe("AdaptiveInterpDelay", () => {
  it("holds the initial value while disabled", () => {
    const a = new AdaptiveInterpDelay({ ...cfg, enabled: false }, 75);
    a.update(30, 50, 1); // would otherwise push toward a large target
    expect(a.ms).toBe(75);
  });

  it("holds the initial value before any snapshot timing exists", () => {
    const a = new AdaptiveInterpDelay(cfg, 75);
    a.update(0, 0, 1); // meanIntervalMs 0 = no measurements yet
    expect(a.ms).toBe(75);
  });

  it("targets spacing + jitter, clamped to [minMs, maxMs]", () => {
    const a = new AdaptiveInterpDelay(cfg, 75);
    a.update(30, 10, 0.001); // tiny dt → target set, current barely moves
    expect(a.targetMs).toBeCloseTo(30 * 1.5 + 10 * 2, 5); // 65

    a.update(30, 0, 0.001);
    expect(a.targetMs).toBe(50); // 45 → clamped up to min

    a.update(200, 100, 0.001);
    expect(a.targetMs).toBe(200); // 500 → clamped down to max
  });

  it("raises fast: one raise half-life closes half the gap", () => {
    const a = new AdaptiveInterpDelay(cfg, 50);
    // target = clamp(200*1.5 + 100*2) = 200; dt = raiseHalfLifeMs
    a.update(200, 100, cfg.raiseHalfLifeMs / 1000);
    expect(a.ms).toBeCloseTo(125, 1); // 50 + (200-50)*0.5
  });

  it("lowers slowly: a raise half-life barely moves it down", () => {
    const a = new AdaptiveInterpDelay(cfg, 200);
    // target = clamp(30*1.5 + 0) = 50 (a big drop); dt = raise half-life (small vs lower)
    a.update(30, 0, cfg.raiseHalfLifeMs / 1000);
    // k = 1 - 0.5^(150/3000) ≈ 0.034 → tiny step down from 200
    expect(a.ms).toBeGreaterThan(190);
    expect(a.ms).toBeLessThan(200);
  });

  it("converges toward the target over repeated updates", () => {
    const a = new AdaptiveInterpDelay(cfg, 50);
    for (let i = 0; i < 200; i++) a.update(60, 20, 1 / 60); // target = 90+40=130
    expect(a.ms).toBeCloseTo(130, 0);
  });
});
