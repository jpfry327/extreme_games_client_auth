/**
 * Wire protocol — message shapes for the client-authoritative ("defender
 * authority") relay model.
 *
 * The client owns its ship and sends its **authoritative state** (`StateReportMsg`)
 * plus a **death report** when it dies — the inverse of the old "client sends
 * intent" rule. The server is a mirror/scoreboard relay: it ingests reports, runs
 * only its own bot, and pushes per-client binary delta snapshots (encoded by
 * `snapshotCodec.ts`, not the JSON shapes here). Control messages (hello/welcome/
 * reject) are JSON text frames; snapshots are binary frames.
 */

import type { Player, PlayerId, Projectile } from "../sim/types";

// --- Client → Server ---

/** First message from a new connection. Server responds with `welcome`. */
export interface HelloMsg {
  type: "hello";
  name: string;
}

/**
 * The client's authoritative state report (primary uplink). The client owns its
 * ship, simulates it locally, and reports its state; the server mirrors it into
 * `world.players[id]` and relays it via the snapshot path, never simulating the
 * human's combat.
 */
export interface StateReportMsg {
  type: "state";
  /** Monotonic per client. Lets the server drop a stale / out-of-order datagram
   *  (UDP-style: newest wins) without per-tick replay. */
  seq: number;
  /** The reporting client's sim tick when sampled — overlay/debug only. */
  tick: number;
  /** The client's own authoritative `Player`. The server merges only the
   *  **client-owned** fields (kinematics, resources, status, loadout,
   *  combat.bounty / .deaths / .respawnAt) and preserves its own **server-owned**
   *  scoreboard fields (combat.kills, combat.score) untouched. */
  player: Player;
  /** The client's own live projectiles — it owns its shots; the server relays
   *  them, reassigning server-unique ids so ids stay unique across owners. */
  projectiles: Projectile[];
  /** M2.13 acked-baseline tick: drives the server's per-client delta baseline via
   *  `SnapshotChannel.onAck`. Absent until the first snapshot is decoded. */
  ackSnapshotTick?: number;
}

/**
 * Death report — sent when the client's own ship dies on its screen. "Defender
 * names the killer": the dying client reports who killed it and what its bounty
 * was worth; the server trusts it, credits the kill (`creditKill`), and emits the
 * relayed `shipDied` for the kill feed / explosion everywhere. Trivially cheatable
 * by design (anti-cheat deferred).
 */
export interface DeathReportMsg {
  type: "death";
  /** The dying client's own id (the victim). */
  victim: PlayerId;
  /** The victim's monotonic death count *after* this death (= `combat.deaths`).
   *  Doubles as the death's identity: the client re-sends this report every
   *  report-tick while dead (so a dropped datagram is covered without an ack), and
   *  the server scores a given `deaths` value at most once per victim. */
  deaths: number;
  /** Owner of the killing weapon, or null for a self-inflicted / uncredited death. */
  killer: PlayerId | null;
  /** The victim's bounty at death — what the kill was worth (scored to killer). */
  bounty: number;
  x: number;
  y: number;
}

export type ClientMsg = HelloMsg | StateReportMsg | DeathReportMsg;

// --- Server → Client ---

/** Server's reply to `hello` — assigns the player's canonical id and the spawn the
 *  server picked for it. The client seeds its `LocalSim` local player at this pose
 *  (and with `seed`) so client and server agree on the start state before the first
 *  state report. The client must wait for this before starting the game loop. */
export interface WelcomeMsg {
  type: "welcome";
  playerId: PlayerId;
  /** Server-assigned initial spawn. */
  spawnX: number;
  spawnY: number;
  /** Seed for the client's `LocalSim` RNG (respawn spawn-point picks). */
  seed: number;
}

/** Server's refusal of a `hello` — e.g. the arena is at its player cap (M2.7).
 *  Sent in place of `welcome`; the server then closes the socket. The client
 *  shows `reason` and stops, rather than hanging forever in "connecting…". */
export interface RejectMsg {
  type: "reject";
  reason: string;
}

/** JSON server→client control messages. Snapshots are *binary* frames (the codec),
 *  not part of this union. */
export type ServerMsg = WelcomeMsg | RejectMsg;
