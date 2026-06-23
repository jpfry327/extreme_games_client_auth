import { BOMB, BULLET, SHIP } from "../config";
import { moveAndCollide } from "./collision";
import type { GameMap } from "./gamemap";
import type { Projectile, ProjectileKind, ShipState } from "./types";
import { snapDirection } from "./ship";

/** Per-weapon settings used at fire time (BULLET / BOMB in config.ts). */
interface WeaponSpec {
  speed: number;
  lifetimeTicks: number;
  fireEnergy: number;
  bounces: number;
}

const SPECS: Record<ProjectileKind, WeaponSpec> = {
  bullet: { speed: BULLET.speed, lifetimeTicks: BULLET.lifetimeTicks, fireEnergy: BULLET.fireEnergy, bounces: BULLET.bounces },
  bomb: { speed: BOMB.speed, lifetimeTicks: BOMB.lifetimeTicks, fireEnergy: BOMB.fireEnergy, bounces: BOMB.bounces },
};

/** Spawn a projectile from the ship's nose, inheriting its velocity. Returns
 *  null if not enough energy. The caller checks the relevant cooldown. */
function spawn(ship: ShipState, kind: ProjectileKind): Projectile | null {
  const spec = SPECS[kind];
  if (ship.energy < spec.fireEnergy) return null;
  ship.energy -= spec.fireEnergy;

  const heading = snapDirection(ship.rotation, SHIP.directions);
  const fx = Math.sin(heading);
  const fy = -Math.cos(heading);

  // Spawn just past the nose so we don't collide with our own ship.
  const muzzle = SHIP.radius + 2;
  const x = ship.x + fx * muzzle;
  const y = ship.y + fy * muzzle;

  return {
    kind,
    x,
    y,
    vx: ship.vx + fx * spec.speed,
    vy: ship.vy + fy * spec.speed,
    life: spec.lifetimeTicks,
    bounces: spec.bounces,
    alive: true,
    prevX: x,
    prevY: y,
  };
}

/** Try to fire the gun. Respects bullet cooldown + energy. */
export function tryFireBullet(ship: ShipState): Projectile | null {
  if (ship.bulletCooldown > 0) return null;
  const p = spawn(ship, "bullet");
  if (p) ship.bulletCooldown = BULLET.fireDelayTicks;
  return p;
}

/** Try to fire a bomb. Respects bomb cooldown + energy. */
export function tryFireBomb(ship: ShipState): Projectile | null {
  if (ship.bombCooldown > 0) return null;
  const p = spawn(ship, "bomb");
  if (p) ship.bombCooldown = BOMB.fireDelayTicks;
  return p;
}

const RADIUS: Record<ProjectileKind, number> = { bullet: BULLET.radius, bomb: BOMB.radius };

/** Advance one projectile by a tick: move, bounce or die on walls, age out. */
export function stepProjectile(p: Projectile, map: GameMap): void {
  p.prevX = p.x;
  p.prevY = p.y;

  const r = moveAndCollide(map, p.x, p.y, p.vx, p.vy, RADIUS[p.kind], 1.0);
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
