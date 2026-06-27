/**
 * RelayHost — the server side of the client-authoritative ("defender authority")
 * relay model, shared by the in-process `GameServer` (loopback) and the headless
 * WebSocket server (`server/index.ts`).
 *
 * The server is a **mirror + scoreboard relay**, not a combat authority. It:
 *   - **Mirrors** each human: a `StateReportMsg` overwrites that human's
 *     client-owned fields (pose/energy/status/loadout/bounty/deaths/respawnAt) and
 *     preserves the server-owned scoreboard fields (kills/score).
 *   - **Defends its bot**: the bot is a `LocalSim` (the same self-simulator the
 *     client runs) living in the mirror world — only the bot is `defends`-owned, so
 *     only it moves/fires/dies here. The bot's AI aims at the human mirrors;
 *     incoming human shots are injected and adjudicated against the bot. When the
 *     bot dies, `deathSystem` (scoresKills=true) credits the human killer inline.
 *   - **Scores human deaths** from `DeathReportMsg` ("defender names the killer"):
 *     `creditKill` updates the killer's scoreboard and a relayed `shipDied` rides
 *     the snapshot to everyone (kill feed + explosion). Re-sends are deduped by the
 *     victim's monotonic death count.
 *   - **Assembles snapshots** from the mirror world (bot + human mirrors) + each
 *     owner's reported shots, so the unchanged downstream stack (codec/AOI/delta/
 *     interpolation) is reused verbatim — only the *source* of the rows changed.
 */

import { RELAY, TICK_DT, WARBIRD, type ShipType } from "../config";
import { BOT_ID, BOT_NAME, computeBotInput } from "../sim/bot";
import { createPlayer } from "../sim/player";
import { findSpawn } from "../sim/spawn";
import { creditKill } from "../sim/systems/death";
import type { GameMap } from "../sim/gamemap";
import type { GameEvent, InputCommand, Player, PlayerId, Projectile } from "../sim/types";
import { LocalSim } from "./localSim";
import type { DeathReportMsg, StateReportMsg } from "./protocol";
import type { InputAck, Snapshot } from "./snapshot";

/** Spiral-of-death clamp on a single advance (matches FixedLoop). */
const MAX_FRAME = 0.25;

/** Per-owner id namespace so projectile ids stay globally unique across owners
 *  without a remap table: `slot * BASE + clientProjectileId`. The bot is slot 0,
 *  humans are 1, 2, … A client's projectile-id counter never approaches BASE. */
const SLOT_BASE = 100_000_000;

/** Per-human relay bookkeeping. */
interface HumanState {
  /** Id-namespace slot (≥ 1) for this owner's projectiles. */
  slot: number;
  /** Highest `StateReportMsg.seq` accepted — older/out-of-order reports are dropped. */
  lastSeq: number;
  /** This owner's latest reported live shots, remapped to server-unique ids — what
   *  the snapshot relays to everyone else. */
  shots: Projectile[];
  /** Highest victim death-count already scored, so a re-sent `DeathReportMsg`
   *  (the client re-sends every report-tick while dead) is scored at most once. */
  scoredDeaths: number;
  /** `Date.now()` of the last accepted state report. When this goes stale past
   *  `RELAY.inactiveTimeoutMs` the client is "away" (its tab is backgrounded and
   *  its self-sim has stalled) and its frozen ship is dropped from broadcasts —
   *  the defender model can't kill a sleeping ship, so we hide it instead. */
  lastReportMs: number;
}

export class RelayHost {
  /** The bot's authoritative self-sim; its world doubles as the mirror world
   *  (holds the bot + every human mirror). */
  private readonly botSim: LocalSim;
  private readonly humans = new Map<PlayerId, HumanState>();
  /** Relayed `shipDied` events from human death reports, drained each broadcast
   *  alongside the bot sim's own events. */
  private readonly relayEvents: GameEvent[] = [];
  private nextSlot = 1;
  private accumulator = 0;

  constructor(map: GameMap, seed = 1) {
    // The bot is the only defended player; scoresKills=true so a human killing the
    // bot is credited inline by deathSystem.
    this.botSim = new LocalSim(map, [BOT_ID], seed, true);
    const spawn = findSpawn(map, this.botSim.world.rng);
    this.botSim.addOwned(BOT_ID, BOT_NAME, 1, WARBIRD, spawn.x, spawn.y);
  }

  private get world() {
    return this.botSim.world;
  }

  /** Pick a spawn for a joining human (the server assigns the initial pose, sent in
   *  `welcome`, so the mirror/AOI have a position before the first report). */
  pickSpawn(): { x: number; y: number } {
    return findSpawn(this.world.map, this.world.rng);
  }

  /** Register a joining human as a mirror player at the assigned spawn. */
  addHuman(id: PlayerId, name: string, team: number, shipType: ShipType, x: number, y: number): void {
    this.world.players.set(id, createPlayer(id, name, team, shipType, x, y));
    // Seed lastReportMs to now so the fresh join has a grace window before its
    // first report rather than being treated as "away" immediately.
    this.humans.set(id, {
      slot: this.nextSlot++,
      lastSeq: 0,
      shots: [],
      scoredDeaths: 0,
      lastReportMs: Date.now(),
    });
  }

  removeHuman(id: PlayerId): void {
    this.world.players.delete(id);
    this.humans.delete(id);
  }

  /** Apply a human's authoritative state report into its mirror, and inject its
   *  reported shots (remapped to server-unique ids) for the bot to adjudicate. */
  ingestState(id: PlayerId, report: StateReportMsg): void {
    const human = this.humans.get(id);
    const mirror = this.world.players.get(id);
    if (!human || !mirror) return;
    if (report.seq <= human.lastSeq) return; // stale / out-of-order (newest wins)
    human.lastSeq = report.seq;
    human.lastReportMs = Date.now(); // fresh report → this client is active

    mergeReport(mirror, report.player);

    // Remap this owner's shots into its id namespace (globally unique), store for
    // the snapshot, and inject the fresh ones into the bot's sim for adjudication.
    const shots = report.projectiles.map((p) => remapProjectile(p, human.slot));
    human.shots = shots;
    this.botSim.injectIncoming(shots);
  }

  /** Score a human's self-reported death (defender names the killer) and relay it.
   *  Deduped by the victim's death count so re-sends are scored once. */
  ingestDeath(report: DeathReportMsg): void {
    const human = this.humans.get(report.victim);
    if (!human) return;
    if (report.deaths <= human.scoredDeaths) return; // already scored this death
    human.scoredDeaths = report.deaths;

    creditKill(this.world, report.killer, report.victim, report.bounty);
    this.relayEvents.push({
      type: "shipDied",
      victim: report.victim,
      killer: report.killer,
      bounty: report.bounty,
      x: report.x,
      y: report.y,
    });
  }

  /** Advance the bot's self-sim at 100Hz (the only thing the server simulates). */
  advance(dtSeconds: number): void {
    this.accumulator += Math.min(dtSeconds, MAX_FRAME);
    while (this.accumulator >= TICK_DT) {
      const input = new Map<PlayerId, InputCommand>([[BOT_ID, computeBotInput(this.world, BOT_ID)]]);
      this.botSim.step(input);
      this.accumulator -= TICK_DT;
    }
  }

  /** The per-client input-ack the snapshot carries — in the relay model this is the
   *  newest state-report seq we've accepted from that client (overlay only). */
  ack(id: PlayerId): InputAck {
    return { lastProcessedInputSeq: this.humans.get(id)?.lastSeq ?? 0, inputBufferDepth: 0 };
  }

  /** Assemble the shared, unfiltered snapshot from the mirror world: every player
   *  (bot + human mirrors), the bot's own shots + every human's reported shots
   *  (all id-namespaced), and this window's events. The caller AOI-filters and
   *  encodes it per client, then calls `clearEvents()`. */
  assembleSnapshot(pings: Record<PlayerId, number> = {}): Snapshot {
    // An "away" human (its tab backgrounded and self-sim stalled past the timeout)
    // is dropped from the broadcast entirely — both its frozen mirror row and its
    // stale shots — so it stops being an unkillable target for everyone else. The
    // per-client baseline ring sees it leave as a normal delta removal (clean
    // despawn) and re-add when it wakes. The bot is never in `humans`, so it's
    // always present.
    const now = Date.now();
    const isActive = (id: PlayerId): boolean => {
      const human = this.humans.get(id);
      return !human || now - human.lastReportMs <= RELAY.inactiveTimeoutMs;
    };

    const projectiles: Projectile[] = this.botSim.ownProjectiles().map((p) => remapProjectile(p, 0));
    for (const [id, human] of this.humans) {
      if (isActive(id)) projectiles.push(...human.shots);
    }

    return {
      tick: this.world.tick,
      players: [...this.world.players.values()].filter((p) => isActive(p.id)),
      projectiles,
      events: [...this.world.events, ...this.relayEvents],
      lastProcessedInputSeq: 0,
      inputBufferDepth: 0,
      pings,
    };
  }

  /** Drain the events carried by the just-sent snapshot (mirrors the old
   *  `world.events.length = 0` after broadcast). */
  clearEvents(): void {
    this.world.events.length = 0;
    this.relayEvents.length = 0;
  }
}

/** Copy a client's authoritative (client-owned) fields into its server mirror,
 *  preserving the server-owned scoreboard fields (kills, score). The `combat`
 *  block is rebuilt with a spread (not assigned by reference) so this never
 *  mutates the caller's `reported.combat` — important on the loopback path where
 *  the report aliases the client's live `LocalSim` player. */
function mergeReport(mirror: Player, reported: Player): void {
  const { kills, score } = mirror.combat;
  mirror.name = reported.name;
  mirror.team = reported.team;
  mirror.shipType = reported.shipType;
  mirror.kinematics = reported.kinematics;
  mirror.resources = reported.resources;
  mirror.loadout = reported.loadout;
  mirror.status = reported.status;
  mirror.combat = { ...reported.combat, kills, score };
}

/** Shallow clone of a projectile with its id moved into its owner's id namespace,
 *  so ids are globally unique without a remap table (see SLOT_BASE). */
function remapProjectile(p: Projectile, slot: number): Projectile {
  return { ...p, id: slot * SLOT_BASE + p.id };
}
