import { describe, expect, it } from "vitest";
import { NET, TILE_SIZE, WARBIRD } from "../config";
import { GameMap } from "../sim/gamemap";
import { World } from "../sim/world";
import type { PositionMessage, RemoteInfo } from "./protocol";
import { RemotePlayers } from "./remotePlayers";

const SNAP_PX = NET.snapTiles * TILE_SIZE;

/** A completely open map; out-of-bounds counts as solid, so a ship bounces off
 *  the world edges. */
function openMap(tiles = 64): GameMap {
  return new GameMap(tiles, tiles, new Uint8Array(tiles * tiles));
}

/** A networked world: one local (authoritative) ship, so any other player is a
 *  remote the sim never steps. */
function netWorld(): World {
  const world = new World(openMap());
  world.authoritativePlayerId = world.localPlayerId;
  return world;
}

function info(id: string, x: number, y: number): RemoteInfo {
  return { id, name: id, team: 0, shipType: WARBIRD, x, y };
}

function pos(id: string, over: Partial<PositionMessage>): PositionMessage {
  return {
    t: "pos",
    id,
    tick: 1,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    rotation: 0,
    energy: 1000,
    bounty: 0,
    ...over,
  };
}

describe("RemotePlayers — smoothing (netcode §4)", () => {
  it("closes a small position error evenly over the lerp window", () => {
    const world = netWorld();
    const rp = new RemotePlayers();
    rp.ensureRemote(world, info("p2", 100, 100));
    const k = world.players.get("p2")!.kinematics;

    // Packet is 10px east, stationary — a sub-snap error that must be smoothed,
    // not popped: the ship stays put on receipt.
    rp.applyPosition(world, pos("p2", { x: 110, y: 100, energy: 900, bounty: 5 }));
    expect(k.x).toBeCloseTo(100);
    expect(k.y).toBeCloseTo(100);

    // The HUD fields update immediately regardless of smoothing.
    const p = world.players.get("p2")!;
    expect(p.resources.energy).toBe(900);
    expect(p.combat.bounty).toBe(5);

    // Halfway through the window it is halfway to the target...
    for (let i = 0; i < NET.lerpTicks / 2; i++) rp.advanceTick(world);
    expect(k.x).toBeCloseTo(105);

    // ...and by the end of it, arrived (then on pure dead reckoning).
    for (let i = 0; i < NET.lerpTicks / 2; i++) rp.advanceTick(world);
    expect(k.x).toBeCloseTo(110);
    expect(k.y).toBeCloseTo(100);
  });

  it("snaps (hard warp) when the error exceeds the threshold", () => {
    const world = netWorld();
    const rp = new RemotePlayers();
    rp.ensureRemote(world, info("p2", 100, 100));
    const k = world.players.get("p2")!.kinematics;

    const target = 100 + SNAP_PX + 6; // well past the 4-tile snap threshold
    rp.applyPosition(world, pos("p2", { x: target, y: 100 }));

    // Jumped straight to the asserted pose, with prev = current so the renderer
    // does not interpolate across the gap.
    expect(k.x).toBeCloseTo(target);
    expect(k.prevX).toBeCloseTo(target);
  });

  it("dead-reckons: a coasting remote advances by its velocity each tick", () => {
    const world = netWorld();
    const rp = new RemotePlayers();
    rp.ensureRemote(world, info("p2", 500, 500));
    const k = world.players.get("p2")!.kinematics;
    k.vx = 2;

    rp.advanceTick(world);
    expect(k.x).toBeCloseTo(502); // drag is 1.0 (frictionless)
    expect(k.prevX).toBeCloseTo(500); // prev tracks last tick for interpolation
  });

  it("dead-reckons through walls: a remote bounces off the world edge", () => {
    const world = netWorld();
    const rp = new RemotePlayers();
    // Just inside the east edge (64 tiles * 16 = 1024px), heading into it.
    rp.ensureRemote(world, info("p2", 1024 - 15, 500));
    const k = world.players.get("p2")!.kinematics;
    k.vx = 10;

    rp.advanceTick(world);
    expect(k.vx).toBeLessThan(0); // reflected off the wall
  });

  it("stops smoothing a player that has left", () => {
    const world = netWorld();
    const rp = new RemotePlayers();
    rp.ensureRemote(world, info("p2", 100, 100));
    rp.removeRemote(world, "p2");
    expect(world.players.has("p2")).toBe(false);
    // advancing with no remotes is a no-op, not a crash
    expect(() => rp.advanceTick(world)).not.toThrow();
  });
});
