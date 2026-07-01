import { COMBAT } from "../../config";
import { isAlive } from "../player";
import type { Player } from "../types";
import type { World } from "../world";

/**
 * Pipeline step 8a — death. Any living ship the damage system pushed to
 * `energy <= 0` dies this tick. Dying:
 *
 *   - starts the respawn timer (`respawnAt = tick + EnterDelay`), which is also
 *     the flag that marks the ship dead until the respawn system clears it;
 *   - credits the kill to `lastHitBy` — that player gains `BountyIncreaseForKill`
 *     bounty and scores the victim's bounty (plus `RewardBase`);
 *   - emits `shipDied` for the explosion, kill feed, and (later) audio.
 *
 * The victim keeps its bounty value in the event (that's what the kill was
 * worth); the bounty itself is zeroed when it respawns (step 8b).
 */
export function deathSystem(world: World): void {
  for (const victim of world.players.values()) {
    if (!world.isAuthority(victim.id)) continue; // only my own client declares my death (netcode §2.2)
    if (!isAlive(victim)) continue; // already dead and counting down
    if (victim.resources.energy > 0) continue;

    victim.resources.energy = 0;
    victim.combat.respawnAt = world.tick + COMBAT.enterDelayTicks;
    victim.combat.deaths++;

    const killer = creditKiller(world, victim);

    world.events.push({
      type: "shipDied",
      victim: victim.id,
      killer: killer ? killer.id : null,
      bounty: victim.combat.bounty,
      x: victim.kinematics.x,
      y: victim.kinematics.y,
    });
  }
}

/** Award the kill to whoever last damaged the victim (if they're still around
 *  and it wasn't a self-inflicted death). Returns the credited killer, or null
 *  for an uncredited death. */
function creditKiller(world: World, victim: Player): Player | null {
  const killerId = victim.combat.lastHitBy;
  if (killerId === null || killerId === victim.id) return null;

  const killer = world.players.get(killerId);
  if (!killer) return null;

  killer.combat.kills++;
  killer.combat.bounty += COMBAT.bountyIncreaseForKill;
  killer.combat.score += victim.combat.bounty + COMBAT.killPointsBase;
  return killer;
}
