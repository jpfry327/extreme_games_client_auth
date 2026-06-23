import { TILE_SIZE } from "../config";
import { GameMap } from "./gamemap";
import { createShip, stepShip } from "./ship";
import { stepProjectile, tryFireBomb, tryFireBullet } from "./projectiles";
import type { GameEvent, InputCommand, Projectile, ShipState } from "./types";

/**
 * The whole game state for one tick of simulation. `step()` advances everything
 * by exactly one fixed tick. This is the piece that would run on the server.
 */
export class World {
  ship: ShipState;
  projectiles: Projectile[] = [];

  /** Events produced this tick (e.g. bomb explosions). Appended to during
   *  step(); the renderer drains this once per drawn frame. */
  events: GameEvent[] = [];

  constructor(public readonly map: GameMap) {
    const spawn = findSpawn(map);
    this.ship = createShip(spawn.x, spawn.y);
  }

  step(input: InputCommand): void {
    stepShip(this.ship, input, this.map);

    if (input.fire) {
      const b = tryFireBullet(this.ship);
      if (b) this.projectiles.push(b);
    }
    if (input.bomb) {
      const b = tryFireBomb(this.ship);
      if (b) this.projectiles.push(b);
    }

    for (const p of this.projectiles) {
      stepProjectile(p, this.map);
      // A bomb that just died — by wall impact or by aging out — detonates.
      if (!p.alive && p.kind === "bomb") {
        this.events.push({ type: "bombExploded", x: p.x, y: p.y });
      }
    }
    // Drop dead projectiles (filter is fine at prototype counts).
    if (this.projectiles.some((p) => !p.alive)) {
      this.projectiles = this.projectiles.filter((p) => p.alive);
    }
  }
}

/** Find an open spawn point: start at map center, spiral out to the nearest
 *  empty tile so we never spawn embedded in a wall. */
function findSpawn(map: GameMap): { x: number; y: number } {
  const cx = Math.floor(map.width / 2);
  const cy = Math.floor(map.height / 2);
  const toPixel = (tx: number, ty: number) => ({
    x: tx * TILE_SIZE + TILE_SIZE / 2,
    y: ty * TILE_SIZE + TILE_SIZE / 2,
  });

  if (!map.isSolidTile(cx, cy)) return toPixel(cx, cy);

  for (let radius = 1; radius < map.width; radius++) {
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (Math.abs(dx) !== radius && Math.abs(dy) !== radius) continue; // ring only
        if (!map.isSolidTile(cx + dx, cy + dy)) return toPixel(cx + dx, cy + dy);
      }
    }
  }
  return toPixel(cx, cy); // give up; shouldn't happen
}
