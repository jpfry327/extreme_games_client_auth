import { COMBAT } from "../../config";
import { isAlive } from "../player";
import type { Player, PlayerId } from "../types";
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
    if (!world.defendsPlayer(victim.id)) continue; // a mirror — its own node decides its death
    if (!isAlive(victim)) continue; // already dead and counting down
    if (victim.resources.energy > 0) continue;

    victim.resources.energy = 0;
    victim.combat.respawnAt = world.tick + COMBAT.enterDelayTicks;
    victim.combat.deaths++;

    // Kill credit (killer's kills/bounty/score) is owned by whoever holds the
    // scoreboard. On the legacy single-world path and the server that's here,
    // credit inline. On a client `LocalSim` (`scoresKills === false`) it's deferred:
    // the client just *names* the killer (the killer isn't simulated here, so don't
    // resolve it against the local world) and reports the death; the server credits
    // via `creditKill`.
    const killerId = victim.combat.lastHitBy;
    const eventKiller = world.scoresKills
      ? (creditKill(world, killerId, victim.id, victim.combat.bounty)?.id ?? null)
      : killerId !== null && killerId !== victim.id
        ? killerId
        : null;

    world.events.push({
      type: "shipDied",
      victim: victim.id,
      killer: eventKiller,
      bounty: victim.combat.bounty,
      x: victim.kinematics.x,
      y: victim.kinematics.y,
    });
  }
}

/** Award a kill to `killerId` for `victimId` dying worth `victimBounty`: the
 *  killer gains `BountyIncreaseForKill` bounty and scores the victim's bounty
 *  (plus `RewardBase`). Returns the credited killer, or null for an uncredited
 *  death (self-inflicted, no killer, or the killer has since left).
 *
 *  Called inline by `deathSystem` on the scoreboard-owning node, and directly by
 *  the **relay server** when it processes a client's `DeathReport` (the dying
 *  client names its own killer — "defender names the killer"). Taking explicit
 *  args rather than a `Player` lets the server credit from a report without a
 *  victim object. */
export function creditKill(
  world: World,
  killerId: PlayerId | null,
  victimId: PlayerId,
  victimBounty: number,
): Player | null {
  if (killerId === null || killerId === victimId) return null;

  const killer = world.players.get(killerId);
  if (!killer) return null;

  killer.combat.kills++;
  killer.combat.bounty += COMBAT.bountyIncreaseForKill;
  killer.combat.score += victimBounty + COMBAT.killPointsBase;
  return killer;
}
