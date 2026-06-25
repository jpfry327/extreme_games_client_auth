/**
 * Client-side snapshot interpolation — M2.2.
 *
 * The server broadcasts full snapshots at ~33Hz but the renderer runs at ~60fps,
 * so applying each snapshot directly makes every entity snap 33×/sec. This module
 * smooths that out by rendering remote entities **~interpDelay in the past**,
 * interpolating between the two buffered snapshots that straddle that render time
 * (the canonical Source-engine approach — architecture §5.2, roadmap M2.2).
 *
 * The timeline is built from **client receive-time** (`performance.now()`), not
 * the server tick, so no clock-sync is needed.
 *
 * `buildView` bakes the interpolated pose into a *view* `World` whose `prev*`
 * fields equal `current`, so the existing renderer (which lerps `prev*→current`
 * by `alpha`) draws exactly the baked pose regardless of the `alpha` it's passed.
 * The renderer stays completely untouched.
 *
 * What this step deliberately does NOT do (kept isolated per the M2 sub-split):
 *   - the **local player** is pinned to the latest snapshot, not interpolated
 *     (still laggy; client prediction is M2.4).
 *
 * Projectiles are **not** handled here at all (M2.8): the local player's own
 * shots come from the `Predictor` (M2.6), and *every other* player's shots are
 * simulated deterministically by the `RemoteProjectileSimulator` (M2.8) instead
 * of being lerped — so a bullet that bounces off a wall between two snapshots
 * traces the real bounce path rather than teleporting through the corner. Both
 * sources are stitched into `view.projectiles` by main.ts after `buildView`.
 */

import { TICK_DT } from "../config";
import type { Kinematics, Player, PlayerId } from "../sim/types";
import type { World } from "../sim/world";
import type { Snapshot } from "./snapshot";

/** A snapshot tagged with the local time it arrived. */
export interface BufferedSnapshot {
  snap: Snapshot;
  /** `performance.now()` ms at receipt — the interpolation timeline. */
  receivedAt: number;
}

/** The snapshot window straddling a given render time, the result of
 *  `pickStraddlingPair`. Both the ship interpolator and the projectile simulator
 *  (M2.8) pick their window through this one function, so remote ships and remote
 *  bullets are always resolved against the *same* render time — they can never
 *  disagree about where "now − interpDelay" falls. */
export interface StraddlePair {
  /** The older sample (≤ renderTime). At the buffer edges `a === b`. */
  a: BufferedSnapshot;
  /** The newer sample (≥ renderTime). */
  b: BufferedSnapshot;
  /** Lerp fraction from `a` to `b` (0 at `a`, 1 at `b`). */
  t: number;
  /** Dead-reckoning window (ms) past the newest sample — non-zero only when
   *  render time is beyond the newest snapshot (buffer starvation). 0 while a
   *  real straddling pair exists. */
  extrapMs: number;
}

/**
 * Pick the buffered snapshot pair straddling `renderTime` (the canonical
 * Source-engine interpolation window). Returns `null` only for an empty buffer.
 *
 *   - Before the oldest sample (buffer warming up): clamp to the oldest, `t=0`.
 *   - At/after the newest sample (lag spike / dropped run): clamp to the newest
 *     and report an `extrapMs` window (capped at `extrapolateMaxMs`) so callers
 *     can dead-reckon forward then freeze, rather than snapping.
 *   - Otherwise: the two samples `[a, b]` with `a.receivedAt ≤ renderTime ≤
 *     b.receivedAt`, and `t` the position between them.
 */
export function pickStraddlingPair(
  buffer: readonly BufferedSnapshot[],
  renderTime: number,
  extrapolateMaxMs: number,
): StraddlePair | null {
  if (buffer.length === 0) return null;
  const newest = buffer[buffer.length - 1];

  if (renderTime <= buffer[0].receivedAt) {
    // Before our oldest sample (buffer warming up) — clamp to the oldest pose.
    return { a: buffer[0], b: buffer[0], t: 0, extrapMs: 0 };
  }
  if (renderTime >= newest.receivedAt) {
    // Caught up to (or past) the newest sample — report a bounded extrapolation
    // window from it. The roadmap's buffer-starvation fallback.
    return {
      a: newest,
      b: newest,
      t: 0,
      extrapMs: Math.min(renderTime - newest.receivedAt, extrapolateMaxMs),
    };
  }
  // Advance until renderTime falls inside [buffer[i], buffer[i+1]].
  let i = 0;
  while (i < buffer.length - 1 && buffer[i + 1].receivedAt < renderTime) i++;
  const a = buffer[i];
  const b = buffer[i + 1];
  const span = b.receivedAt - a.receivedAt;
  const t = span > 0 ? (renderTime - a.receivedAt) / span : 0;
  return { a, b, t, extrapMs: 0 };
}

/** How many snapshots to retain. At ~33Hz that's ~0.9s of history — far more than
 *  the interpolation window needs, leaving margin for jitter / lag spikes
 *  while still bounding memory. (Edge case: if the tab is backgrounded for
 *  ~1s, rAF pauses while snapshots keep arriving, so un-rendered snapshots are
 *  trimmed here and their events are lost — cosmetic only, acceptable.) */
const MAX_BUFFER = 30;

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Interpolate an angle the short way around the circle, so a ship crossing the
 *  0/2π seam rotates by the small arc instead of spinning all the way back. */
function lerpAngle(a: number, b: number, t: number): number {
  const twoPi = Math.PI * 2;
  let d = (b - a) % twoPi;
  if (d > Math.PI) d -= twoPi;
  if (d < -Math.PI) d += twoPi;
  return a + d * t;
}

export class SnapshotInterpolator {
  private buffer: BufferedSnapshot[] = [];
  /** `receivedAt` of the newest snapshot whose events have already been released.
   *  Events fire once, in interpolated time, when render time passes them. */
  private lastEventTime = -Infinity;

  /** Buffer a freshly received snapshot. `nowMs` is `performance.now()`. */
  push(snap: Snapshot, nowMs: number): void {
    this.buffer.push({ snap, receivedAt: nowMs });
    if (this.buffer.length > MAX_BUFFER) this.buffer.shift();
  }

  /** The buffered snapshots (read-only). The `RemoteProjectileSimulator` (M2.8)
   *  reads this so it resolves remote bullets against the *exact same* buffer and
   *  render window the ships are interpolated through — no second timeline. */
  get snapshots(): readonly BufferedSnapshot[] {
    return this.buffer;
  }

  /**
   * The server tick the local view corresponds to at render time `nowMs −
   * interpDelayMs` — the rewind target for server-side lag compensation (M2.9).
   * The firer is always looking at remote ships interpolated between the
   * straddling snapshot pair, so the tick it's effectively aiming through is those
   * two snapshots' ticks blended by the same `t` the poses use, rounded to a whole
   * tick (the server's history is keyed by integer ticks). Stamped onto each
   * outgoing input so the server can rewind targets to exactly this view.
   *
   * Returns `null` before any snapshot has arrived (no view yet → no
   * compensation). During buffer starvation the pair clamps to the newest sample,
   * so this returns the newest tick — i.e. less rewind, never more.
   */
  renderTick(nowMs: number, interpDelayMs: number, extrapolateMaxMs: number): number | null {
    const renderTime = nowMs - interpDelayMs;
    const pair = pickStraddlingPair(this.buffer, renderTime, extrapolateMaxMs);
    if (!pair) return null;
    const { a, b, t } = pair;
    return Math.round(a.snap.tick + (b.snap.tick - a.snap.tick) * t);
  }

  /**
   * Populate `view` with the interpolated world for render time `nowMs −
   * interpDelayMs`. Remote *players* are lerped between the straddling snapshot
   * pair; the local player is pinned to the newest snapshot. Projectiles are left
   * empty here — main.ts fills them from the Predictor + RemoteProjectileSimulator
   * (M2.8). Released events (in interpolated time) are written to `view.events`.
   *
   * On buffer starvation (render time is past the newest snapshot — a lag spike
   * or a run of dropped snapshots) remote entities are dead-reckoned forward from
   * their last velocity for up to `extrapolateMaxMs`, then frozen (M2.5).
   */
  buildView(
    view: World,
    nowMs: number,
    interpDelayMs: number,
    localPlayerId: PlayerId,
    extrapolateMaxMs = 0,
  ): void {
    if (this.buffer.length === 0) return;

    const newest = this.buffer[this.buffer.length - 1];
    const renderTime = nowMs - interpDelayMs;

    // Pick the straddling snapshot pair a (older) .. b (newer). Shared with the
    // remote-projectile simulator (M2.8) so ships and bullets agree on the window.
    const { a, b, t, extrapMs } = pickStraddlingPair(this.buffer, renderTime, extrapolateMaxMs)!;

    view.tick = newest.snap.tick;

    // Convert the dead-reckoning window into sim ticks (velocities are px/tick).
    const extrapTicks = extrapMs / (1000 * TICK_DT);

    // --- players -------------------------------------------------------------
    const olderPlayers = new Map(a.snap.players.map((p) => [p.id, p]));
    view.players.clear();
    for (const bp of b.snap.players) {
      if (bp.id === localPlayerId) continue; // local handled below, from newest
      view.players.set(bp.id, interpolatePlayer(olderPlayers.get(bp.id), bp, t, extrapTicks));
    }
    // The local player is NOT interpolated — render it from the latest
    // authoritative snapshot (prediction overrides it in main.ts since M2.4).
    const localNewest = newest.snap.players.find((p) => p.id === localPlayerId);
    if (localNewest) view.players.set(localNewest.id, pinPlayer(localNewest));

    // --- projectiles ---------------------------------------------------------
    // Intentionally empty (M2.8). Projectiles are no longer interpolated here:
    // main.ts fills `view.projectiles` from the Predictor (own shots, M2.6) and
    // the RemoteProjectileSimulator (everyone else's, simulated deterministically
    // so bounces don't teleport). We only clear it so the simulator/predictor
    // start from an empty list each frame.
    view.projectiles.length = 0;

    // --- events: release each snapshot's events once, in interpolated time ---
    // The watermark is a strict `>`: two snapshots sharing an identical
    // receivedAt (same performance.now() tick) would drop the second's events,
    // but at ~33Hz that collision effectively never happens.
    view.events.length = 0;
    for (const buf of this.buffer) {
      if (buf.receivedAt > this.lastEventTime && buf.receivedAt <= renderTime) {
        for (const e of buf.snap.events) view.events.push(e);
        this.lastEventTime = buf.receivedAt;
      }
    }
  }
}

/** Build a view player at the interpolated pose between `older` and `newer`.
 *  A fresh kinematics object is required — mutating the buffered snapshot's would
 *  corrupt the next frame's interpolation. Other components are read-only in the
 *  renderer/HUD, so they're shared by reference. */
function interpolatePlayer(
  older: Player | undefined,
  newer: Player,
  t: number,
  extrapTicks = 0,
): Player {
  // Only interpolate from a *live* previous pose. With no older sample (the
  // player just joined) or a dead one (they respawned this interval — their
  // older pose is the death site), lerping would streak the ship across the map
  // from its old position. Pin to the fresh pose instead, so a join/respawn pops
  // in cleanly. (This is what PlayerSpawnedEvent guards against — sim/types.ts.)
  if (!older || older.combat.respawnAt !== 0) return pinPlayer(newer, extrapTicks);

  const nk = newer.kinematics;
  const ok = older.kinematics;
  const x = lerp(ok.x, nk.x, t) + nk.vx * extrapTicks;
  const y = lerp(ok.y, nk.y, t) + nk.vy * extrapTicks;
  const rotation = lerpAngle(ok.rotation, nk.rotation, t);
  return { ...newer, kinematics: bakedKinematics(nk, x, y, rotation) };
}

/** Build a view player pinned to the snapshot pose, optionally dead-reckoned
 *  forward by `extrapTicks` of its velocity (buffer-starvation fallback). */
function pinPlayer(p: Player, extrapTicks = 0): Player {
  const k = p.kinematics;
  const x = k.x + k.vx * extrapTicks;
  const y = k.y + k.vy * extrapTicks;
  return { ...p, kinematics: bakedKinematics(k, x, y, k.rotation) };
}

/** Kinematics with the given pose and `prev* === current`, so the renderer's
 *  `prev→current` lerp is a no-op and draws exactly this pose. Velocity is
 *  carried through unchanged (unused by the renderer, but keeps the shape whole). */
function bakedKinematics(src: Kinematics, x: number, y: number, rotation: number): Kinematics {
  return {
    x,
    y,
    vx: src.vx,
    vy: src.vy,
    rotation,
    prevX: x,
    prevY: y,
    prevRotation: rotation,
  };
}
