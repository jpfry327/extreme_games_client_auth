import { TICK_DT } from "../config";
import type { StepContext } from "./types";
import type { World } from "./world";

/**
 * Fixed-timestep driver. The renderer can run at any frame rate (60, 120, 144Hz),
 * but the simulation always advances in fixed 10ms (100Hz) steps. This keeps the
 * physics deterministic and frame-rate independent — essential for a game whose
 * sim will later run authoritatively on a server.
 *
 * `advance()` returns an interpolation alpha in [0,1): how far we are between the
 * last completed tick and the next one, so the renderer can smoothly blend poses.
 *
 * The same `StepContext` is applied to every tick we run this frame — the client
 * sampled input once for the frame, and all the catch-up ticks share that intent.
 *
 * `onTick` runs once per fixed tick, right after `world.step()`. Networked mode
 * uses it to advance remote-player smoothing in lockstep with the sim so the
 * renderer's tick interpolation stays aligned (netcode §4 step 6); it stays out
 * of the pure `step()` because it's net-layer playback, not simulation.
 */
export class FixedLoop {
  private accumulator = 0;
  private static readonly MAX_FRAME = 0.25; // clamp to avoid spiral-of-death

  constructor(private readonly world: World) {}

  advance(dtSeconds: number, ctx: StepContext, onTick?: () => void): number {
    this.accumulator += Math.min(dtSeconds, FixedLoop.MAX_FRAME);

    while (this.accumulator >= TICK_DT) {
      this.world.step(ctx);
      onTick?.();
      this.accumulator -= TICK_DT;
    }

    return this.accumulator / TICK_DT;
  }
}
