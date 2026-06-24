/**
 * Client-side prediction + reconciliation for the local ship — M2.4.
 *
 * Before this step the local ship was rendered straight from the latest
 * authoritative snapshot, so it lagged by RTT and rubber-banded (every keypress
 * waited a server round-trip to show). M2.4 fixes that with **rewind-and-replay**:
 *
 *   1. The server stamps each snapshot with the highest input `seq` it has
 *      processed (`lastProcessedInputSeq`, the *ack*).
 *   2. The client holds a third, **predicted** `World` containing only the local
 *      player. Each frame it *rebuilds* that world from scratch: reset the local
 *      player to the acked authoritative pose, then replay every still-un-acked
 *      input (the `ClientInputManager` ring buffer) through the *exact same*
 *      `World.step()` the server runs.
 *
 * Determinism (the sim is pure — no `Math.random()`, no DOM) is what makes the
 * replay reproduce the server bit-for-bit, so in clean conditions the predicted
 * pose at a given `seq` equals the authoritative pose at that `seq`
 * (`predictionErrorPx ≈ 0`). The rebuild-every-frame design means new inputs
 * produced this frame are already in the buffer, so the ship responds instantly
 * *and* self-corrects on each snapshot through one code path.
 *
 * Scope is the local **ship only**: the predicted world has no remote players or
 * enemy projectiles, so collision/damage never fire — hits stay 100%
 * server-authoritative. Own-weapon prediction is M2.6; correction smoothing is
 * M2.5 (here a real mismatch may visibly snap, which is acceptable).
 */

import type { GameMap } from "../sim/gamemap";
import type { Player, PlayerId } from "../sim/types";
import { World } from "../sim/world";
import type { SequencedInput } from "./protocol";

/** The recorded local pose after replaying up to a given input `seq`, so a later
 *  snapshot acking that `seq` can be compared against what we predicted for it. */
interface PredictedPose {
  x: number;
  y: number;
}

export class Predictor {
  /** Predicted world — holds only the local player, stepped locally. Never fed
   *  remote entities, so its collision/damage systems are inert. */
  private readonly world: World;

  /** The last authoritative local player (deep-cloned from a snapshot) and the
   *  tick it was sampled at — the rewind point every rebuild resets to. `null`
   *  until the first snapshot arrives. */
  private authoritative: Player | null = null;
  private authoritativeTick = 0;

  /** `seq → predicted pose`, recorded during replay so `measureError` can compare
   *  against the authoritative pose for the acked `seq`. Pruned as inputs ack. */
  private readonly predictedPose = new Map<number, PredictedPose>();

  /** Distance (px) between the predicted and authoritative local pose at the last
   *  acked `seq`. ≈0 under clean conditions proves client/server determinism
   *  parity. Surfaced on the netcode debug overlay. */
  predictionErrorPx = 0;

  constructor(map: GameMap) {
    // No auto local player — the predicted world is populated purely from the
    // authoritative snapshots we reset to each frame.
    this.world = new World(map, 1, false);
  }

  /** Record the acked authoritative local state as the new rewind point. Called
   *  from the snapshot handler with the local player out of the fresh snapshot. */
  setAuthoritative(localPlayer: Player, tick: number): void {
    this.authoritative = structuredClone(localPlayer);
    this.authoritativeTick = tick;
  }

  /**
   * Rebuild the predicted local player: reset to the last authoritative pose,
   * then replay all `unacked` inputs (ascending by `seq`) through the full sim
   * pipeline. Returns the predicted local player, or `null` before the first
   * snapshot has set authoritative state.
   */
  predict(unacked: readonly SequencedInput[], localId: PlayerId): Player | null {
    if (!this.authoritative) return null;

    // Reset to the authoritative rewind point. structuredClone so step()'s
    // in-place mutation never corrupts the stored snapshot.
    this.world.players.clear();
    this.world.players.set(localId, structuredClone(this.authoritative));
    this.world.tick = this.authoritativeTick;
    this.world.projectiles.length = 0;
    this.world.events.length = 0;

    this.predictedPose.clear();
    for (const input of unacked) {
      this.world.step({ inputs: new Map([[localId, input.cmd]]) });
      const k = this.world.players.get(localId)!.kinematics;
      this.predictedPose.set(input.seq, { x: k.x, y: k.y });
    }

    return this.world.players.get(localId) ?? null;
  }

  /**
   * Set `predictionErrorPx` from the gap between what we predicted for `ackedSeq`
   * and the authoritative pose the server reports for it. Call *before* the input
   * manager drops the acked inputs (so this frame's replay still recorded the
   * seq). Then prune recorded poses at or below the ack.
   */
  measureError(authLocal: Player, ackedSeq: number): void {
    const predicted = this.predictedPose.get(ackedSeq);
    if (predicted) {
      const k = authLocal.kinematics;
      this.predictionErrorPx = Math.hypot(predicted.x - k.x, predicted.y - k.y);
    }
    for (const seq of this.predictedPose.keys()) {
      if (seq <= ackedSeq) this.predictedPose.delete(seq);
    }
  }
}
