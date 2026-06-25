import { describe, expect, it } from "vitest";
import { GameMap } from "../sim/gamemap";
import type { InputCommand, Player, Projectile, StepContext } from "../sim/types";
import { LOCAL_PLAYER_ID, World } from "../sim/world";
import { Predictor } from "./prediction";
import type { SequencedInput } from "./protocol";

// --- fixtures ----------------------------------------------------------------

/** An all-open map (no walls), so motion is purely deterministic physics. */
function openMap(): GameMap {
  return new GameMap(64, 64, new Uint8Array(64 * 64));
}

const IDLE: InputCommand = {
  rotateLeft: false,
  rotateRight: false,
  thrust: false,
  reverse: false,
  afterburner: false,
  fire: false,
  bomb: false,
};

const cmd = (over: Partial<InputCommand>): InputCommand => ({ ...IDLE, ...over });
const seqInput = (seq: number, c: InputCommand): SequencedInput => ({ seq, clientTick: seq, cmd: c });
const ctx = (c: InputCommand): StepContext => ({ inputs: new Map([[LOCAL_PLAYER_ID, c]]) });

/** A varied-but-fixed input script driven only by the tick index. */
const script = (t: number): InputCommand =>
  cmd({ thrust: t % 2 === 0, rotateRight: t % 3 === 0, reverse: t % 7 === 0 });

describe("Predictor", () => {
  it("returns null before the first authoritative snapshot", () => {
    const predictor = new Predictor(openMap());
    expect(predictor.predict([], LOCAL_PLAYER_ID)).toBeNull();
  });

  it("with no un-acked inputs reproduces the authoritative pose exactly (the reset)", () => {
    const ref = new World(openMap(), 1);
    for (let t = 0; t < 15; t++) ref.step(ctx(script(t)));
    const auth = structuredClone(ref.localPlayer);

    const predictor = new Predictor(openMap());
    predictor.setAuthoritative(auth, [],ref.tick);
    const predicted = predictor.predict([], LOCAL_PLAYER_ID)!;

    expect(predicted.kinematics.x).toBe(auth.kinematics.x);
    expect(predicted.kinematics.y).toBe(auth.kinematics.y);
    expect(predicted.kinematics.rotation).toBe(auth.kinematics.rotation);
  });

  it("replays un-acked inputs to re-derive 'now' identically to the server (determinism parity)", () => {
    // Reference world = the authoritative server. Warm it up, snapshot it, then
    // keep stepping it — those continued steps are the client's un-acked inputs.
    const ref = new World(openMap(), 1);
    for (let t = 0; t < 20; t++) ref.step(ctx(script(t)));
    const authTick = ref.tick;
    const auth = structuredClone(ref.localPlayer);

    const unacked: SequencedInput[] = [];
    for (let t = 20; t < 30; t++) {
      const c = script(t);
      ref.step(ctx(c)); // server advances
      unacked.push(seqInput(ref.tick, c)); // seq === resulting tick
    }

    const predictor = new Predictor(openMap());
    predictor.setAuthoritative(auth, [],authTick);
    const predicted = predictor.predict(unacked, LOCAL_PLAYER_ID)!;

    // Pure sim + same inputs ⇒ bit-identical pose.
    expect(predicted.kinematics.x).toBe(ref.localPlayer.kinematics.x);
    expect(predicted.kinematics.y).toBe(ref.localPlayer.kinematics.y);
    expect(predicted.kinematics.rotation).toBe(ref.localPlayer.kinematics.rotation);
  });

  it("measures ~0 prediction error against a matching authoritative pose, and prunes acked seqs", () => {
    const ref = new World(openMap(), 1);
    for (let t = 0; t < 10; t++) ref.step(ctx(script(t)));
    const auth = structuredClone(ref.localPlayer);
    const authTick = ref.tick;

    // Capture the true authoritative pose at each continued tick, keyed by seq.
    const unacked: SequencedInput[] = [];
    const truth = new Map<number, Player>();
    for (let t = 10; t < 16; t++) {
      const c = script(t);
      ref.step(ctx(c));
      unacked.push(seqInput(ref.tick, c));
      truth.set(ref.tick, structuredClone(ref.localPlayer));
    }

    const predictor = new Predictor(openMap());
    predictor.setAuthoritative(auth, [],authTick);
    predictor.predict(unacked, LOCAL_PLAYER_ID);

    // The server acks an interior seq; predicted vs authoritative must match.
    const ackedSeq = 13;
    predictor.measureError(truth.get(ackedSeq)!, ackedSeq);
    expect(predictor.predictionErrorPx).toBeCloseTo(0, 6);

    // After the ack, seqs ≤ ackedSeq are pruned: re-measuring that seq with a
    // wildly displaced pose is a no-op (no recorded prediction to compare).
    const displaced = structuredClone(truth.get(ackedSeq)!);
    displaced.kinematics.x += 100;
    predictor.measureError(displaced, ackedSeq);
    expect(predictor.predictionErrorPx).toBeCloseTo(0, 6);
  });

  it("reports the distance when prediction and authority disagree", () => {
    const ref = new World(openMap(), 1);
    for (let t = 0; t < 5; t++) ref.step(ctx(script(t)));
    const auth = structuredClone(ref.localPlayer);

    const unacked = [seqInput(ref.tick + 1, script(5))];
    const predictor = new Predictor(openMap());
    predictor.setAuthoritative(auth, [],ref.tick);
    const predicted = predictor.predict(unacked, LOCAL_PLAYER_ID)!;

    // Hand it an authoritative pose offset by a 3-4-5 triangle from prediction.
    const disagreeing = structuredClone(predicted);
    disagreeing.kinematics.x += 3;
    disagreeing.kinematics.y += 4;
    predictor.measureError(disagreeing, unacked[0].seq);
    expect(predictor.predictionErrorPx).toBeCloseTo(5, 6);
  });
});

// --- M2.6: own-weapon prediction ---------------------------------------------

/** Assert two projectiles share flight state (ignoring id, which differs between
 *  predicted negative ids and authoritative positive ids). */
function expectSamePose(a: Projectile, b: Projectile): void {
  expect(a.x).toBe(b.x);
  expect(a.y).toBe(b.y);
  expect(a.vx).toBe(b.vx);
  expect(a.vy).toBe(b.vy);
  expect(a.kind).toBe(b.kind);
}

describe("Predictor — projectiles", () => {
  it("replay-spawns own shots from un-acked fire inputs, matching the server bit-for-bit", () => {
    // Warm up with no firing, snapshot, then keep firing — those continued steps
    // are the client's un-acked inputs. The reference world is the server.
    const ref = new World(openMap(), 1);
    for (let t = 0; t < 10; t++) ref.step(ctx(IDLE));
    const auth = structuredClone(ref.localPlayer);
    const authTick = ref.tick;

    const unacked: SequencedInput[] = [];
    for (let t = 10; t < 25; t++) {
      const c = cmd({ fire: true });
      ref.step(ctx(c));
      unacked.push(seqInput(ref.tick, c));
    }
    // Sanity: the firing actually produced shots (cooldown lets a few through).
    expect(ref.projectiles.length).toBeGreaterThan(0);

    const predictor = new Predictor(openMap());
    predictor.setAuthoritative(auth, [], authTick); // no acked shots yet
    predictor.predict(unacked, LOCAL_PLAYER_ID);

    expect(predictor.predictedProjectiles.length).toBe(ref.projectiles.length);
    for (let i = 0; i < ref.projectiles.length; i++) {
      expectSamePose(predictor.predictedProjectiles[i], ref.projectiles[i]);
      expect(predictor.predictedProjectiles[i].owner).toBe(LOCAL_PLAYER_ID);
      // Replay-spawned shots are tagged and given a stable negative view id.
      expect(predictor.predictedProjectiles[i].spawnSeq).toBeGreaterThan(0);
      expect(predictor.predictedProjectiles[i].id).toBeLessThan(0);
    }
  });

  it("advances a seeded (acked) projectile exactly like the server over un-acked idle ticks", () => {
    const ref = new World(openMap(), 1);
    ref.step(ctx(cmd({ fire: true }))); // one bullet
    expect(ref.projectiles.length).toBe(1);
    const auth = structuredClone(ref.localPlayer);
    const authTick = ref.tick;
    const authProjectiles = structuredClone(
      ref.projectiles.filter((p) => p.owner === LOCAL_PLAYER_ID),
    );

    // Continue the server with idle ticks — the bullet flies on its own.
    const unacked: SequencedInput[] = [];
    for (let t = 0; t < 8; t++) {
      ref.step(ctx(IDLE));
      unacked.push(seqInput(ref.tick, IDLE));
    }

    const predictor = new Predictor(openMap());
    predictor.setAuthoritative(auth, authProjectiles, authTick);
    predictor.predict(unacked, LOCAL_PLAYER_ID);

    expect(predictor.predictedProjectiles.length).toBe(1);
    expectSamePose(predictor.predictedProjectiles[0], ref.projectiles[0]);
    // Idle replay never re-spawns it: it keeps its positive server id, no tag.
    expect(predictor.predictedProjectiles[0].id).toBe(authProjectiles[0].id);
    expect(predictor.predictedProjectiles[0].id).toBeGreaterThanOrEqual(0);
    expect(predictor.predictedProjectiles[0].spawnSeq).toBeUndefined();
  });

  it("does not double-spawn a shot whose fire input is already acked (seeded, not replayed)", () => {
    const ref = new World(openMap(), 1);
    ref.step(ctx(cmd({ fire: true }))); // bullet from the now-acked fire
    const auth = structuredClone(ref.localPlayer);
    const authTick = ref.tick;
    const authProjectiles = structuredClone(ref.projectiles);

    const predictor = new Predictor(openMap());
    predictor.setAuthoritative(auth, authProjectiles, authTick);
    // The fire's seq is acked, so it's NOT in the un-acked buffer.
    predictor.predict([], LOCAL_PLAYER_ID);

    expect(predictor.predictedProjectiles.length).toBe(1); // not 2
    expect(predictor.predictedProjectiles[0].id).toBe(authProjectiles[0].id);
  });

  it("gives an un-acked shot a stable id across repeated rebuilds", () => {
    const ref = new World(openMap(), 1);
    for (let t = 0; t < 5; t++) ref.step(ctx(IDLE));
    const auth = structuredClone(ref.localPlayer);

    const fireSeq = ref.tick + 1;
    const unacked = [seqInput(fireSeq, cmd({ fire: true }))];

    const predictor = new Predictor(openMap());
    predictor.setAuthoritative(auth, [], ref.tick);

    predictor.predict(unacked, LOCAL_PLAYER_ID);
    expect(predictor.predictedProjectiles.length).toBe(1);
    const id1 = predictor.predictedProjectiles[0].id;
    expect(predictor.predictedProjectiles[0].spawnSeq).toBe(fireSeq);

    predictor.predict(unacked, LOCAL_PLAYER_ID); // rebuild
    const id2 = predictor.predictedProjectiles[0].id;

    expect(id1).toBeLessThan(0);
    expect(id2).toBe(id1); // stable across frames
  });
});
