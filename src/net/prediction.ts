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
 * Scope of the predicted world is the local player plus **its own projectiles**:
 * still no remote players or enemy projectiles, so collision/damage never fire —
 * hits stay 100% server-authoritative. (M2.4 was the ship only; M2.6 adds
 * own-weapon prediction below.) Correction smoothing is M2.5 (here a real
 * mismatch may visibly snap, which is acceptable).
 *
 * Own-weapon prediction (M2.6)
 * ----------------------------
 * Replaying an un-acked `fire`/`bomb` input through the same pipeline *already*
 * spawns and advances a projectile (cooldown + energy gating included), so the
 * machinery is reused wholesale. Each rebuild the predicted world is seeded with
 * the latest snapshot's already-acked local projectiles and then replays the
 * un-acked inputs, which both **advances** the seeded shots to the leading edge
 * (projectile motion is input-independent, so this matches where the server will
 * have them) and **spawns** the still-un-acked shots. The ack boundary means a
 * given fire is either seeded (acked) or replay-spawned (un-acked), never both,
 * so there's no double-spawn; a server-rejected shot simply stops being replayed
 * once its seq acks, so it retracts on its own. Collision/bomb-blast both skip
 * the owner, and the only ship here is the owner, so the damage path stays inert.
 *
 * Predicted (un-acked) shots get a **negative** view id derived from their
 * spawning input `seq` so the id is stable across the per-frame rebuild and can
 * never collide with the positive server ids of seeded/remote projectiles. At the
 * ack handoff a shot's id flips negative→positive at the *same* position
 * (determinism), so it's seamless.
 */

import type { GameMap } from "../sim/gamemap";
import type { Player, PlayerId, Projectile } from "../sim/types";
import { World } from "../sim/world";
import type { SequencedInput } from "./protocol";

/** The recorded local pose after replaying up to a given input `seq`, so a later
 *  snapshot acking that `seq` can be compared against what we predicted for it. */
interface PredictedPose {
  x: number;
  y: number;
}

/** Stable, collision-proof view id for a predicted (un-acked) projectile. Keyed
 *  by the spawning input `seq` and the kind (a fire+bomb on the same tick share a
 *  seq), mapped into the negative range so it never clashes with the positive
 *  server ids carried by seeded/remote projectiles. */
function predictedProjectileId(spawnSeq: number, kind: Projectile["kind"]): number {
  return -(spawnSeq * 2 + (kind === "bomb" ? 1 : 0)) - 1;
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
  /** The latest snapshot's already-acked **local-owned** projectiles (deep-cloned),
   *  used to seed the predicted world each rebuild before replaying un-acked
   *  inputs. M2.6. */
  private authoritativeProjectiles: Projectile[] = [];

  /** The local player's predicted projectiles after the last `predict()` — the
   *  seeded (acked) shots advanced to the leading edge plus the replay-spawned
   *  (un-acked) ones. main.ts injects these into the render view. M2.6. */
  predictedProjectiles: Projectile[] = [];

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
   *  from the snapshot handler with the local player and the local-owned
   *  projectiles out of the fresh snapshot (M2.6 adds the projectiles). */
  setAuthoritative(localPlayer: Player, localProjectiles: readonly Projectile[], tick: number): void {
    this.authoritative = structuredClone(localPlayer);
    this.authoritativeProjectiles = structuredClone(localProjectiles as Projectile[]);
    this.authoritativeTick = tick;
  }

  /**
   * Rebuild the predicted local player: reset to the last authoritative pose,
   * then replay all `unacked` inputs (ascending by `seq`) through the full sim
   * pipeline. Returns the predicted local player, or `null` before the first
   * snapshot has set authoritative state.
   */
  predict(unacked: readonly SequencedInput[], localId: PlayerId): Player | null {
    if (!this.authoritative) {
      this.predictedProjectiles = [];
      return null;
    }

    // Reset to the authoritative rewind point. structuredClone so step()'s
    // in-place mutation never corrupts the stored snapshot. Seed the already-acked
    // local projectiles (M2.6) so the replay advances them to the leading edge.
    this.world.players.clear();
    this.world.players.set(localId, structuredClone(this.authoritative));
    this.world.tick = this.authoritativeTick;
    this.world.projectiles = structuredClone(this.authoritativeProjectiles);
    this.world.events.length = 0;
    // Spawn ids handed out during replay are transient — we overwrite each new
    // projectile's id with a stable negative one below — so the counter's value
    // doesn't matter; reset it only to keep it from growing without bound.
    this.world.nextProjectileId = 0;

    this.predictedPose.clear();
    for (const input of unacked) {
      // Track existing projectiles by identity so we can spot the ones this input
      // spawns (firingSystem pushes new objects; the filter in damageSystem keeps
      // survivors by reference, so survivors stay in the set).
      const before = new Set(this.world.projectiles);
      this.world.step({ inputs: new Map([[localId, input.cmd]]) });
      for (const p of this.world.projectiles) {
        if (before.has(p)) continue; // already existed — seeded or earlier spawn
        // A fresh shot from this input: tag it with the producing seq and give it
        // a stable negative view id so it's identifiable across rebuilds.
        p.spawnSeq = input.seq;
        p.id = predictedProjectileId(input.seq, p.kind);
      }
      const k = this.world.players.get(localId)!.kinematics;
      this.predictedPose.set(input.seq, { x: k.x, y: k.y });
    }

    this.predictedProjectiles = this.world.projectiles;
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
