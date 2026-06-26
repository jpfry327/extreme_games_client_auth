/**
 * Binary snapshot codec + delta compression — M2.13.
 *
 * The contract the rest of the netcode rests on: a client that reconstructs the
 * world from a *delta* chain ends up with exactly the same `Snapshot` as one that
 * decoded a *full* keyframe of the same tick — bit for bit. If that ever drifts,
 * remote ships and projectiles would desync silently. These tests drive real
 * snapshots (stepped from a `World`, through the same `serializeSnapshotFor` path
 * the server uses) through the encode→decode round-trip and assert that equality,
 * plus the keyframe-recovery and add/remove-entity edge cases.
 */

import { describe, expect, it } from "vitest";
import { WARBIRD } from "../config";
import { GameMap } from "../sim/gamemap";
import type { InputCommand, StepContext } from "../sim/types";
import { World } from "../sim/world";
import { serializeSnapshotFor, type Snapshot } from "./snapshot";
import {
  decodeSnapshot,
  encodeSnapshot,
  MissingBaselineError,
  quantizeSnapshot,
} from "./snapshotCodec";
import { SnapshotChannel } from "./serverSnapshots";

// --- fixtures ----------------------------------------------------------------

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

const ACK = { lastProcessedInputSeq: 0, inputBufferDepth: 0 };

/** Step a world for `ticks`, capturing a snapshot every `every` ticks. The local
 *  player thrusts/turns/fires and an enemy sits nearby, so movement, firing,
 *  projectile flight, and collision/death all run — i.e. fields change, entities
 *  spawn and despawn, exercising the delta paths (changed/added/removed). */
function snapshotSequence(seed: number, ticks = 240, every = 3): Snapshot[] {
  const world = new World(openMap(), seed, false);
  const me = world.localPlayerId;
  world.addPlayer(me, "me", 0, WARBIRD);
  const enemy = world.addPlayer("enemy", "enemy", 1, WARBIRD);
  const local = world.localPlayer.kinematics;
  enemy.kinematics.x = enemy.kinematics.prevX = local.x + 60;
  enemy.kinematics.y = enemy.kinematics.prevY = local.y;
  enemy.resources.energy = 80; // soft, so fire eventually kills → death/respawn

  const snaps: Snapshot[] = [];
  for (let t = 0; t < ticks; t++) {
    const cmd: InputCommand = {
      ...NO_INPUT,
      thrust: t % 3 === 0,
      rotateRight: t % 5 === 0,
      rotateLeft: t % 11 === 0,
      fire: t % 4 === 0,
      bomb: t % 50 === 0,
    };
    const ctx: StepContext = { inputs: new Map([[me, cmd]]) };
    world.step(ctx);
    if (t % every === 0) snaps.push(serializeSnapshotFor(world, me, ACK));
  }
  return snaps;
}

/** Decode a snapshot as a standalone keyframe (the "full snapshot" reference). */
function decodeKeyframe(snap: Snapshot): Snapshot {
  return decodeSnapshot(encodeSnapshot(quantizeSnapshot(snap), null), () => undefined);
}

// --- tests -------------------------------------------------------------------

describe("snapshot codec — keyframe round-trip", () => {
  it("a keyframe decodes back to the quantized snapshot, field for field", () => {
    const snap = snapshotSequence(11, 60).at(-1)!;
    const decoded = decodeKeyframe(snap);
    // Equality is against the *quantized* snapshot — f32 rounding is the wire's
    // only lossy step, applied identically on both sides.
    expect(decoded).toEqual(quantizeSnapshot(snap));
    expect(decoded.players.length).toBeGreaterThan(0);
  });

  it("carries every event type and pings verbatim", () => {
    // Hand-build a snapshot exercising all four GameEvent variants (a real
    // broadcast rarely carries every one at once) plus a null killer and pings.
    const base = snapshotSequence(7, 30).at(-1)!;
    const withEvents: Snapshot = {
      ...base,
      events: [
        { type: "bombExploded", x: 12.5, y: -3.25, owner: "enemy" },
        { type: "shipHit", target: "me", by: "enemy", damage: 30, x: 1, y: 2, fatal: true, rewound: true },
        { type: "shipDied", victim: "me", killer: "enemy", bounty: 7, x: 3, y: 4 },
        { type: "shipDied", victim: "enemy", killer: null, bounty: 0, x: 5, y: 6 }, // wall death
        { type: "playerSpawned", player: "me", x: 100, y: 200 },
      ],
      pings: { me: 42, enemy: 0 },
    };
    const decoded = decodeKeyframe(withEvents);
    expect(decoded.events).toEqual(withEvents.events);
    expect(decoded.pings).toEqual(withEvents.pings);
  });
});

describe("snapshot codec — delta equals full, bit-for-bit", () => {
  it("a delta-applied client world matches a full-snapshot one at every tick", () => {
    const snaps = snapshotSequence(1337);
    expect(snaps.length).toBeGreaterThan(20);

    // Simulate the server keeping the just-sent (and immediately acked) snapshot
    // as the next baseline, and the client decoding the delta chain against its
    // own retained baselines — the exact round-trip the wire performs.
    let serverBaseline: Snapshot | null = null;
    const clientBaselines = new Map<number, Snapshot>();

    let sawDelta = false;
    for (const raw of snaps) {
      const q = quantizeSnapshot(raw);
      const bytes = encodeSnapshot(q, serverBaseline);
      if (serverBaseline !== null) sawDelta = true;

      const decoded = decodeSnapshot(bytes, (t) => clientBaselines.get(t));
      // The headline contract: identical to a standalone keyframe of the same tick.
      expect(decoded).toEqual(decodeKeyframe(raw));

      clientBaselines.set(decoded.tick, decoded);
      serverBaseline = q; // client acked this tick immediately
    }
    expect(sawDelta).toBe(true);
  });

  it("a steady scene's delta is much smaller than its keyframe", () => {
    // Two idle players, no input: almost nothing changes between snapshots, so the
    // delta should be a tiny fraction of the full keyframe — the whole point.
    const world = new World(openMap(), 5, false);
    world.addPlayer(world.localPlayerId, "me", 0, WARBIRD);
    world.addPlayer("enemy", "enemy", 1, WARBIRD);
    const idle: StepContext = { inputs: new Map() };
    world.step(idle);
    const a = quantizeSnapshot(serializeSnapshotFor(world, world.localPlayerId, ACK));
    world.step(idle);
    const b = quantizeSnapshot(serializeSnapshotFor(world, world.localPlayerId, ACK));

    const keyframeBytes = encodeSnapshot(b, null).length;
    const deltaBytes = encodeSnapshot(b, a).length;
    expect(deltaBytes).toBeLessThan(keyframeBytes / 2);
  });
});

describe("snapshot codec — keyframe recovery", () => {
  it("a delta against a missing baseline throws, and a later keyframe recovers", () => {
    const snaps = snapshotSequence(99).slice(0, 6);
    const q = snaps.map(quantizeSnapshot);

    // Client decodes the opening keyframe, then a delta drops in flight.
    const clientBaselines = new Map<number, Snapshot>();
    const kf0 = decodeSnapshot(encodeSnapshot(q[0], null), (t) => clientBaselines.get(t));
    clientBaselines.set(kf0.tick, kf0);

    // The server sends snap[2] as a delta against snap[1] — but the client never
    // received snap[1] (it was dropped), so it can't apply the delta.
    const orphanDelta = encodeSnapshot(q[2], q[1]);
    expect(() => decodeSnapshot(orphanDelta, (t) => clientBaselines.get(t))).toThrow(
      MissingBaselineError,
    );

    // The server's periodic keyframe recovers the stream with no shared baseline.
    const recovery = decodeSnapshot(encodeSnapshot(q[3], null), (t) => clientBaselines.get(t));
    expect(recovery).toEqual(decodeKeyframe(snaps[3]));
  });
});

describe("snapshot codec — entity add / remove", () => {
  it("a player and a projectile present in the baseline but gone now are removed", () => {
    const world = new World(openMap(), 3, false);
    const me = world.localPlayerId;
    world.addPlayer(me, "me", 0, WARBIRD);
    world.addPlayer("enemy", "enemy", 1, WARBIRD);
    // Fire once so a projectile exists in the baseline.
    world.step({ inputs: new Map([[me, { ...NO_INPUT, fire: true }]]) });
    const base = quantizeSnapshot(serializeSnapshotFor(world, me, ACK));
    expect(base.projectiles.length).toBeGreaterThan(0);

    // Remove the enemy and all projectiles, advance a tick.
    world.players.delete("enemy");
    world.projectiles.length = 0;
    world.step({ inputs: new Map() });
    const next = quantizeSnapshot(serializeSnapshotFor(world, me, ACK));

    const decoded = decodeSnapshot(encodeSnapshot(next, base), (t) =>
      t === base.tick ? base : undefined,
    );
    expect(decoded).toEqual(decodeKeyframe(serializeSnapshotFor(world, me, ACK)));
    expect(decoded.players.map((p) => p.id)).toEqual([me]);
    expect(decoded.projectiles).toEqual([]);
  });
});

describe("SnapshotChannel — server-side baseline selection", () => {
  it("keyframes until the client acks, then deltas against the acked tick", () => {
    const channel = new SnapshotChannel();
    const client = "p1";
    const snaps = snapshotSequence(2024).slice(0, 4).map(quantizeSnapshot);
    const clientBaselines = new Map<number, Snapshot>();
    const decode = (bytes: Uint8Array) =>
      decodeSnapshot(bytes, (t) => clientBaselines.get(t));

    // First broadcast: no ack yet → keyframe (decodes with no baseline).
    channel.record(snaps[0]);
    const b0 = channel.encodeFor(client, snaps[0], 0, 0);
    const d0 = decode(b0);
    expect(d0).toEqual(snaps[0]);
    clientBaselines.set(d0.tick, d0);

    // Client acks tick0; next broadcast must delta against it. Proven by decoding
    // it *only* with tick0 available as a baseline.
    channel.onAck(client, d0.tick);
    channel.record(snaps[1]);
    const b1 = channel.encodeFor(client, snaps[1], 0, 0);
    const d1 = decode(b1);
    expect(d1).toEqual(snaps[1]);

    // And a delta really was sent: stripping the baseline now fails to decode.
    expect(() => decodeSnapshot(b1, () => undefined)).toThrow(MissingBaselineError);
  });
});
