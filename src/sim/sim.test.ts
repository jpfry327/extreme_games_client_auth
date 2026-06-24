import { describe, expect, it } from "vitest";
import { COMBAT, shipConfig, WARBIRD } from "../config";
import { GameMap } from "./gamemap";
import { isAlive } from "./player";
import { SeededRng } from "./rng";
import type { InputCommand, Player, Projectile, StepContext } from "./types";
import { World } from "./world";

// --- Test fixtures -----------------------------------------------------------

/** A small, completely open map. The spawn lands at its center; out-of-bounds
 *  counts as solid, so projectiles bounce/expire against the edges. */
function openMap(tiles = 64): GameMap {
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

function input(partial: Partial<InputCommand>): InputCommand {
  return { ...NO_INPUT, ...partial };
}

/** Address an input to the world's local player for one tick. */
function ctx(world: World, cmd: InputCommand): StepContext {
  return { inputs: new Map([[world.localPlayerId, cmd]]) };
}

// --- Seeded RNG --------------------------------------------------------------

describe("SeededRng", () => {
  it("is deterministic: same seed yields the same sequence", () => {
    const a = new SeededRng(42);
    const b = new SeededRng(42);
    const seqA = Array.from({ length: 5 }, () => a.next());
    const seqB = Array.from({ length: 5 }, () => b.next());
    expect(seqA).toEqual(seqB);
  });

  it("differs across seeds and stays within [0, 1)", () => {
    const a = new SeededRng(1);
    const b = new SeededRng(2);
    expect(a.next()).not.toBe(b.next());
    for (const v of Array.from({ length: 100 }, () => new SeededRng(7).range(0, 1))) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

// --- Movement system ---------------------------------------------------------

describe("movementSystem", () => {
  it("thrust accelerates the ship along its heading (up = -y)", () => {
    const world = new World(openMap());
    const { x: startX, y: startY } = world.localPlayer.kinematics;

    world.step(ctx(world, input({ thrust: true })));

    const k = world.localPlayer.kinematics;
    expect(k.vy).toBeLessThan(0); // facing up at rotation 0
    expect(k.y).toBeLessThan(startY);
    expect(k.x).toBeCloseTo(startX); // no sideways drift
  });

  it("records the previous pose for interpolation", () => {
    const world = new World(openMap());
    const before = { ...world.localPlayer.kinematics };
    world.step(ctx(world, input({ thrust: true })));
    const k = world.localPlayer.kinematics;
    expect(k.prevX).toBe(before.x);
    expect(k.prevY).toBe(before.y);
  });
});

// --- Firing system -----------------------------------------------------------

describe("firingSystem", () => {
  it("spawns one owner-tagged bullet and debits its energy", () => {
    const world = new World(openMap());
    const warbird = shipConfig(WARBIRD);
    const fullEnergy = world.localPlayer.resources.energy;

    world.step(ctx(world, input({ fire: true })));

    expect(world.projectiles).toHaveLength(1);
    const bullet = world.projectiles[0];
    expect(bullet.kind).toBe("bullet");
    expect(bullet.owner).toBe(world.localPlayerId);
    expect(world.localPlayer.resources.energy).toBe(fullEnergy - warbird.bullet.fireEnergy);
  });

  it("respects the gun cooldown (no double-fire on the next tick)", () => {
    const world = new World(openMap());
    world.step(ctx(world, input({ fire: true })));
    world.step(ctx(world, input({ fire: true }))); // cooldown still active
    expect(world.projectiles).toHaveLength(1);
  });

  it("won't fire without enough energy", () => {
    const world = new World(openMap());
    world.localPlayer.resources.energy = 0;
    world.step(ctx(world, input({ fire: true })));
    expect(world.projectiles).toHaveLength(0);
  });
});

// --- Projectile system -------------------------------------------------------

describe("projectileSystem", () => {
  it("detonates a bomb, emitting a bombExploded event", () => {
    const world = new World(openMap());
    world.step(ctx(world, input({ bomb: true })));
    expect(world.projectiles).toHaveLength(1);

    // Fly it until it dies (hits the map edge or ages out).
    for (let i = 0; i < shipConfig(WARBIRD).bomb.lifetimeTicks + 5; i++) {
      world.step(ctx(world, NO_INPUT));
      if (world.events.some((e) => e.type === "bombExploded")) break;
    }
    expect(world.events.some((e) => e.type === "bombExploded")).toBe(true);
    expect(world.projectiles).toHaveLength(0); // dead projectile compacted out
  });
});

// --- Combat: collision -> damage -> death -> respawn (M1) --------------------

/** Idle context — every player coasts. Systems read inputs per id; an empty
 *  map means nobody is pressing anything. */
const IDLE_CTX: StepContext = { inputs: new Map() };

/** Add a second player (the bot's role) and place it at an exact spot, so a
 *  hand-placed projectile can be aimed deterministically. */
function placeEnemy(world: World, id: string, x: number, y: number): Player {
  const p = world.addPlayer(id, id, 1, WARBIRD);
  p.kinematics.x = p.kinematics.prevX = x;
  p.kinematics.y = p.kinematics.prevY = y;
  return p;
}

/** A stationary projectile sitting on (x, y), owned by `owner`. Dropping one of
 *  these into world.projectiles lets a test trigger a hit without flying a real
 *  shot into the target. */
function projectileAt(
  kind: Projectile["kind"],
  owner: string,
  x: number,
  y: number,
): Projectile {
  const w = kind === "bullet" ? shipConfig(WARBIRD).bullet : shipConfig(WARBIRD).bomb;
  return {
    id: 0,
    kind,
    owner,
    x,
    y,
    vx: 0,
    vy: 0,
    life: w.lifetimeTicks,
    bounces: w.bounces,
    radius: w.radius,
    alive: true,
    prevX: x,
    prevY: y,
  };
}

describe("collision + damage", () => {
  it("a bullet hits an enemy, debits its energy, and emits shipHit", () => {
    const world = new World(openMap());
    const me = world.localPlayer;
    const enemy = placeEnemy(world, "enemy", me.kinematics.x + 100, me.kinematics.y);
    const before = enemy.resources.energy;

    world.projectiles.push(projectileAt("bullet", me.id, enemy.kinematics.x, enemy.kinematics.y));
    world.step(IDLE_CTX);

    expect(enemy.resources.energy).toBe(before - shipConfig(WARBIRD).bullet.damage);
    expect(enemy.combat.lastHitBy).toBe(me.id);
    expect(world.events.some((e) => e.type === "shipHit" && e.target === "enemy")).toBe(true);
    expect(world.projectiles).toHaveLength(0); // bullet spent
  });

  it("never hits the player who fired it (owner immunity)", () => {
    const world = new World(openMap());
    const me = world.localPlayer;
    const before = me.resources.energy;

    world.projectiles.push(projectileAt("bullet", me.id, me.kinematics.x, me.kinematics.y));
    world.step(IDLE_CTX);

    expect(me.resources.energy).toBe(before); // unharmed by its own shot
    expect(world.projectiles).toHaveLength(1); // and the shot flies on
  });

  it("a bomb deals area damage where it detonates", () => {
    const world = new World(openMap());
    const me = world.localPlayer;
    const enemy = placeEnemy(world, "enemy", me.kinematics.x + 200, me.kinematics.y);
    const before = enemy.resources.energy;

    world.projectiles.push(projectileAt("bomb", me.id, enemy.kinematics.x, enemy.kinematics.y));
    world.step(IDLE_CTX);

    expect(enemy.resources.energy).toBeLessThan(before);
    expect(world.events.some((e) => e.type === "bombExploded")).toBe(true);
  });
});

describe("death + respawn", () => {
  it("a fatal hit kills the target and credits the killer", () => {
    const world = new World(openMap());
    const me = world.localPlayer;
    const enemy = placeEnemy(world, "enemy", me.kinematics.x + 100, me.kinematics.y);
    enemy.resources.energy = 50; // one bullet (210) is lethal

    world.projectiles.push(projectileAt("bullet", me.id, enemy.kinematics.x, enemy.kinematics.y));
    world.step(IDLE_CTX);

    expect(isAlive(enemy)).toBe(false);
    expect(enemy.combat.deaths).toBe(1);
    expect(enemy.combat.respawnAt).toBe(world.tick + COMBAT.enterDelayTicks);
    expect(me.combat.kills).toBe(1);
    expect(me.combat.bounty).toBe(COMBAT.bountyIncreaseForKill);
    expect(world.events.some((e) => e.type === "shipDied" && e.killer === me.id)).toBe(true);
  });

  it("respawns at full energy after EnterDelay, clearing the dead flag", () => {
    const world = new World(openMap());
    const me = world.localPlayer;
    const enemy = placeEnemy(world, "enemy", me.kinematics.x + 100, me.kinematics.y);
    enemy.resources.energy = 50;
    enemy.combat.bounty = 7; // earned bounty is wiped on respawn

    world.projectiles.push(projectileAt("bullet", me.id, enemy.kinematics.x, enemy.kinematics.y));
    world.step(IDLE_CTX);
    expect(isAlive(enemy)).toBe(false);

    // Run out the respawn timer.
    while (!isAlive(enemy)) world.step(IDLE_CTX);

    expect(enemy.resources.energy).toBe(shipConfig(WARBIRD).initial.maxEnergy);
    expect(enemy.combat.respawnAt).toBe(0);
    expect(enemy.combat.bounty).toBe(0);
    expect(enemy.combat.lastHitBy).toBeNull();
    expect(world.events.some((e) => e.type === "playerSpawned" && e.player === "enemy")).toBe(true);
  });

  it("a dead ship can't fire or be hit again", () => {
    const world = new World(openMap());
    const me = world.localPlayer;
    const enemy = placeEnemy(world, "enemy", me.kinematics.x + 100, me.kinematics.y);
    enemy.resources.energy = 50;

    world.projectiles.push(projectileAt("bullet", me.id, enemy.kinematics.x, enemy.kinematics.y));
    world.step(IDLE_CTX);
    expect(isAlive(enemy)).toBe(false);
    const deathsAfterFirst = enemy.combat.deaths;

    // A second shot onto the corpse passes straight through (no extra death).
    world.projectiles.push(projectileAt("bullet", me.id, enemy.kinematics.x, enemy.kinematics.y));
    world.step(IDLE_CTX);
    expect(enemy.combat.deaths).toBe(deathsAfterFirst);
    expect(world.projectiles).toHaveLength(1); // the shot ignored the ghost
  });
});

// --- Determinism (the whole point of the seeded sim) -------------------------

describe("determinism", () => {
  it("two worlds with the same seed and inputs stay byte-identical", () => {
    const seed = 123;
    const a = new World(openMap(), seed);
    const b = new World(openMap(), seed);

    // A fixed, varied input script driven only by the tick index.
    for (let t = 0; t < 300; t++) {
      const cmd = input({
        thrust: t % 3 === 0,
        rotateRight: t % 5 === 0,
        fire: t % 7 === 0,
        bomb: t % 50 === 0,
      });
      a.step(ctx(a, cmd));
      b.step(ctx(b, cmd));
    }

    expect(snapshot(a)).toEqual(snapshot(b));
  });
});

/** A plain-data view of the sim state — exactly the kind of thing the network
 *  snapshot will serialize. Used to assert two runs are identical. */
function snapshot(world: World) {
  return {
    tick: world.tick,
    rng: world.rng.seed,
    players: [...world.players.values()],
    projectiles: world.projectiles,
  };
}
