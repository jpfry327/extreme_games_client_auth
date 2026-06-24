/**
 * Snapshot serialization — the Layer A "wire format" between server and client.
 *
 * A Snapshot is the serializable subset of World: players, projectiles, and the
 * tick counter. The architecture (§5) keeps this separate from GameEvent[]
 * (transient "what happened" records); for the in-process loopback of M2.0 we
 * include events in the snapshot as a convenience — a real WebSocket protocol
 * would send them as a separate channel (M2.1).
 *
 * `serializeSnapshotFor(world, playerId)` builds a deep copy of the world for
 * one client. The `playerId` parameter is the per-client filter seam: stealth /
 * area-of-interest culling land here in M5. For now we send everything.
 *
 * `applySnapshot(clientWorld, snap)` overwrites the client world entirely. The
 * client world is NEVER stepped — it is purely driven by these snapshots.
 */

import type { GameEvent, Player, PlayerId, Projectile } from "../sim/types";
import type { World } from "../sim/world";

export interface Snapshot {
  tick: number;
  players: Player[];
  projectiles: Projectile[];
  /** Events from the ticked step, piggybacked on the snapshot for the loopback
   *  case. A real network protocol separates these (architecture §5). */
  events: GameEvent[];
}

/**
 * Produce a deep-copied snapshot for the given player. `structuredClone`
 * simulates the serialize→deserialize round-trip that a real wire would do,
 * ensuring neither side can alias into the other's state.
 */
export function serializeSnapshotFor(world: World, _playerId: PlayerId): Snapshot {
  return structuredClone({
    tick: world.tick,
    players: [...world.players.values()],
    projectiles: world.projectiles,
    events: world.events,
  });
}

/**
 * Overwrite the client world with the snapshot's data. Clears all prior state
 * (players, projectiles) and replaces it wholesale — no diffing, no merging.
 * Events are pushed onto the client world so the renderer and kill-feed can
 * drain them just as they did before the network seam existed.
 */
export function applySnapshot(clientWorld: World, snap: Snapshot): void {
  clientWorld.tick = snap.tick;

  clientWorld.players.clear();
  for (const p of snap.players) {
    clientWorld.players.set(p.id, p);
  }

  clientWorld.projectiles.length = 0;
  for (const proj of snap.projectiles) {
    clientWorld.projectiles.push(proj);
  }

  clientWorld.events.length = 0;
  for (const e of snap.events) {
    clientWorld.events.push(e);
  }
}
