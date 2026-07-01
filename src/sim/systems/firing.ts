import { shipConfig, type ShipType, type WeaponConfig } from "../../config";
import { isAlive, snapDirection } from "../player";
import type { Player, PlayerId, Projectile, ProjectileKind, StepContext } from "../types";
import type { World } from "../world";

/**
 * Pipeline step 3 — firing. Each player whose input requests it spawns a bullet
 * and/or bomb, gated by that weapon's cooldown and energy. New projectiles are
 * tagged with the firer as `owner` (so M1 can credit kills and skip self-hits).
 */
export function firingSystem(world: World, ctx: StepContext): void {
  for (const player of world.players.values()) {
    if (!world.isAuthority(player.id)) continue; // remotes fire via their own client (netcode §2.2)
    if (!isAlive(player)) continue; // dead ships can't fire
    const input = ctx.inputs.get(player.id);
    if (!input) continue;

    if (input.fire) fire(world, player, "bullet");
    if (input.bomb) fire(world, player, "bomb");
  }
}

/** Try to fire one weapon; on success push the projectile and emit a
 *  `weaponFired` event (the network layer folds it into a position packet so
 *  remotes spawn their own copy — netcode §3). No-op if the shot is gated. */
function fire(world: World, player: Player, kind: ProjectileKind): void {
  const p = tryFire(player, kind);
  if (!p) return;
  world.projectiles.push(p);
  world.events.push({ type: "weaponFired", owner: player.id, kind });
}

/** Fire one weapon if its cooldown is clear and there's energy for it. Returns
 *  the spawned projectile, or null if it couldn't fire. Mutates the player
 *  (debits energy, sets the cooldown). */
function tryFire(player: Player, kind: ProjectileKind): Projectile | null {
  const config = shipConfig(player.shipType);
  const weapon: WeaponConfig = kind === "bullet" ? config.bullet : config.bomb;
  const combat = player.combat;
  const cooldown = kind === "bullet" ? combat.bulletCooldown : combat.bombCooldown;

  if (cooldown > 0) return null;
  if (player.resources.energy < weapon.fireEnergy) return null;

  player.resources.energy -= weapon.fireEnergy;
  if (kind === "bullet") combat.bulletCooldown = weapon.fireDelayTicks;
  else combat.bombCooldown = weapon.fireDelayTicks;

  const k = player.kinematics;
  return spawnProjectile(player.id, player.shipType, kind, k.x, k.y, k.vx, k.vy, k.rotation);
}

/**
 * Build a projectile from a shooter's pose — the pure spawn logic, with no
 * gating or player mutation. It's a pure function of `{shipType, kind, pose}` +
 * config, which is exactly the property the netcode rests on (§0): both the
 * firing ship's own client and every remote reconstruct the *same* projectile
 * from the transmitted pose, so bullets never diverge from a config drift (§9).
 * `tryFire` calls this after gating; `net/remotePlayers` calls it from a received
 * weapon descriptor.
 */
export function spawnProjectile(
  owner: PlayerId,
  shipType: ShipType,
  kind: ProjectileKind,
  x: number,
  y: number,
  vx: number,
  vy: number,
  rotation: number,
): Projectile {
  const config = shipConfig(shipType);
  const weapon: WeaponConfig = kind === "bullet" ? config.bullet : config.bomb;

  const heading = snapDirection(rotation, config.directions);
  const fx = Math.sin(heading);
  const fy = -Math.cos(heading);

  // Spawn just past the nose so the shot doesn't collide with its own ship.
  const muzzle = config.radius + 2;
  const mx = x + fx * muzzle;
  const my = y + fy * muzzle;

  return {
    kind,
    owner,
    x: mx,
    y: my,
    vx: vx + fx * weapon.speed,
    vy: vy + fy * weapon.speed,
    life: weapon.lifetimeTicks,
    bounces: weapon.bounces,
    radius: weapon.radius,
    alive: true,
    prevX: mx,
    prevY: my,
  };
}
