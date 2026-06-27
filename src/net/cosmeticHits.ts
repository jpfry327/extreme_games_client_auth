/**
 * Client-side cosmetic hit *feedback* for the client-authoritative ("defender
 * authority") relay model — the visual-only successor to the retired
 * `predictedHits.ts` (which leaned on the pre-pivot predictor + `spawnSeq`).
 *
 * The problem the pivot reintroduced: damage is adjudicated by the *defender*, so
 * one of your own shots is never tested against an enemy on *your* screen — it
 * sails straight *through* the enemy sprite and (a bomb) only explodes later, on a
 * wall, while the real hit/explosion (if any) returns ~1 RTT later on the relay
 * snapshot. That reads as "my bullets and bombs go right through other players".
 *
 * This detector finds the instant one of *your own* in-flight projectiles overlaps
 * an enemy **as drawn** — your shot at the present leading edge vs the enemy
 * interpolated in the past, the two sprites the player actually sees — so the
 * caller can, immediately and entirely cosmetically:
 *   1. draw the burst/spark right there,
 *   2. stop drawing the projectile (it ends *at* the enemy, not through it), and
 *   3. drop the local copy from the owner's `LocalSim` (the defender holds its own
 *      injected copy and adjudicates the real hit, so dropping ours only stops the
 *      shot flying on / a missed bomb stray-detonating on a far wall).
 *
 * It is **cosmetic only** — it never touches energy, damage, kills, or death. The
 * accepted trade (the same one Subspace makes) is the occasional false positive: a
 * shot that looked like it connected on your screen but the defender dodged on
 * theirs still draws a burst that did no damage.
 *
 * A projectile must have been seen in a *prior* `detect()` call before it can fire
 * (`pendingFire` → `hit`): that one-frame age guarantees the owner has already
 * reported the shot at least once, so dropping our local copy can never rob the
 * defender of a shot it had not yet received (the point-blank fire-and-overlap-in-
 * one-frame edge).
 */

import { shipConfig } from "../config";
import { isAlive } from "../sim/player";
import type { Player, Projectile } from "../sim/types";

/** One cosmetic hit to surface: what struck, where to draw it, whom it struck, and
 *  the projectile's stable `id` (so the caller can stop drawing / drop it). */
export interface CosmeticHit {
  kind: Projectile["kind"];
  x: number;
  y: number;
  target: Player["id"];
  projectileId: number;
}

export class CosmeticHitDetector {
  /** Projectile ids already detonated once — drawn-skipped and dropped by the
   *  caller, and never re-detonated. Pruned each `detect()` to ids still in flight. */
  private readonly hit = new Set<number>();
  /** Ids of own shots present in the previous `detect()` call, so a shot must
   *  survive ≥1 frame (and thus a report) before it may detonate (see header). */
  private prevSeen = new Set<number>();

  /**
   * Find newly-overlapping own in-flight projectiles against the drawn enemies.
   * `projectiles` are the owner's own live shots (present leading edge — what's
   * drawn); `enemies` are the interpolated remote players (everyone but self).
   * Each projectile detonates at most once.
   */
  detect(projectiles: readonly Projectile[], enemies: readonly Player[]): CosmeticHit[] {
    const live = new Set(projectiles.map((p) => p.id));
    for (const id of this.hit) if (!live.has(id)) this.hit.delete(id);

    const out: CosmeticHit[] = [];
    for (const p of projectiles) {
      if (this.hit.has(p.id)) continue; // already detonated once
      if (!this.prevSeen.has(p.id)) continue; // unseen last frame — not yet reported
      for (const e of enemies) {
        if (!isAlive(e)) continue; // a respawning ghost can't be hit
        const reach = p.radius + shipConfig(e.shipType).radius;
        const dx = p.x - e.kinematics.x;
        const dy = p.y - e.kinematics.y;
        if (dx * dx + dy * dy <= reach * reach) {
          this.hit.add(p.id);
          out.push({ kind: p.kind, x: p.x, y: p.y, target: e.id, projectileId: p.id });
          break; // one hit per projectile
        }
      }
    }

    this.prevSeen = live;
    return out;
  }

  /** Whether projectile `id` has cosmetically detonated — used to skip drawing it
   *  and to drop it from the owner's `LocalSim`. */
  isHit(id: number): boolean {
    return this.hit.has(id);
  }
}
