/**
 * Client-side snapshot dead-reckoning (Subspace-faithful present-time model).
 *
 * The server broadcasts full snapshots at ~33Hz but the renderer runs at ~60fps.
 * Rather than smooth that by rendering remotes **in the past** (the old M2.2
 * Source-engine interpolation, which made the attacker aim at a target ~interpDelay
 * stale while the defender adjudicated near its present — the laggy-feel root
 * cause), this extrapolates each remote **forward to its true present**: render
 * time is `now + leadMs`, so every entity is dead-reckoned along its last velocity
 * from the newest snapshot. This mirrors Continuum, which simulates remote ships
 * forward by the sender's ping to land at local "now" and keeps coasting them.
 *
 * A maneuvering ship's extrapolation is wrong by its un-modeled acceleration, so a
 * raw projection would jitter to truth on every snapshot. The *drawn* pose is
 * therefore reconciled with **nullspace-faithful snap-or-blend**: each frame it
 * dead-reckons by the remote's velocity (so it tracks the same projection as
 * `target`), and on each freshly arrived snapshot it reconciles against the new
 * authoritative present — a large prediction error (`> NET.smooth.snapPx`, a
 * warp/respawn/hard maneuver) **snaps**, while a small residual is **blended** in
 * linearly over `NET.smooth.blendTimeMs`. Because corrections happen only at snapshot
 * boundaries (not as a per-frame spring), the drawn ship stays *at* its dead-reckoned
 * truth with no steady-state lag — so it equals the origin its bullets fire from
 * (a springed pose lagged its own shots, detaching them ahead of the nose). Facing is
 * NOT smoothed — it's taken straight from the target so the drawn nose tracks the
 * heading bullets are fired on. The dead-reckoned `target` itself is still what
 * projectiles and hit adjudication use, so aim stays true. The clamp + freeze on
 * starvation is the only other fallback (M2.5).
 *
 * The timeline is built from **client receive-time** (`performance.now()`), not
 * the server tick, so no clock-sync is needed.
 *
 * `buildView` bakes the interpolated pose into a *view* `World` whose `prev*`
 * fields equal `current`, so the existing renderer (which lerps `prev*→current`
 * by `alpha`) draws exactly the baked pose regardless of the `alpha` it's passed.
 * The renderer stays completely untouched.
 *
 * What this step deliberately does NOT do:
 *   - the **local player** is pinned to the latest snapshot, not interpolated;
 *     main.ts overlays the authoritative `LocalSim` pose (relay model).
 *
 * Projectiles are **not** handled here at all: the local player's own shots come
 * from its `LocalSim` (present), and *every other* player's shots are simulated
 * deterministically by the `RemoteProjectileSimulator` instead of being lerped —
 * so a bullet that bounces off a wall between two snapshots traces the real bounce
 * path rather than teleporting through the corner. Both sources are stitched into
 * `view.projectiles` by main.ts after `buildView`.
 */

import { NET, TICK_DT } from "../config";
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

/** The signed shortest delta from angle `a` to `b`, wrapped to (−π, π], so motion
 *  across the 0/2π seam takes the small arc instead of spinning the long way. */
function shortAngle(a: number, b: number): number {
  const twoPi = Math.PI * 2;
  let d = (b - a) % twoPi;
  if (d > Math.PI) d -= twoPi;
  if (d < -Math.PI) d += twoPi;
  return d;
}

/** Interpolate an angle the short way around the circle. */
function lerpAngle(a: number, b: number, t: number): number {
  return a + shortAngle(a, b) * t;
}

/** The drawn render state of a remote ship, carried between frames. Each frame the
 *  position dead-reckons by the remote's velocity; on a freshly arrived snapshot the
 *  prediction error is either snapped or bled in over `blendTimeMs` as a constant
 *  `corrV*` correction velocity (nullspace's `lerp_velocity` / `lerp_time`). */
interface SmoothedState {
  x: number;
  y: number;
  /** Residual correction velocity (px/tick), applied for `corrTicksLeft` more ticks. */
  corrVx: number;
  corrVy: number;
  /** Ticks of correction remaining (nullspace `lerp_time`, counted in sim ticks). */
  corrTicksLeft: number;
  /** Snapshot tick last reconciled against — detects a freshly arrived snapshot so we
   *  correct once per snapshot (at the boundary) rather than every render frame. */
  lastTick: number;
}

export class SnapshotInterpolator {
  private buffer: BufferedSnapshot[] = [];
  /** `receivedAt` of the newest snapshot whose events have already been released.
   *  Events fire once, in interpolated time, when render time passes them. */
  private lastEventTime = -Infinity;
  /** Per-remote drawn render state (snap-or-blend). Pruned to the players present in
   *  the newest snapshot each frame so a left/rejoined player can't resurrect a stale
   *  pose. */
  private smoothed = new Map<PlayerId, SmoothedState>();

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
   * Populate `view` with the world dead-reckoned forward to render time `nowMs +
   * leadMs` — the remote's **true present** (Subspace dead-reckons remotes to now;
   * it does not render them in the past). Because render time is always ≥ the
   * newest snapshot, each remote is extrapolated forward from that newest pose
   * along its last velocity (the `pickStraddlingPair` "caught up to newest" path),
   * clamped to `extrapolateMaxMs` then frozen. The lerp-between-pairs path only
   * runs if `leadMs` is ever negative (it isn't). The local player is pinned to the
   * newest snapshot (main.ts overlays the authoritative LocalSim pose). Projectiles
   * are left empty here — main.ts fills them from LocalSim (own shots) +
   * RemoteProjectileSimulator (remote shots). Released events are written to
   * `view.events`.
   *
   * Forward extrapolation can't "streak" (it projects one pose, it doesn't lerp
   * between two distant ones), so a warp/respawn just pops to the new pose — the
   * `respawnAt`/missing-older guard in `interpolatePlayer` keeps even that clean.
   */
  buildView(
    view: World,
    nowMs: number,
    leadMs: number,
    localPlayerId: PlayerId,
    extrapolateMaxMs = 0,
    dtMs = 0,
  ): void {
    if (this.buffer.length === 0) return;

    const newest = this.buffer[this.buffer.length - 1];
    const renderTime = nowMs + leadMs;

    // Pick the straddling snapshot pair a (older) .. b (newer). Shared with the
    // remote-projectile simulator (M2.8) so ships and bullets agree on the window.
    const { a, b, t, extrapMs } = pickStraddlingPair(this.buffer, renderTime, extrapolateMaxMs)!;

    view.tick = newest.snap.tick;

    // Convert the dead-reckoning window into sim ticks (velocities are px/tick).
    const extrapTicks = extrapMs / (1000 * TICK_DT);
    const dtTicks = dtMs / (1000 * TICK_DT);

    // --- players -------------------------------------------------------------
    const olderPlayers = new Map(a.snap.players.map((p) => [p.id, p]));
    view.players.clear();
    const seen = new Set<PlayerId>();
    for (const bp of b.snap.players) {
      if (bp.id === localPlayerId) continue; // local handled below, from newest
      seen.add(bp.id);
      // Dead-reckoned present pose (the basis for projectiles + adjudication). `target`
      // is derived from the `b` snapshot, so its tick is the boundary we reconcile at.
      const target = interpolatePlayer(olderPlayers.get(bp.id), bp, t, extrapTicks);
      view.players.set(bp.id, this.smoothPlayer(target, bp, dtTicks, b.snap.tick));
    }
    // The local player is NOT interpolated — pin it to the latest snapshot;
    // main.ts then overlays the authoritative `LocalSim` pose (relay model).
    const localNewest = newest.snap.players.find((p) => p.id === localPlayerId);
    if (localNewest) view.players.set(localNewest.id, pinPlayer(localNewest));

    // Forget eased poses for remotes no longer present, so a rejoin starts fresh.
    for (const id of this.smoothed.keys()) if (!seen.has(id)) this.smoothed.delete(id);

    // --- projectiles ---------------------------------------------------------
    // Intentionally empty (M2.8). Projectiles are no longer interpolated here:
    // main.ts fills `view.projectiles` from LocalSim (own shots) and
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

  /** Reconcile the drawn pose of a remote with its dead-reckoned `target`
   *  (nullspace-faithful snap-or-blend). Each frame the drawn position dead-reckons by
   *  the remote's velocity — the same projection `target` advances by — plus any
   *  active residual correction. On a *freshly arrived* snapshot (`snapTick` changed)
   *  it reconciles against the new present: a large prediction error snaps to truth, a
   *  small one is bled in linearly over `blendTimeMs`. A new/respawning remote snaps,
   *  keeping joins/respawns crisp. Facing is taken straight from the target (never
   *  smoothed) so the drawn nose matches the heading bullets fire on. `newest` is the
   *  raw snapshot player (velocity + respawn state); `target` is its present pose.
   *  Mutates `this.smoothed` and returns a fresh view player. */
  private smoothPlayer(target: Player, newest: Player, dtTicks: number, snapTick: number): Player {
    const tk = target.kinematics;
    const nk = newest.kinematics;
    let st = this.smoothed.get(newest.id);

    // New remote, or dead/respawning (its old drawn pose is the death site): snap to
    // the dead-reckoned truth and start fresh.
    if (!st || newest.combat.respawnAt !== 0) {
      st = { x: tk.x, y: tk.y, corrVx: 0, corrVy: 0, corrTicksLeft: 0, lastTick: snapTick };
      this.smoothed.set(newest.id, st);
      return { ...target, kinematics: bakedKinematics(tk, st.x, st.y, tk.rotation) };
    }

    // (1) Dead-reckon the drawn pose by the remote's velocity (matching how `target`
    //     advances frame to frame), then apply any residual correction still in flight.
    st.x += nk.vx * dtTicks;
    st.y += nk.vy * dtTicks;
    if (st.corrTicksLeft > 0) {
      const used = Math.min(dtTicks, st.corrTicksLeft);
      st.x += st.corrVx * used;
      st.y += st.corrVy * used;
      st.corrTicksLeft -= used;
    }

    // (2) On a freshly arrived snapshot, reconcile against the new authoritative
    //     present: snap a large prediction error (a warp/respawn/hard maneuver), else
    //     bleed the small residual in over `blendTimeMs` as a constant correction
    //     velocity. Between snapshots the pose just coasts (step 1) — no per-frame
    //     spring, so it stays at truth with no steady-state lag.
    if (snapTick !== st.lastTick) {
      st.lastTick = snapTick;
      const errX = tk.x - st.x;
      const errY = tk.y - st.y;
      if (errX * errX + errY * errY > NET.smooth.snapPx ** 2) {
        st.x = tk.x;
        st.y = tk.y;
        st.corrVx = 0;
        st.corrVy = 0;
        st.corrTicksLeft = 0;
      } else {
        const corrTicks = NET.smooth.blendTimeMs / (1000 * TICK_DT);
        st.corrVx = errX / corrTicks;
        st.corrVy = errY / corrTicks;
        st.corrTicksLeft = corrTicks;
      }
    }

    return { ...target, kinematics: bakedKinematics(tk, st.x, st.y, tk.rotation) };
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
