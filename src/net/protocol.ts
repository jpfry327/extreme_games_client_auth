/**
 * Wire protocol — the messages that cross the relay (netcode §3).
 *
 * This module is **pure**: no DOM, no Node, no imports from the renderer. That's
 * deliberate — the Node relay (`server/relay.ts`) imports the very same file, so
 * client and server can never disagree about the shape of a packet. The only
 * dependency is the sim's identity/ship types.
 *
 * M2.0 uses **JSON** encoding (netcode §3: "start with a straightforward binary
 * or even JSON encoding behind protocol.ts and tighten later"). The *shape* is
 * what matters now; a binary packing pass is a contained change behind
 * `encode`/`decode`.
 */

import type { ShipType } from "../config";
import type { PlayerId, ProjectileKind, TeamId } from "../sim/types";

/** The roster fact about one player: who they are + where they are. Sent in the
 *  welcome snapshot and in each enter announcement so a joiner can place ships
 *  at their real position immediately (not a fresh spawn). */
export interface RemoteInfo {
  id: PlayerId;
  name: string;
  team: TeamId;
  shipType: ShipType;
  x: number;
  y: number;
}

/** C2S, reliable — sent once right after connect so the relay learns the
 *  joiner's identity before it announces them to the arena. */
export interface HelloMessage {
  t: "hello";
  name: string;
  team: TeamId;
  shipType: ShipType;
}

/** S2C, reliable — the relay's reply to `hello`: your assigned id + everyone
 *  already in the arena. */
export interface WelcomeMessage {
  t: "welcome";
  id: PlayerId;
  players: RemoteInfo[];
}

/** S2C, reliable — a new player joined the arena. */
export interface EnterMessage {
  t: "enter";
  player: RemoteInfo;
}

/** S2C, reliable — a player left (disconnect). */
export interface LeaveMessage {
  t: "leave";
  id: PlayerId;
}

/**
 * The weapon descriptor folded into a position packet on the tick a shot fires
 * (netcode §3) — this is what makes fires feel instant: there is no separate
 * "fire" message, and every client spawns the projectile locally from the
 * shooter's asserted pose. Kept as a nested object (not a bare `kind` string) so
 * later milestones extend it *additively*: `level` (M4 ship levels),
 * `bouncing`/`shrapLevel`/`shrap`/`alternate` (M5 items) mirror the original
 * `struct Weapons`.
 */
export interface WeaponDescriptor {
  kind: ProjectileKind; // "bullet" | "bomb"
}

/**
 * The position packet (netcode §3) — the workhorse, sent unreliable at ~10 Hz.
 * C2S it carries **no `id`** (the relay stamps the sender's id before fan-out);
 * S2C it always has one. `tick` is the sender's local sim tick, carried now and
 * used for packet-age smoothing once M2.1/M2.4 add the clock.
 *
 * `weapon` is present only on the extra packet sent the instant a shot fires
 * (M2.2); normal throttled packets omit it so a remote never double-spawns. The
 * `status` bits (stealth/cloak/flash) fold in with victim death (M2.3).
 */
export interface PositionMessage {
  t: "pos";
  id?: PlayerId; // absent C2S, stamped by the relay for S2C
  tick: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  rotation: number;
  energy: number;
  bounty: number;
  weapon?: WeaponDescriptor; // present only on the packet that announces a shot
  // status?: number;        // ← M2.3 (stealth/cloak/flash bits)
}

/** Everything that can cross the wire. Discriminated by `t`. */
export type NetMessage =
  | HelloMessage
  | WelcomeMessage
  | EnterMessage
  | LeaveMessage
  | PositionMessage;

/** Serialize a message for the transport. JSON for M2.0 (see the file header). */
export function encode(msg: NetMessage): string {
  return JSON.stringify(msg);
}

/** Parse a wire string back into a message. Throws on malformed input; callers
 *  at the socket edge should guard with try/catch and drop bad frames. */
export function decode(data: string): NetMessage {
  return JSON.parse(data) as NetMessage;
}
