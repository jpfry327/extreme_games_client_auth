/**
 * Deterministic client-side simulation of remote projectiles — M2.8.
 *
 * Through M2.6 *every other* player's bullets were drawn by lerping their
 * streamed snapshot positions (`interpolation.ts`, now removed). That produced
 * two artifacts unique to enemy fire: a bullet that bounced off a wall *between*
 * two snapshots was drawn as a straight line through the corner until the
 * post-bounce snapshot arrived (the "teleport"), and all enemy fire trailed by
 * the interpolation delay in a way that read as inferred rather than physical.
 *
 * The fix is the same determinism the local player (M2.4) and its own shots
 * (M2.6) already exploit, turned outward: a projectile's entire future is fixed
 * at spawn. `stepProjectile` (`sim/systems/projectiles.ts`) advances it from
 * *only* position, velocity, bounce count, and the map — **no player input drives
 * it** — so any client holding the spawn state can reproduce its path bit-for-bit,
 * bounces included. So instead of lerping streamed positions we take the latest
 * authoritative remote projectiles and **simulate them forward** to render time.
 *
 * Render time (the crux — roadmap M2.8): remote bullets are simulated to the
 * **same** render time as remote ships, `now − interpDelayMs`, *not* the true
 * present. Drawing them at present would require also extrapolating the remote
 * *ships* to present, which reintroduces the turn→overshoot→snap the roadmap
 * rejected in M2.2. Keeping bullets on the ships' timeline fixes the bounce-jump
 * without detaching a shot from the ship that fired it.
 *
 * This is **not** server-side lag compensation / hit rewind (a separate Phase-2
 * feature for hit *fairness*). Hits and damage stay 100% server-authoritative;
 * this simulation is cosmetic-until-confirmed, exactly like predicted own-shots.
 */

import { TICK_DT } from "../config";
import type { GameMap } from "../sim/gamemap";
import type { PlayerId, Projectile } from "../sim/types";
import { projectileSystem } from "../sim/systems/projectiles";
import { World } from "../sim/world";
import { type BufferedSnapshot, pickStraddlingPair } from "./interpolation";

export class RemoteProjectileSimulator {
  /** A tiny, never-networked world holding *only* a map. Each `simulate` call
   *  reloads it with the base snapshot's remote projectiles and steps them
   *  forward. It has no players, so its collision/damage systems never fire —
   *  but we only run `projectileSystem` on it anyway (flight + wall bounce). */
  private readonly world: World;

  constructor(map: GameMap) {
    this.world = new World(map, 1, false);
  }

  /**
   * Compute the render poses of all **remote** projectiles (owner ≠ the local
   * player) at render time `nowMs − interpDelayMs`, by simulating the latest
   * authoritative snapshot forward instead of lerping it.
   *
   * `snapshots` is the interpolator's own buffer (shared by reference) so this
   * resolves against the exact same render window the remote ships use.
   *
   * Returns fresh `Projectile` objects with `prev* === current`, so the renderer
   * (which lerps `prev→current` by `alpha`) draws exactly the simulated pose —
   * same baking convention the interpolator uses for ships.
   */
  simulate(
    snapshots: readonly BufferedSnapshot[],
    nowMs: number,
    interpDelayMs: number,
    localPlayerId: PlayerId,
    extrapolateMaxMs = 0,
  ): Projectile[] {
    const renderTime = nowMs - interpDelayMs;
    const pair = pickStraddlingPair(snapshots, renderTime, extrapolateMaxMs);
    if (!pair) return [];
    const { a, b, extrapMs } = pair;

    // Base = the newest snapshot at-or-before render time. Take its live remote
    // projectiles (the local player's own shots come from its LocalSim).
    const base = a.snap.projectiles.filter((p) => p.alive && p.owner !== localPlayerId);
    if (base.length === 0) return [];

    // How far forward to step. Normally render time sits inside the straddling
    // pair, so we advance from `a` to render time. When the buffer has starved
    // (`extrapMs > 0`, render time past the newest sample) we dead-reckon by the
    // clamped extrapolation window instead — the same bound the ships use.
    const stepMs = extrapMs > 0 ? extrapMs : Math.max(0, renderTime - a.receivedAt);
    const stepTicks = stepMs / (1000 * TICK_DT);
    const wholeTicks = Math.floor(stepTicks);
    const frac = stepTicks - wholeTicks; // sub-tick remainder for smooth motion

    // Clone into the tiny world (structuredClone so stepping never mutates the
    // buffered snapshot, which the next frame still interpolates from) and run
    // the deterministic projectile step `wholeTicks` times.
    this.world.projectiles = structuredClone(base);
    for (let i = 0; i < wholeTicks; i++) projectileSystem(this.world);

    let survivors = this.world.projectiles.filter((p) => p.alive);

    // --- death-during-window reconciliation (M2.8) ---------------------------
    // Our map-only world catches a bullet that died on a *wall* or aged out, but
    // not one the server removed via a *ship hit* (we have no ships). So when a
    // straddling newer snapshot `b` exists, drop any simulated id that is gone
    // from it: the server killed it within the window, so it must retract rather
    // than keep flying. (No `b` during extrapolation — nothing newer to check.)
    if (extrapMs === 0 && b !== a) {
      const liveInB = new Set(b.snap.projectiles.map((p) => p.id));
      survivors = survivors.filter((p) => liveInB.has(p.id));
    }

    // Bake the render pose: advance by the sub-tick remainder (linear — a bounce
    // landing mid-sub-tick is sub-pixel and ignored) and pin prev === current.
    return survivors.map((p) => {
      const x = p.x + p.vx * frac;
      const y = p.y + p.vy * frac;
      return { ...p, x, y, prevX: x, prevY: y };
    });
  }
}
