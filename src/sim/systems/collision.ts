import { shipConfig } from "../../config";
import { isAlive } from "../player";
import type { Player, Projectile } from "../types";
import type { World } from "../world";

/**
 * Pipeline step 6 — collision (projectile↔ship). For each live projectile we test
 * it against every player this node **defends** (the client-authoritative model:
 * only a player's own node adjudicates hits against it — "defender's screen wins"),
 * ignoring the projectile's own `owner` and any dead player.
 *
 * This system only *detects* and *flags*; it never changes energy — that's the
 * damage system's job (step 7). Keeping the two apart is the documented design
 * (architecture §3): collision answers "what touched what", damage answers "so
 * what happens". On a hit we kill the projectile here so it's compacted out and
 * can't hit twice; the resulting damage is resolved next.
 *
 *   - A **bullet** that overlaps a ship is recorded as a `Contact` (it deals a
 *     flat hit to exactly that ship).
 *   - A **bomb** that touches a ship is simply marked dead; the damage system
 *     detonates every bomb that died this tick into an area blast, so a bomb
 *     that hit a ship and one that hit a wall explode through the same path.
 *
 * The overlap test is always against the target's **present** pose — favouring the
 * defender (the relay model has no server-side rewind; an incoming shot is flown to
 * the present and tested there). (Ship↔ship and ship↔prize/flag/ball collisions are
 * later milestones.)
 */
export function collisionSystem(world: World): void {
  world.contacts = [];

  for (const p of world.projectiles) {
    if (!p.alive) continue; // already died to a wall this tick (step 5)

    for (const target of world.players.values()) {
      if (target.id === p.owner) continue; // never hit the firer
      if (!world.defendsPlayer(target.id)) continue; // only this node's defender adjudicates a hit
      if (!isAlive(target)) continue; // ghosts waiting to respawn don't collide

      if (!overlaps(p, target)) continue;

      if (p.kind === "bullet") {
        world.contacts.push({ projectile: p, target });
      }
      // Both bullets and bombs die on contact; the bomb's blast is applied in
      // the damage step from its corpse.
      p.alive = false;
      break; // this projectile is spent; stop checking further ships
    }
  }
}

/** Circle overlap between a projectile and a target at its present pose. */
function overlaps(p: Projectile, target: Player): boolean {
  const k = target.kinematics;
  const reach = p.radius + shipConfig(target.shipType).radius;
  const dx = p.x - k.x;
  const dy = p.y - k.y;
  return dx * dx + dy * dy <= reach * reach;
}
