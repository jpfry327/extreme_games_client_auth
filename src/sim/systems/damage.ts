import { COMBAT, shipConfig, type ShipType } from "../../config";
import { isAlive } from "../player";
import type { Player, PlayerId, Projectile } from "../types";
import type { World } from "../world";

/**
 * Pipeline step 7 — damage. Turn the collisions found in step 6 into energy
 * loss. Two sources:
 *
 *   1. **Bullet contacts** — each recorded `Contact` deals its weapon's flat
 *      damage to the one ship it struck.
 *   2. **Bomb detonations** — every bomb that died *this tick* (whether it hit a
 *      ship, a wall, or aged out) explodes into an area blast: full damage at
 *      the center, falling off linearly to zero at `BombExplodePixels`.
 *
 * Weapon damage belongs to the *firing* ship, not the victim. For every ship
 * that loses energy we set `lastHitBy` (so the death system can credit the
 * kill) and emit a `shipHit`. Energy is allowed to go negative here; the death
 * system (step 8) is what reads `energy <= 0`. Finally we compact the spent
 * projectiles out — this is the last system that needs their corpses.
 */
export function damageSystem(world: World): void {
  // 1. Bullet hits — flat, single-target.
  for (const { projectile, target } of world.contacts) {
    const damage = weaponOf(world, projectile, "bullet");
    applyDamage(world, target, projectile.owner, damage, target.kinematics.x, target.kinematics.y);
  }

  // 2. Bomb blasts — any dead bomb still in the list detonated this tick.
  for (const p of world.projectiles) {
    if (p.alive || p.kind !== "bomb") continue;
    detonateBomb(world, p);
  }

  // Drop spent projectiles now that their damage has been applied.
  if (world.projectiles.some((p) => !p.alive)) {
    world.projectiles = world.projectiles.filter((p) => p.alive);
  }
}

/** A bomb's area blast: damage every live enemy within `BombExplodePixels`,
 *  scaled down with distance, then announce the explosion for the renderer. The
 *  blast is tested against each target's present pose (the relay model adjudicates
 *  at the present, on the defending node, so there is no rewind). */
function detonateBomb(world: World, bomb: Projectile): void {
  world.events.push({ type: "bombExploded", x: bomb.x, y: bomb.y, owner: bomb.owner, id: bomb.id });

  const radius = COMBAT.bombExplodePixels;
  const full = weaponOf(world, bomb, "bomb");

  for (const target of world.players.values()) {
    if (target.id === bomb.owner) continue; // own bomb is harmless (BombSafety)
    if (!world.defendsPlayer(target.id)) continue; // only this node's defender takes the blast
    if (!isAlive(target)) continue;

    const tx = target.kinematics.x;
    const ty = target.kinematics.y;
    const tr = shipConfig(target.shipType).radius;

    // Distance from the blast to the ship's hull (center distance minus the
    // ship's radius), clamped at 0 so a direct hit takes full damage.
    const surface = Math.max(0, Math.hypot(tx - bomb.x, ty - bomb.y) - tr);
    if (surface >= radius) continue;

    const falloff = 1 - surface / radius; // 1 at center, 0 at the edge
    applyDamage(world, target, bomb.owner, full * falloff, tx, ty);
  }
}

/** Subtract energy, remember the attacker for kill credit, and emit `shipHit`. */
function applyDamage(
  world: World,
  target: Player,
  by: PlayerId,
  damage: number,
  x: number,
  y: number,
): void {
  if (damage <= 0) return;
  target.resources.energy -= damage;
  target.combat.lastHitBy = by;
  const fatal = target.resources.energy <= 0;
  world.events.push({ type: "shipHit", target: target.id, by, damage, x, y, fatal });
}

/** The weapon damage of a projectile's *firing* ship. If the owner has left,
 *  fall back to the Warbird table — at M1 there's only the one ship anyway. */
function weaponOf(world: World, projectile: Projectile, kind: "bullet" | "bomb"): number {
  const owner = world.players.get(projectile.owner);
  const shipType: ShipType = owner ? owner.shipType : 0;
  const cfg = shipConfig(shipType);
  return kind === "bullet" ? cfg.bullet.damage : cfg.bomb.damage;
}
