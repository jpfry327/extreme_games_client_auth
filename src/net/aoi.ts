/**
 * Area-of-interest (AOI) culling — M2.14.
 *
 * The per-client snapshot filter: given the full (already-built) snapshot and a
 * recipient, return only the entities that recipient can see. This is the seam
 * `serializeSnapshotFor`'s `playerId` argument has reserved since M2.0; filling
 * it makes snapshot size scale with *local density* instead of arena population.
 *
 * The visibility rule mirrors Subspace's `max(WeaponRange, screen)`: the view is
 * a rectangle (a viewport) expanded by `weaponReach` on each axis, tested as a
 * cheap AABB — you receive anything on your screen or close enough to shoot you.
 *
 * Pure data in, pure data out (plain `Snapshot`, no `World`), so the *same*
 * function runs on both server paths: the loopback `serializeSnapshotFor` (over
 * the live world's snapshot) and the WebSocket `SnapshotChannel` (over the shared
 * quantized snapshot). Identical behavior, one source of truth.
 *
 * M2.14 is distance culling only. Stealth/cloak concealment plugs into the single
 * per-player predicate below (see the `M5` marker) without touching any of the
 * per-client baseline machinery.
 */

import type { PlayerId } from "../sim/types";
import type { Snapshot } from "./snapshot";
import { AOI } from "../config";

export interface AoiConfig {
  viewHalfWidth: number;
  viewHalfHeight: number;
  weaponReach: number;
  hysteresisPx: number;
}

/** The configured AOI rule from `config.ts`. A fresh object per call so callers
 *  can't accidentally alias and mutate the shared config. */
export function defaultAoiConfig(): AoiConfig {
  return { ...AOI };
}

/** Is the point (ex, ey) inside the viewer's AOI box? `slack` widens the box for
 *  entities the viewer already saw last frame (hysteresis). Pure AABB — no sqrt. */
export function inViewBox(
  viewerX: number,
  viewerY: number,
  ex: number,
  ey: number,
  cfg: AoiConfig,
  slack = 0,
): boolean {
  const hw = cfg.viewHalfWidth + cfg.weaponReach + slack;
  const hh = cfg.viewHalfHeight + cfg.weaponReach + slack;
  return Math.abs(ex - viewerX) <= hw && Math.abs(ey - viewerY) <= hh;
}

/**
 * Filter `snap` to what `viewerId` can see. `prevVisibleIds` is the set of player
 * ids the viewer received in its *previous* snapshot, used only for hysteresis so
 * a boundary entity doesn't flicker in/out each broadcast (pass undefined on a
 * stateless path like the zero-latency loopback).
 *
 * Only `players`/`projectiles` are filtered. `events` and `pings` pass through
 * whole: events are the arena-wide kill feed (you should see "A killed B" even if
 * both are off-screen; explosion events carry their own x,y and the renderer culls
 * by position), and a `pings` entry for a culled player is harmless (the client
 * never looks it up). Both are tiny and transient.
 */
export function filterSnapshotFor(
  snap: Snapshot,
  viewerId: PlayerId,
  cfg: AoiConfig,
  prevVisibleIds?: ReadonlySet<PlayerId>,
): Snapshot {
  const viewer = snap.players.find((p) => p.id === viewerId);
  // No viewer pose this frame (a just-disconnected id mid-broadcast, or the
  // loopback bot-vs-nobody case): never cull blind — send everything.
  if (!viewer) return snap;
  const vx = viewer.kinematics.x;
  const vy = viewer.kinematics.y;

  const players = snap.players.filter((p) => {
    if (p.id === viewerId) return true; // always include self
    // M5: concealment predicate goes here — a stealthed/cloaked player on another
    // team returns false here (omitted from the snapshot) before the box test.
    const slack = prevVisibleIds?.has(p.id) ? cfg.hysteresisPx : 0;
    return inViewBox(vx, vy, p.kinematics.x, p.kinematics.y, cfg, slack);
  });

  const projectiles = snap.projectiles.filter((proj) => {
    // Own shots always reach you, even fired off your own screen — in the relay
    // model the firer owns its shots and the server relays its authoritative copy
    // straight back (it never needs to adjudicate them against itself).
    if (proj.owner === viewerId) return true;
    return inViewBox(vx, vy, proj.x, proj.y, cfg);
  });

  return { ...snap, players, projectiles };
}
