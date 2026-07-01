/**
 * Remote players — playback of everyone who isn't me (netcode §2, §4).
 *
 * A remote player lives in the same `world.players` map as the local ship, so
 * the renderer draws it with zero special-casing. The difference is that the sim
 * never steps it (the `authoritativePlayerId` seam in world.ts skips non-local
 * players); its motion is driven entirely from here.
 *
 * **M2.1 — smoothed playback (netcode §4).** Between packets a remote is advanced
 * by **dead reckoning** (`coastPlayer`), so it coasts and bounces off walls like
 * the real ship. When a fresh position packet lands we extrapolate it to the
 * estimated present, compare against where we're drawing it, and either **snap**
 * (a big discrepancy → hard warp) or smear the correction across a **200 ms
 * linear lerp** so the fix is invisible. The renderer's existing `prev*`/`alpha`
 * interpolation draws the sub-tick blend for free — which is why the whole thing
 * is advanced on the fixed sim tick, not per rendered frame.
 *
 * The per-remote lerp state is transient net bookkeeping, not sim state, so it
 * lives here (never on the serializable `Player`).
 */

import { NET, TILE_SIZE } from "../config";
import { coastPlayer } from "../sim/systems/movement";
import { spawnProjectile } from "../sim/systems/firing";
import { isAlive } from "../sim/player";
import type { PositionMessage, RemoteInfo } from "./protocol";
import type { PlayerId } from "../sim/types";
import type { World } from "../sim/world";

/** Snap threshold in pixels (per axis) — a discrepancy at least this large is a
 *  warp, not something to smooth over (netcode §4). */
const SNAP_PX = NET.snapTiles * TILE_SIZE;

/** The linear error-correction a remote is still working off. When `ticksLeft`
 *  hits 0 the ship is on pure dead reckoning. */
interface Playback {
  lerpVx: number; // per-tick correction added on top of dead reckoning
  lerpVy: number;
  ticksLeft: number;
}

export class RemotePlayers {
  private readonly playback = new Map<PlayerId, Playback>();

  /** Ensure a remote exists, placed at its asserted pose with no interpolation
   *  and no pending correction. Idempotent: a repeated enter just re-seats it. */
  ensureRemote(world: World, info: RemoteInfo): void {
    if (!world.players.has(info.id)) {
      world.addPlayer(info.id, info.name, info.team, info.shipType);
    }
    const k = world.players.get(info.id)!.kinematics;
    k.x = k.prevX = info.x;
    k.y = k.prevY = info.y;
    k.vx = 0;
    k.vy = 0;
    k.rotation = k.prevRotation = 0;
    this.reset(info.id);
  }

  /**
   * Apply an incoming position packet (netcode §4). Steps: save the rendered
   * pose → hard-set kinematics to the asserted pose → dead-reckon forward to the
   * estimated present (`projected`) → measure the error against the rendered
   * pose → snap on a large error, else set a 200 ms linear correction.
   */
  applyPosition(world: World, pkt: PositionMessage): void {
    const id = pkt.id;
    if (id === undefined || !world.players.has(id)) return; // enter arrives before pos
    const p = world.players.get(id)!;
    const k = p.kinematics;

    // 1. Where we're currently drawing this ship.
    const renderedX = k.x;
    const renderedY = k.y;

    // 2. Adopt the asserted pose, then 3. extrapolate to the estimated present.
    k.x = pkt.x;
    k.y = pkt.y;
    k.vx = pkt.vx;
    k.vy = pkt.vy;
    k.rotation = pkt.rotation;
    for (let i = 0; i < NET.ageTicks; i++) coastPlayer(p, world.map);

    // 4. Error = projected present − where we're drawing it.
    const errX = k.x - renderedX;
    const errY = k.y - renderedY;
    const st = this.get(id);

    if (Math.abs(errX) >= SNAP_PX || Math.abs(errY) >= SNAP_PX) {
      // 5a. Snap: leave the ship at `projected`, kill any correction, and set
      //     prev = current so the renderer hard-cuts instead of interpolating.
      k.prevX = k.x;
      k.prevY = k.y;
      k.prevRotation = k.rotation;
      st.lerpVx = 0;
      st.lerpVy = 0;
      st.ticksLeft = 0;
    } else {
      // 5b. Smooth: keep coasting from the rendered pose (no visible pop) and
      //     close the gap to `projected` evenly over lerpTicks. Velocity and
      //     rotation stay at the freshly extrapolated values.
      k.x = renderedX;
      k.y = renderedY;
      st.lerpVx = errX / NET.lerpTicks;
      st.lerpVy = errY / NET.lerpTicks;
      st.ticksLeft = NET.lerpTicks;
    }

    p.resources.energy = pkt.energy;
    p.combat.bounty = pkt.bounty;

    // A weapon rides only on the packet the shooter sent the instant it fired
    // (netcode §3). Spawn its projectile locally from the *asserted* pose — not
    // the extrapolated/rendered one — so it leaves the ship exactly as the
    // shooter fired it. It then flies through the normal `projectileSystem` and
    // can hit our own hull; the shooter's client owns the identical shot.
    if (pkt.weapon) {
      world.projectiles.push(
        spawnProjectile(id, p.shipType, pkt.weapon.kind, pkt.x, pkt.y, pkt.vx, pkt.vy, pkt.rotation),
      );
    }
  }

  /** Advance every remote one sim tick: dead-reckon, then apply the decaying
   *  correction. Called once per fixed tick (netcode §4 step 6). A no-op in
   *  single-player/bot mode, where every player is authoritative. */
  advanceTick(world: World): void {
    for (const p of world.players.values()) {
      if (world.isAuthority(p.id)) continue; // local ship steps in the sim pipeline
      if (!isAlive(p)) continue; // dead remotes coast nowhere (death lands in M2.3)
      const k = p.kinematics;
      k.prevX = k.x;
      k.prevY = k.y;
      k.prevRotation = k.rotation;
      coastPlayer(p, world.map);
      const st = this.playback.get(p.id);
      if (st && st.ticksLeft > 0) {
        k.x += st.lerpVx;
        k.y += st.lerpVy;
        st.ticksLeft--;
      }
    }
  }

  /** Remove a remote that left the arena, dropping its playback state. */
  removeRemote(world: World, id: PlayerId): void {
    world.players.delete(id);
    this.playback.delete(id);
  }

  private get(id: PlayerId): Playback {
    let st = this.playback.get(id);
    if (!st) {
      st = { lerpVx: 0, lerpVy: 0, ticksLeft: 0 };
      this.playback.set(id, st);
    }
    return st;
  }

  private reset(id: PlayerId): void {
    const st = this.get(id);
    st.lerpVx = 0;
    st.lerpVy = 0;
    st.ticksLeft = 0;
  }
}
