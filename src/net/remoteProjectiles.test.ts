/**
 * Remote-projectile simulation audit — M2.8.
 *
 * M2.8 stops *interpolating* other players' bullets and instead simulates them
 * forward deterministically from the latest snapshot (the same determinism the
 * local ship (M2.4) and own shots (M2.6) rely on, turned outward). These tests
 * guard the two properties that buys us:
 *
 *   1. A remote bullet simulated locally through a **wall bounce** reproduces the
 *      server's path bit-for-bit — this is what removes the bounce "teleport".
 *   2. A bullet the **server killed** between snapshots (e.g. a ship hit our
 *      map-only sim can't see) **retracts** via the newer-snapshot cross-check
 *      instead of flying on as a ghost.
 *
 * Mirrors `net/determinism.test.ts`: the simulator is held to the *same*
 * `projectileSystem` the server runs, so equality is exact, not approximate.
 */

import { describe, expect, it } from "vitest";
import { TICK_DT } from "../config";
import { GameMap } from "../sim/gamemap";
import { projectileSystem } from "../sim/systems/projectiles";
import type { Projectile } from "../sim/types";
import { World } from "../sim/world";
import { RemoteProjectileSimulator } from "./remoteProjectiles";
import type { Snapshot } from "./snapshot";

const LOCAL = "me";
const REMOTE = "enemy";

/** A 64×64-tile open map with a solid vertical wall one tile wide at tile x=20
 *  (world x 320..336), so a bullet flying +x into it bounces back. */
function wallMap(): GameMap {
  const w = 64;
  const tiles = new Uint8Array(w * w);
  for (let ty = 0; ty < w; ty++) tiles[ty * w + 20] = 1;
  return new GameMap(w, w, tiles);
}

function bullet(partial: Partial<Projectile> & { id: number }): Projectile {
  return {
    kind: "bullet",
    owner: REMOTE,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    life: 200,
    bounces: 5,
    radius: 1,
    alive: true,
    prevX: 0,
    prevY: 0,
    ...partial,
  };
}

/** Minimal snapshot carrying just the projectiles under test. */
function snapshot(tick: number, projectiles: Projectile[]): Snapshot {
  return {
    tick,
    players: [],
    projectiles,
    events: [],
    lastProcessedInputSeq: 0,
    inputBufferDepth: 0,
    pings: {},
  };
}

/** Step a copy of `proj` forward `ticks` whole ticks through the real sim, the
 *  server's ground truth. */
function groundTruth(map: GameMap, proj: Projectile, ticks: number): Projectile {
  const w = new World(map, 1, false);
  w.projectiles = [structuredClone(proj)];
  for (let i = 0; i < ticks; i++) projectileSystem(w);
  return w.projectiles[0];
}

describe("remote-projectile simulation (M2.8)", () => {
  it("reproduces a wall-bounce path bit-for-bit, no teleport", () => {
    const map = wallMap();
    // Heading +x straight at the wall at x=320, fast enough to reach and bounce.
    const base = bullet({ id: 1, x: 100, y: 100, vx: 5, vy: 0 });

    const K = 60; // far enough that it has hit the wall and is travelling back
    const sim = new RemoteProjectileSimulator(map);

    // Buffer: base at t0, plus a far-future snapshot so render time straddles the
    // pair (a = base) and the bullet is still listed (so it's not retracted).
    const t0 = 1000;
    const leadMs = 75;
    const buffer = [
      { snap: snapshot(0, [base]), receivedAt: t0 },
      { snap: snapshot(999, [bullet({ id: 1 })]), receivedAt: t0 + 10_000 },
    ];
    // Render time = t0 + K ticks → simulate steps exactly K whole ticks (frac 0).
    // Forward model: renderTime = now + lead, so back the clock out by the lead.
    const renderTime = t0 + K * (1000 * TICK_DT);
    const nowMs = renderTime - leadMs;

    const out = sim.simulate(buffer, nowMs, leadMs, LOCAL, 100);
    const truth = groundTruth(map, base, K);

    expect(out).toHaveLength(1);
    const got = out[0];
    // The bounce actually happened (velocity reversed) — the path we'd otherwise
    // have lerped straight through.
    expect(truth.vx).toBeLessThan(0);
    expect(got.vx).toBeLessThan(0);
    // …and the simulated pose equals the server's, exactly.
    expect(got.x).toBe(truth.x);
    expect(got.y).toBe(truth.y);
    expect(got.vx).toBe(truth.vx);
    expect(got.vy).toBe(truth.vy);
    expect(got.bounces).toBe(truth.bounces);
    expect(got.life).toBe(truth.life);
  });

  it("retracts a server-killed bullet via the newer-snapshot cross-check", () => {
    const map = wallMap();
    // Two bullets flying in open space (no wall in their path), both alive in the
    // base snapshot. The newer snapshot has lost #2 — the server killed it (a
    // ship hit our map-only sim can't reproduce). It must not keep flying.
    const a1 = bullet({ id: 1, x: 50, y: 50, vx: 0, vy: 2 });
    const a2 = bullet({ id: 2, x: 60, y: 50, vx: 0, vy: 2 });

    const sim = new RemoteProjectileSimulator(map);
    const t0 = 1000;
    const leadMs = 75;
    const buffer = [
      { snap: snapshot(0, [a1, a2]), receivedAt: t0 },
      // newer straddling snapshot: only #1 survives
      { snap: snapshot(20, [bullet({ id: 1 })]), receivedAt: t0 + 10_000 },
    ];
    const renderTime = t0 + 10 * (1000 * TICK_DT);
    const nowMs = renderTime - leadMs;

    const out = sim.simulate(buffer, nowMs, leadMs, LOCAL, 100);

    expect(out.map((p) => p.id)).toEqual([1]);
    // #1 reconciles to its simulated-forward pose without a pop (continuous path).
    const truth = groundTruth(map, a1, 10);
    expect(out[0].x).toBe(truth.x);
    expect(out[0].y).toBe(truth.y);
  });

  it("excludes the local player's own shots (those come from the Predictor)", () => {
    const map = wallMap();
    const mine = bullet({ id: 7, owner: LOCAL, x: 50, y: 50, vx: 1, vy: 0 });
    const theirs = bullet({ id: 8, owner: REMOTE, x: 80, y: 50, vx: 1, vy: 0 });

    const sim = new RemoteProjectileSimulator(map);
    const t0 = 1000;
    const buffer = [
      { snap: snapshot(0, [mine, theirs]), receivedAt: t0 },
      { snap: snapshot(50, [bullet({ id: 7, owner: LOCAL }), bullet({ id: 8 })]), receivedAt: t0 + 10_000 },
    ];
    const out = sim.simulate(buffer, t0 + 100, 75, LOCAL, 100);
    expect(out.map((p) => p.id)).toEqual([8]);
  });
});
