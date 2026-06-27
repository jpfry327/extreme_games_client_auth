import { findSpawn } from "../spawn";
import { tierFor } from "../player";
import type { Player } from "../types";
import type { World } from "../world";

/**
 * Pipeline step 8b — respawn. A dead ship (`respawnAt > 0`) whose timer has
 * elapsed is reborn at a fresh spawn point with a full energy tank. Respawning:
 *
 *   - moves the ship to a new spawn and zeroes its velocity;
 *   - snaps `prev*` to the new pose so the renderer doesn't streak a line from
 *     the death site to the spawn;
 *   - clears the dead flag (`respawnAt = 0`), the bounty, and `lastHitBy`;
 *   - emits `playerSpawned` for the warp-in effect.
 *
 * Bounty resets to 0 on respawn (you earn it back by surviving and killing);
 * `score`, `kills`, and `deaths` persist across the whole session.
 */
export function respawnSystem(world: World): void {
  for (const player of world.players.values()) {
    if (!world.defendsPlayer(player.id)) continue; // a mirror — its own node respawns it
    const respawnAt = player.combat.respawnAt;
    if (respawnAt === 0 || world.tick < respawnAt) continue;
    respawn(world, player);
  }
}

function respawn(world: World, player: Player): void {
  const spawn = findSpawn(world.map, world.rng);
  const k = player.kinematics;
  k.x = k.prevX = spawn.x;
  k.y = k.prevY = spawn.y;
  k.vx = 0;
  k.vy = 0;

  player.resources.energy = tierFor(player).maxEnergy;
  player.combat.respawnAt = 0;
  player.combat.bounty = 0;
  player.combat.lastHitBy = null;

  world.events.push({ type: "playerSpawned", player: player.id, x: spawn.x, y: spawn.y });
}
