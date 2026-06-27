import { moveAndCollide } from "../collision";
import type { GameMap } from "../gamemap";
import type { Projectile } from "../types";
import type { World } from "../world";

/**
 * Pipeline step 5 — projectiles. Advance every projectile one tick: move,
 * bounce or die on walls, age out. A projectile that dies here is just marked
 * `alive = false`; it is NOT removed yet and a dying bomb does NOT explode here.
 *
 * That deferral is deliberate. Collision (step 6) and damage (step 7) run after
 * this and need the corpses: a bomb that hit a wall this tick must still
 * detonate into an area blast, exactly like one that hit a ship. So the damage
 * system is what emits `bombExploded` and what compacts the dead projectiles
 * out — see damage.ts. This system only handles flight against the map.
 */
export function projectileSystem(world: World): void {
  for (const p of world.projectiles) {
    if (p.alive) stepProjectile(p, world.map);
  }
}

/** Advance one projectile by a tick: move, bounce or die on walls, age out.
 *  Exported so `net/localSim.ts` can fast-forward a freshly-injected incoming shot
 *  to the present (the Subspace weapon catch-up) without running a full world step. */
export function stepProjectile(p: Projectile, map: GameMap): void {
  p.prevX = p.x;
  p.prevY = p.y;

  const r = moveAndCollide(map, p.x, p.y, p.vx, p.vy, p.radius, 1.0);
  p.x = r.x;
  p.y = r.y;

  if (r.hitX || r.hitY) {
    if (p.bounces > 0) {
      p.bounces--;
      p.vx = r.vx;
      p.vy = r.vy;
    } else {
      p.alive = false;
      return;
    }
  }

  if (--p.life <= 0) p.alive = false;
}
