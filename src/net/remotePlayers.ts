/**
 * Remote players — playback of everyone who isn't me (netcode §2, §4).
 *
 * A remote player lives in the same `world.players` map as the local ship, so
 * the renderer draws it with zero special-casing. The difference is that the sim
 * never steps it (the `authoritativePlayerId` seam in world.ts skips non-local
 * players); its entire state is written here from received packets.
 *
 * **M2.0 is deliberately unsmoothed:** a position packet snaps the ship to the
 * asserted pose, prev = current so the renderer's interpolation shows a hard cut
 * — the "raw dots" of the transport-and-echo milestone. `applyPosition` is the
 * exact function M2.1 replaces with dead reckoning + the 200 ms lerp + snap of
 * netcode §4; nothing else in the net stack changes when it does.
 */

import type { PositionMessage, RemoteInfo } from "./protocol";
import type { PlayerId } from "../sim/types";
import type { World } from "../sim/world";

/** Ensure a remote player exists in the world, created at its asserted position.
 *  Idempotent: a repeated enter/roster entry just refreshes the pose. */
export function ensureRemote(world: World, info: RemoteInfo): void {
  if (!world.players.has(info.id)) {
    world.addPlayer(info.id, info.name, info.team, info.shipType);
  }
  snapTo(world, info.id, info.x, info.y, 0, 0, 0);
}

/** Apply an incoming position packet: hard-snap the remote to the asserted pose
 *  and refresh the fields the HUD/nametags read (energy, bounty). */
export function applyPosition(world: World, pkt: PositionMessage): void {
  const id = pkt.id;
  if (id === undefined || !world.players.has(id)) return; // enter arrives before pos
  snapTo(world, id, pkt.x, pkt.y, pkt.vx, pkt.vy, pkt.rotation);
  const p = world.players.get(id)!;
  p.resources.energy = pkt.energy;
  p.combat.bounty = pkt.bounty;
}

/** Remove a remote player that left the arena. */
export function removeRemote(world: World, id: PlayerId): void {
  world.players.delete(id);
}

/** Hard-set a remote's kinematics with prev = current so the renderer does not
 *  interpolate across the jump — the unsmoothed snap of M2.0. */
function snapTo(
  world: World,
  id: PlayerId,
  x: number,
  y: number,
  vx: number,
  vy: number,
  rotation: number,
): void {
  const k = world.players.get(id)!.kinematics;
  k.x = k.prevX = x;
  k.y = k.prevY = y;
  k.vx = vx;
  k.vy = vy;
  k.rotation = k.prevRotation = rotation;
}
