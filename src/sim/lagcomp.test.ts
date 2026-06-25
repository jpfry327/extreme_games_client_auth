/**
 * Server-side lag compensation — M2.9.
 *
 * "What you see is what you hit": the collision system adjudicates a projectile
 * carrying `compTicks > 0` against where each target *was* `compTicks` ago (the
 * firer's delayed view), looked up from `world.history`, instead of the present.
 * These tests prove the three load-bearing pieces in the sim spirit (pure, no
 * network): the history ring is correctly bounded, the firing system stamps the
 * right `compTicks`, and a shot at a target's rendered (stale) position **hits
 * with compensation on and misses with it off**.
 */

import { describe, expect, it } from "vitest";
import { LAGCOMP, WARBIRD } from "../config";
import { GameMap } from "./gamemap";
import { TickHistory } from "./history";
import { createPlayer } from "./player";
import { collisionSystem } from "./systems/collision";
import { damageSystem } from "./systems/damage";
import type { InputCommand, Projectile } from "./types";
import { World } from "./world";

function openMap(tiles = 128): GameMap {
  return new GameMap(tiles, tiles, new Uint8Array(tiles * tiles));
}

const NO_INPUT: InputCommand = {
  rotateLeft: false,
  rotateRight: false,
  thrust: false,
  reverse: false,
  afterburner: false,
  fire: false,
  bomb: false,
};

function bullet(x: number, y: number, owner: string, compTicks?: number): Projectile {
  return {
    id: 1,
    kind: "bullet",
    owner,
    x,
    y,
    vx: 0,
    vy: 0,
    life: 65,
    bounces: 0,
    radius: 2,
    alive: true,
    prevX: x,
    prevY: y,
    compTicks,
  };
}

// --- 1. TickHistory is bounded and never reads a wrong (wrapped) sample -------

describe("TickHistory", () => {
  it("returns recorded poses in range, null out of range, and never a stale wrap", () => {
    const ring = new TickHistory(8);
    const p = createPlayer("t", "t", 0, WARBIRD, 100, 100);
    const players = new Map([[p.id, p]]);

    // Record ticks 0..10 into a size-8 ring; each tick the player is 1px further.
    for (let tick = 0; tick <= 10; tick++) {
      p.kinematics.x = 100 + tick;
      ring.record(tick, players);
    }

    // In range: the freshest 8 ticks (3..10) survive, with their exact pose.
    expect(ring.lookup(10, "t")?.x).toBe(110);
    expect(ring.lookup(3, "t")?.x).toBe(103);
    // Evicted: ticks 0..2 were overwritten by ticks 8..10 (same ring slots).
    expect(ring.lookup(0, "t")).toBeNull();
    expect(ring.lookup(2, "t")).toBeNull();
    // Never recorded (future / negative): no wrapped sample is ever returned.
    expect(ring.lookup(100, "t")).toBeNull();
    expect(ring.lookup(-5, "t")).toBeNull();
    // Unknown player at a recorded tick.
    expect(ring.lookup(10, "ghost")).toBeNull();
  });

  it("records aliveness so a dead-then target can't be hit by a rewind", () => {
    const ring = new TickHistory(8);
    const p = createPlayer("t", "t", 0, WARBIRD, 100, 100);
    p.combat.respawnAt = 999; // dead this tick
    ring.record(5, new Map([[p.id, p]]));
    expect(ring.lookup(5, "t")?.alive).toBe(false);
  });
});

// --- 2. firingSystem stamps compTicks = spawnTick − renderTick (clamped) ------

describe("firing stamps lag-compensation onto shots", () => {
  /** Step a one-shooter world `idle` ticks, then one tick firing with `renderTick`,
   *  and return the projectile it spawned. */
  function fireWith(idle: number, renderTick: number | undefined): Projectile {
    const world = new World(openMap(), 1, false);
    world.addPlayer("s", "s", 0, WARBIRD);
    for (let i = 0; i < idle; i++) world.step({ inputs: new Map([["s", NO_INPUT]]) });
    world.step({ inputs: new Map([["s", { ...NO_INPUT, fire: true, renderTick }]]) });
    expect(world.projectiles).toHaveLength(1);
    return world.projectiles[0];
  }

  it("stamps the gap between the spawn tick and the firer's render tick", () => {
    // 20 idle ticks → spawn at tick 21; renderTick 12 → 9 ticks of rewind.
    expect(fireWith(20, 12).compTicks).toBe(9);
  });

  it("leaves compTicks unset when the input reports no render tick (e.g. the bot)", () => {
    expect(fireWith(20, undefined).compTicks).toBeUndefined();
  });

  it("clamps the rewind to the configured maximum", () => {
    // Spawn far enough past the maximum that the raw gap (spawnTick − renderTick)
    // exceeds the cap, then assert it clamps to LAGCOMP.maxCompTicks (read from
    // config so tuning the cap doesn't break this test).
    const idle = LAGCOMP.maxCompTicks + 20;
    expect(fireWith(idle, 0).compTicks).toBe(LAGCOMP.maxCompTicks);
  });
});

// --- 3. a shot at the rendered (stale) position hits with comp, misses without -

describe("lag-compensated collision", () => {
  it("hits the target's rewound pose and misses its present pose", () => {
    const world = new World(openMap(), 1, false);
    const target = world.addPlayer("t", "t", 0, WARBIRD);
    // Park the target moving laterally at 2px/tick (under the speed cap, so drag
    // leaves it exactly 2px/tick on the frictionless map).
    target.kinematics.x = 1000;
    target.kinematics.y = 1000;
    target.kinematics.vx = 2;

    // Build 12 ticks of history: at tick t the target sits at x = 1000 + 2t.
    for (let i = 0; i < 12; i++) world.step({ inputs: new Map([["t", NO_INPUT]]) });
    expect(world.tick).toBe(12);
    expect(world.players.get("t")!.kinematics.x).toBe(1024); // present pose

    // The target was at x = 1004 at tick 2 (10 ticks ago). A shot fired by someone
    // viewing it there (compTicks = 10) sits at (1004, 1000) — 20px from where the
    // ship *now* is, well outside the 16px hit reach.
    const ghostX = 1004;

    // With compensation: tests against history[tick − 10] = the ghost → HIT.
    world.projectiles = [bullet(ghostX, 1000, "s", 10)];
    collisionSystem(world);
    expect(world.contacts).toHaveLength(1);
    expect(world.contacts[0].rewound).toBe(true);

    // Without compensation: tests against the present pose (x = 1024) → MISS.
    world.projectiles = [bullet(ghostX, 1000, "s")];
    collisionSystem(world);
    expect(world.contacts).toHaveLength(0);
  });

  it("won't hit a target that wasn't alive in the firer's view", () => {
    const world = new World(openMap(), 1, false);
    const target = world.addPlayer("t", "t", 0, WARBIRD);
    target.kinematics.x = 1000;
    target.kinematics.y = 1000;

    // Record a few ticks while the target is dead (a ghost), then revive it.
    target.combat.respawnAt = 9999;
    for (let i = 0; i < 5; i++) world.step({ inputs: new Map([["t", NO_INPUT]]) });
    target.combat.respawnAt = 0; // alive now, sitting on the same spot

    // A shot rewound onto the (dead-then) ghost overlaps in space but must not hit:
    // the target wasn't a valid target in that view.
    world.projectiles = [bullet(1000, 1000, "s", 3)];
    collisionSystem(world);
    expect(world.contacts).toHaveLength(0);
  });
});

// --- 4. bomb SPLASH is lag-compensated (the main "eaten bomb" fix) ------------

describe("lag-compensated bomb splash", () => {
  /** A dead bomb (corpse) ready for the damage system to detonate. */
  function deadBomb(x: number, y: number, owner: string, compTicks?: number): Projectile {
    return { ...bullet(x, y, owner, compTicks), kind: "bomb", alive: false, radius: 4 };
  }

  /** Build a world with a target strafing at 3px/tick and `ticks` of history, so
   *  at tick t it sat at x = 1000 + 3t. */
  function strafingTarget(ticks: number): World {
    const world = new World(openMap(), 1, false);
    const target = world.addPlayer("t", "t", 0, WARBIRD);
    target.kinematics.x = 1000;
    target.kinematics.y = 1000;
    target.kinematics.vx = 3; // under the 3.2px/tick cap, so it persists exactly
    for (let i = 0; i < ticks; i++) world.step({ inputs: new Map([["t", NO_INPUT]]) });
    return world;
  }

  it("blasts the target's rewound pose so a moving ship can't eat the bomb", () => {
    // 20 ticks → present x = 1060. The target was at x = 1015 at tick 5 (15 ticks
    // ago). A bomb that detonates there is 45px from the present ship — outside the
    // 18px blast + 14px hull = 32px reach — so a present-based blast does nothing.
    const ghostX = 1015;

    // With compensation: the blast is measured against the ghost → full damage.
    const withComp = strafingTarget(20);
    withComp.projectiles = [deadBomb(ghostX, 1000, "s", 15)];
    damageSystem(withComp);
    const hit = withComp.players.get("t")!;
    expect(hit.resources.energy).toBeLessThan(0); // took the full bomb (5600)
    expect(withComp.events.some((e) => e.type === "shipHit" && e.rewound)).toBe(true);

    // Without compensation: the same blast measures the present pose → no damage.
    const noComp = strafingTarget(20);
    noComp.projectiles = [deadBomb(ghostX, 1000, "s")];
    damageSystem(noComp);
    expect(noComp.players.get("t")!.resources.energy).toBe(1650); // untouched
  });
});
