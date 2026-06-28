import { describe, expect, it } from "vitest";
import { WARBIRD } from "../config";
import { GameMap } from "../sim/gamemap";
import { createPlayer } from "../sim/player";
import type { GameEvent, Player, Projectile } from "../sim/types";
import { World } from "../sim/world";
import { SnapshotInterpolator } from "./interpolation";
import type { Snapshot } from "./snapshot";

// --- fixtures ----------------------------------------------------------------

/** A view world: never stepped, no auto local player (the interpolator fills it). */
function viewWorld(): World {
  return new World(new GameMap(64, 64, new Uint8Array(64 * 64)), 1, false);
}

/** A player at a given pose + velocity. createPlayer sets prev*===current; we
 *  override the live pose so a snapshot can carry a distinct position/velocity. */
function playerAt(id: string, x: number, y: number, rotation = 0, vx = 0, vy = 0): Player {
  const p = createPlayer(id, id, 0, WARBIRD, x, y);
  p.kinematics.x = x;
  p.kinematics.y = y;
  p.kinematics.rotation = rotation;
  p.kinematics.vx = vx;
  p.kinematics.vy = vy;
  return p;
}

function projectileAt(id: number, x: number, y: number): Projectile {
  return {
    id,
    kind: "bullet",
    owner: "x",
    x,
    y,
    vx: 0,
    vy: 0,
    life: 50,
    bounces: 0,
    radius: 2,
    alive: true,
    prevX: x,
    prevY: y,
  };
}

function snap(
  tick: number,
  players: Player[],
  projectiles: Projectile[] = [],
  events: GameEvent[] = [],
): Snapshot {
  return { tick, players, projectiles, events, lastProcessedInputSeq: 0, inputBufferDepth: 0, pings: {} };
}

const LOCAL = "me";
// (1000 * TICK_DT = 10ms per tick, so a 100ms lead = 10 forward sim ticks.)

// --- tests -------------------------------------------------------------------

describe("SnapshotInterpolator (forward dead-reckoning)", () => {
  it("dead-reckons a remote player forward to the present by its velocity", () => {
    const interp = new SnapshotInterpolator();
    // One snapshot of a remote coasting at vx=2 px/tick from (0,0).
    interp.push(snap(1, [playerAt("r", 0, 0, 0, 2, 0)]), 1000);

    const view = viewWorld();
    // lead 100ms (=10 ticks) at now=1000, with a 200ms extrapolation budget.
    interp.buildView(view, 1000, 100, LOCAL, 200);

    const r = view.players.get("r")!;
    // Projected forward 10 ticks: 0 + 2*10 = 20.
    expect(r.kinematics.x).toBeCloseTo(20);
    expect(r.kinematics.y).toBeCloseTo(0);
    // prev*===current so the renderer's alpha-lerp is a no-op.
    expect(r.kinematics.prevX).toBe(r.kinematics.x);
    expect(r.kinematics.prevY).toBe(r.kinematics.y);
  });

  it("pins the local player to the newest snapshot (no extrapolation)", () => {
    const interp = new SnapshotInterpolator();
    interp.push(snap(1, [playerAt(LOCAL, 0, 0)]), 1000);
    interp.push(snap(2, [playerAt(LOCAL, 100, 0, 0, 5, 0)]), 1100);

    const view = viewWorld();
    // The local ship is never dead-reckoned here — main.ts overlays the
    // authoritative LocalSim pose. It takes the newest snapshot's raw position.
    interp.buildView(view, 1150, 100, LOCAL, 200);

    expect(view.players.get(LOCAL)!.kinematics.x).toBe(100);
  });

  it("clamps forward extrapolation to extrapolateMaxMs then holds", () => {
    const interp = new SnapshotInterpolator();
    interp.push(snap(1, [playerAt("r", 0, 0, 0, 2, 0)]), 1000);

    const view = viewWorld();
    // A huge lead (1000ms) but only a 100ms (=10 tick) budget: projection is
    // clamped, so x = 2*10 = 20, not 2*100.
    interp.buildView(view, 1000, 1000, LOCAL, 100);

    expect(view.players.get("r")!.kinematics.x).toBeCloseTo(20);
  });

  it("leaves projectiles for the RemoteProjectileSimulator (M2.8)", () => {
    // Own shots come from LocalSim, everyone else's from the simulator (simulated
    // deterministically so bounces don't teleport). buildView must leave
    // view.projectiles empty so those two sources start from a clean list.
    const interp = new SnapshotInterpolator();
    interp.push(snap(1, [playerAt(LOCAL, 0, 0)], [projectileAt(7, 0, 0)]), 1000);

    const view = viewWorld();
    interp.buildView(view, 1000, 100, LOCAL, 200);

    expect(view.projectiles).toHaveLength(0);
  });

  it("drops a player that left in the newest snapshot", () => {
    const interp = new SnapshotInterpolator();
    interp.push(snap(1, [playerAt(LOCAL, 0, 0), playerAt("gone", 5, 5)]), 1000);
    interp.push(snap(2, [playerAt(LOCAL, 0, 0)]), 1100);

    const view = viewWorld();
    interp.buildView(view, 1150, 100, LOCAL, 200);

    expect(view.players.has("gone")).toBe(false);
    expect(view.players.has(LOCAL)).toBe(true);
  });

  it("releases each snapshot's events exactly once", () => {
    const interp = new SnapshotInterpolator();
    const died: GameEvent = {
      type: "shipDied",
      victim: "r",
      killer: LOCAL,
      bounty: 0,
      x: 0,
      y: 0,
    };
    interp.push(snap(1, [playerAt(LOCAL, 0, 0)]), 1000);
    interp.push(snap(2, [playerAt(LOCAL, 0, 0)], [], [died]), 1100);

    const view = viewWorld();
    // render time is now + lead ≥ the snapshot's receive time, so an event fires on
    // the first frame after it arrives (present-time model — no held-in-past delay).
    interp.buildView(view, 1100, 50, LOCAL, 200);
    expect(view.events).toHaveLength(1);

    // ...and never again.
    interp.buildView(view, 1200, 50, LOCAL, 200);
    expect(view.events).toHaveLength(0);
  });

  it("holds at the newest pose with no extrapolation budget", () => {
    const interp = new SnapshotInterpolator();
    interp.push(snap(1, [playerAt("r", 0, 0, 0, 9, 0)]), 1000);
    interp.push(snap(2, [playerAt("r", 100, 0, 0, 9, 0)]), 1100);

    const view = viewWorld();
    // extrapolateMaxMs defaults to 0 → no forward projection, pinned to newest.
    expect(() => interp.buildView(view, 1600, 100, LOCAL)).not.toThrow();
    expect(view.players.get("r")!.kinematics.x).toBe(100);
  });

  it("shows a newly-joined remote player at its pose without smearing", () => {
    const interp = new SnapshotInterpolator();
    interp.push(snap(1, [playerAt(LOCAL, 0, 0)]), 1000);
    interp.push(snap(2, [playerAt(LOCAL, 0, 0), playerAt("joiner", 500, 600)]), 1100);

    const view = viewWorld();
    interp.buildView(view, 1150, 100, LOCAL, 200);
    const j = view.players.get("joiner")!;
    expect(j.kinematics.x).toBe(500);
    expect(j.kinematics.y).toBe(600);
  });

  it("pins a respawned player to its spawn, not dead-reckoning a stale velocity", () => {
    const interp = new SnapshotInterpolator();
    // Newest snapshot: alive at a fresh spawn, but still carrying a stale velocity
    // from before death. The respawn guard must pin it, not project it.
    const spawned = playerAt("r", 900, 900, 0, 5, 5);
    spawned.combat.respawnAt = 0;
    interp.push(snap(1, [playerAt(LOCAL, 0, 0)]), 1000);
    interp.push(snap(2, [playerAt(LOCAL, 0, 0), spawned]), 1100);

    const view = viewWorld();
    interp.buildView(view, 1150, 100, LOCAL, 200);
    const r = view.players.get("r")!;
    // A respawned ship is alive in the newest snapshot, so it IS projected; this
    // just asserts it appears at its reported pose region (no smear from a death
    // site, which the old lerp model risked).
    expect(r.kinematics.x).toBeGreaterThanOrEqual(900);
    expect(r.kinematics.y).toBeGreaterThanOrEqual(900);
  });

  it("never mutates buffered snapshot data", () => {
    const interp = new SnapshotInterpolator();
    const newer = playerAt("r", 100, 200, 0, 3, 0);
    interp.push(snap(1, [playerAt("r", 0, 0, 0, 3, 0)]), 1000);
    interp.push(snap(2, [newer]), 1100);

    const view = viewWorld();
    interp.buildView(view, 1150, 100, LOCAL, 200);

    // The view gets a fresh copy; the buffered snapshot's base pose stays untouched,
    // or the next frame's projection would read a corrupted position.
    expect(newer.kinematics.x).toBe(100);
    expect(view.players.get("r")!.kinematics).not.toBe(newer.kinematics);
  });

  // --- error smoothing (projective velocity blending) ------------------------

  it("tracks a constant-velocity remote with no trailing lag", () => {
    // A remote coasting at vx=2 px/tick (0.2 px/ms). Snapshots arrive every 20ms
    // (50Hz) carrying its true position; we render each as it arrives with a fixed
    // 40ms lead. Perfect prediction → the spring has zero error to bleed, so the
    // eased visual must sit exactly on the dead-reckoned present (40ms = 4 ticks
    // ahead = +8px), NOT lag behind it the way a naive smoother would.
    const interp = new SnapshotInterpolator();
    const vx = 2;
    const dtMs = 20;
    const lead = 40;
    let last = 0;
    for (let k = 0; k <= 20; k++) {
      const tNow = 1000 + 20 * k;
      interp.push(snap(k + 1, [playerAt("r", 4 * k, 0, 0, vx, 0)]), tNow);
      const view = viewWorld();
      interp.buildView(view, tNow, lead, LOCAL, 200, dtMs);
      last = view.players.get("r")!.kinematics.x;
    }
    // present = 4*20 (=80) + vx * (lead/10ms = 4 ticks) (=8) = 88.
    expect(last).toBeCloseTo(88, 1);
  });

  it("glides through a velocity reversal instead of snapping", () => {
    // The ship coasts at +2, then reverses to −2 at the same position. With a 100ms
    // lead the dead-reckon target flips from +20px ahead to −20px ahead — a 40px
    // discontinuity a raw model would snap in one frame. The smoother must spread it
    // over several frames: the largest single-frame step stays a small fraction of
    // that jump (and well under the snap threshold), proving no hard snap.
    const dtMs = 16;
    const lead = 100;
    const reverseAt = 10;
    const frames = 20;

    function run(smoothed: boolean): number {
      const interp = new SnapshotInterpolator();
      let maxStep = 0;
      let prevX: number | null = null;
      // True position integrates the velocity (consistent motion); only the velocity
      // reverses, so the *position* stays continuous and just the lead projection flips.
      let pos = 500;
      for (let k = 0; k < frames; k++) {
        const tNow = 1000 + 16 * k;
        const vx = k < reverseAt ? 2 : -2;
        interp.push(snap(k + 1, [playerAt("r", pos, 0, 0, vx, 0)]), tNow);
        const view = viewWorld();
        interp.buildView(view, tNow, lead, LOCAL, 200, smoothed ? dtMs : 0);
        const x = view.players.get("r")!.kinematics.x;
        if (prevX !== null && k >= reverseAt) maxStep = Math.max(maxStep, Math.abs(x - prevX));
        prevX = x;
        pos += vx * (dtMs / 10); // advance by vx px/tick over dtMs (=dtMs/10 ticks)
      }
      return maxStep;
    }

    const rawJump = run(false); // dtMs=0 → snap each frame, full discontinuity
    const smoothStep = run(true);
    expect(rawJump).toBeGreaterThan(30); // the raw model really does snap ~40px
    expect(smoothStep).toBeLessThan(rawJump / 2); // smoothing spreads it out
    expect(smoothStep).toBeLessThan(64); // and never trips the snap threshold
  });
});
