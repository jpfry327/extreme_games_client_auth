/**
 * Determinism audit — M2.5.
 *
 * The whole prediction story rests on one claim: replaying the same inputs from
 * the same state reproduces the server bit-for-bit. M2.4 reconciliation rewinds
 * the local ship to the last ack and replays the un-acked inputs; if the replay
 * diverged even slightly, every snapshot would yield a non-zero `predictionError`
 * and a visible correction. These tests guard that contract directly.
 *
 *   1. Two independent `World`s fed an identical input stream (with combat, so
 *      death/respawn consume the seeded RNG) stay byte-identical at *every* tick,
 *      compared through the real `serializeSnapshotFor` wire path.
 *   2. The reconciliation pattern itself: resetting to an authoritative pose
 *      mid-stream and replaying the tail reproduces the continuously-stepped
 *      world exactly — i.e. `Predictor.predict` is sound.
 */

import { describe, expect, it } from "vitest";
import { WARBIRD } from "../config";
import { GameMap } from "../sim/gamemap";
import type { InputCommand, Player, StepContext } from "../sim/types";
import { World } from "../sim/world";
import { serializeSnapshotFor, type Snapshot } from "./snapshot";

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

function input(partial: Partial<InputCommand>): InputCommand {
  return { ...NO_INPUT, ...partial };
}

/** A fixed, varied per-tick input script — turns, thrust, and both weapons, so
 *  movement + firing + projectile + collision systems all run. */
function scriptedInput(t: number): InputCommand {
  return input({
    thrust: t % 3 === 0,
    rotateRight: t % 5 === 0,
    rotateLeft: t % 11 === 0,
    fire: t % 7 === 0,
    bomb: t % 60 === 0,
  });
}

const ACK = { lastProcessedInputSeq: 0, inputBufferDepth: 0 };

/** Serialize from a fixed viewpoint so two runs compare through the exact wire
 *  path netcode uses. */
function wireSnapshot(world: World, viewerId: string): Snapshot {
  return serializeSnapshotFor(world, viewerId, ACK);
}

// --- 1. two independent worlds stay identical --------------------------------

describe("determinism audit", () => {
  it("two worlds with the same seed + input stream are byte-identical every tick", () => {
    const seed = 1337;
    const a = new World(openMap(), seed);
    const b = new World(openMap(), seed);
    const viewer = a.localPlayerId;

    // A second player in both worlds, set up identically, so collision → damage →
    // death → respawn all fire and consume the seeded RNG (respawn spawn pick).
    const setupEnemy = (w: World) => {
      const e = w.addPlayer("enemy", "enemy", 1, WARBIRD);
      const me = w.localPlayer.kinematics;
      e.kinematics.x = e.kinematics.prevX = me.x + 40;
      e.kinematics.y = e.kinematics.prevY = me.y;
      e.resources.energy = 100; // soft, so the local player's fire can kill it
    };
    setupEnemy(a);
    setupEnemy(b);

    for (let t = 0; t < 600; t++) {
      const cmd = scriptedInput(t);
      const ctx: StepContext = { inputs: new Map([[viewer, cmd]]) };
      a.step(ctx);
      b.step(ctx);
      // Compare through the wire path at every tick, so any divergence is caught
      // at the exact tick it happens rather than only at the end.
      expect(wireSnapshot(a, viewer)).toEqual(wireSnapshot(b, viewer));
    }

    // RNG state itself must have advanced identically (death/respawn consumed it).
    expect(a.rng.seed).toBe(b.rng.seed);
  });

  // --- 2. rewind-and-replay reproduces the continuous run --------------------

  it("replaying the tail of an input stream from an authoritative pose reproduces the live world", () => {
    const seed = 4242;
    const id = "local";

    // Authoritative world: one player, stepped continuously through the stream.
    const auth = new World(openMap(), seed, false);
    auth.localPlayerId = id;
    auth.addPlayer(id, id, 0, WARBIRD);

    const stream: InputCommand[] = [];
    const TOTAL = 200;
    const ACK_AT = 120; // the "last processed input" the snapshot would carry

    const stepAuth = (t: number) => {
      const cmd = scriptedInput(t);
      stream.push(cmd);
      auth.step({ inputs: new Map([[id, cmd]]) });
    };

    for (let t = 0; t < ACK_AT; t++) stepAuth(t);
    // The snapshot the client would ack: deep-clone the authoritative pose + tick.
    const ackedPose: Player = structuredClone(auth.localPlayer);
    const ackedTick = auth.tick;
    for (let t = ACK_AT; t < TOTAL; t++) stepAuth(t);
    const authFinal: Player = structuredClone(auth.localPlayer);

    // Predicted world: exactly what Predictor.predict does — reset to the acked
    // pose, then replay the un-acked tail (inputs ACK_AT..TOTAL).
    const pred = new World(openMap(), seed, false);
    pred.localPlayerId = id;
    pred.players.set(id, structuredClone(ackedPose));
    pred.tick = ackedTick;
    for (let t = ACK_AT; t < TOTAL; t++) {
      pred.step({ inputs: new Map([[id, stream[t]]]) });
    }

    // The replayed ship must equal the continuously-stepped ship, bit for bit —
    // this is the reconciliation contract M2.4/M2.5 depend on.
    expect(pred.players.get(id)).toEqual(authFinal);
  });
});
