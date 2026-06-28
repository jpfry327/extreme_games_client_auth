/**
 * Binary snapshot codec with field-level delta compression — M2.13.
 *
 * Replaces the JSON `Snapshot` on the WebSocket data plane. Two wins:
 *   1. **Binary** — pack floats/ints directly (no JSON text), so a snapshot is a
 *      fraction of the bytes and there's no `JSON.stringify`/`parse` per client.
 *   2. **Field-level delta** — most of a `Player` never changes tick-to-tick
 *      (name, team, ship, the whole loadout, recharge/maxEnergy, score…). Against
 *      a baseline the client already holds, we send a per-entity dirty bitmask and
 *      only the fields that actually moved. A ship cruising sends ~5 floats, not
 *      ~45 fields. Bandwidth now scales with *change*, not roster size.
 *
 * This sits behind the `serializeSnapshotFor` seam: the server still builds a
 * plain `Snapshot` (Layer A), then encodes it here; the client decodes back into
 * the identical `Snapshot` shape, so every downstream consumer (interpolator,
 * predictor, renderer) is untouched. The loopback `GameServer` keeps sending the
 * plain object — binary is purely the over-the-wire form (protocol.ts: "binary is
 * a later optimization").
 *
 * ## The acked-baseline (Quake3) model — why it's loss-robust
 *
 * The server delta-encodes against the **last snapshot the client confirmed
 * receiving** (`baselineTick`), not simply "the previous one". The client acks
 * each tick it decodes (piggybacked on its input stream); the server diffs the
 * next snapshot against that acked tick (which it kept a copy of) and stamps the
 * `baselineTick` into the frame so the client knows which of its retained
 * snapshots to apply the delta onto. If no baseline is available — a fresh join,
 * an ack not yet arrived, or a baseline aged out of either ring — the server
 * sends a **keyframe** (full state, `baselineTick = -1`). A dropped/reordered
 * snapshot therefore never corrupts the stream: the client only ever acks what it
 * has, so the server only ever diffs against something the client can decode.
 *
 * ## Quantization & bit-for-bit parity
 *
 * Floats are stored as f32 (`Math.fround`). The codec is *symmetric*: the server
 * stores, as the next baseline, the `quantizeSnapshot` of what it sent — exactly
 * what the client reconstructs by decoding. So a field the server judges
 * "unchanged" (frounded current == frounded baseline) is the field the client
 * keeps from its baseline, and they are equal. This is what makes a delta-applied
 * client world identical, bit-for-bit, to a full-snapshot one (the roadmap test).
 */

import type {
  Combat,
  GameEvent,
  Kinematics,
  Loadout,
  Player,
  PlayerId,
  Projectile,
  Resources,
  StatusEffects,
} from "../sim/types";
import type { Snapshot } from "./snapshot";
import { ByteReader, ByteWriter } from "./byteBuffer";

/** Sentinel `baselineTick` meaning "this is a keyframe — full state, no delta". */
export const KEYFRAME = -1;

/** Thrown by `decodeSnapshot` when a delta references a baseline the client no
 *  longer holds. The caller should ignore the frame and wait for the next
 *  keyframe (the server sends one whenever it can't find a valid baseline). */
export class MissingBaselineError extends Error {
  constructor(public readonly baselineTick: number) {
    super(`missing snapshot baseline at tick ${baselineTick}`);
    this.name = "MissingBaselineError";
  }
}

// --- field schema ------------------------------------------------------------
// Each entity is described as an ordered list of fields. The order is the wire
// contract: it indexes the per-entity dirty bitmask, so writer and reader walk
// the identical list. Append-only — inserting a field mid-list breaks old deltas
// (irrelevant here since both ends ship together, but keep the discipline).

type FieldKind = "f32" | "varuint" | "varinf" | "u8" | "bool" | "string" | "optstr" | "optnum";

interface FieldDef<E> {
  kind: FieldKind;
  get(e: E): unknown;
  set(e: E, v: unknown): void;
}

function writeValue(w: ByteWriter, kind: FieldKind, v: unknown): void {
  switch (kind) {
    case "f32":
      w.writeF32(v as number);
      break;
    case "varuint":
      w.writeVaruint(v as number);
      break;
    case "varinf":
      // A non-negative int OR Infinity (e.g. a bullet that bounces until its
      // lifetime ends). Encode Infinity as 0 and a finite n as n+1, so the
      // unbounded sentinel round-trips without a special varint case.
      w.writeVaruint(v === Infinity ? 0 : (v as number) + 1);
      break;
    case "u8":
      w.writeU8(v as number);
      break;
    case "bool":
      w.writeBool(v as boolean);
      break;
    case "string":
      w.writeString(v as string);
      break;
    case "optstr":
      // PlayerIds are never empty, so the empty string is a safe `null` sentinel.
      w.writeString((v as string | null) ?? "");
      break;
    case "optnum": {
      const present = v !== undefined && v !== null;
      w.writeBool(present);
      if (present) w.writeVaruint(v as number);
      break;
    }
  }
}

function readValue(r: ByteReader, kind: FieldKind): unknown {
  switch (kind) {
    case "f32":
      return r.readF32();
    case "varuint":
      return r.readVaruint();
    case "varinf": {
      const m = r.readVaruint();
      return m === 0 ? Infinity : m - 1;
    }
    case "u8":
      return r.readU8();
    case "bool":
      return r.readBool();
    case "string":
      return r.readString();
    case "optstr": {
      const s = r.readString();
      return s.length > 0 ? s : null;
    }
    case "optnum":
      return r.readBool() ? r.readVaruint() : undefined;
  }
}

/** Apply the same lossy step the wire applies: f32 fields round to single
 *  precision; everything else is exact. Idempotent (`fround∘fround = fround`),
 *  which is what lets the server's stored baseline match the client's decode. */
function quantizeValue(kind: FieldKind, v: unknown): unknown {
  return kind === "f32" ? Math.fround(v as number) : v;
}

// --- Player schema -----------------------------------------------------------

const PLAYER_FIELDS: FieldDef<Player>[] = [
  { kind: "string", get: (p) => p.name, set: (p, v) => (p.name = v as string) },
  { kind: "varuint", get: (p) => p.team, set: (p, v) => (p.team = v as number) },
  { kind: "varuint", get: (p) => p.shipType, set: (p, v) => (p.shipType = v as 0) },
  { kind: "f32", get: (p) => p.kinematics.x, set: (p, v) => (p.kinematics.x = v as number) },
  { kind: "f32", get: (p) => p.kinematics.y, set: (p, v) => (p.kinematics.y = v as number) },
  { kind: "f32", get: (p) => p.kinematics.vx, set: (p, v) => (p.kinematics.vx = v as number) },
  { kind: "f32", get: (p) => p.kinematics.vy, set: (p, v) => (p.kinematics.vy = v as number) },
  { kind: "f32", get: (p) => p.kinematics.rotation, set: (p, v) => (p.kinematics.rotation = v as number) },
  // prevX/prevY/prevRotation are deliberately NOT on the wire: the client never
  // reads a snapshot's prev* (the interpolator/simulator bake prev === current,
  // and the renderer draws view entities at alpha=1). `blankPlayer` defaults them
  // to 0; transmitting them was 3 redundant f32 per player every snapshot.
  { kind: "f32", get: (p) => p.resources.energy, set: (p, v) => (p.resources.energy = v as number) },
  { kind: "f32", get: (p) => p.resources.recharge, set: (p, v) => (p.resources.recharge = v as number) },
  { kind: "f32", get: (p) => p.resources.maxEnergy, set: (p, v) => (p.resources.maxEnergy = v as number) },
  { kind: "varuint", get: (p) => p.loadout.gunLevel, set: (p, v) => (p.loadout.gunLevel = v as 1) },
  { kind: "varuint", get: (p) => p.loadout.bombLevel, set: (p, v) => (p.loadout.bombLevel = v as 1) },
  { kind: "bool", get: (p) => p.loadout.multifire, set: (p, v) => (p.loadout.multifire = v as boolean) },
  { kind: "bool", get: (p) => p.loadout.bouncingBombs, set: (p, v) => (p.loadout.bouncingBombs = v as boolean) },
  { kind: "varuint", get: (p) => p.loadout.mines, set: (p, v) => (p.loadout.mines = v as number) },
  { kind: "varuint", get: (p) => p.loadout.bursts, set: (p, v) => (p.loadout.bursts = v as number) },
  { kind: "varuint", get: (p) => p.loadout.decoys, set: (p, v) => (p.loadout.decoys = v as number) },
  { kind: "varuint", get: (p) => p.loadout.repels, set: (p, v) => (p.loadout.repels = v as number) },
  { kind: "varuint", get: (p) => p.loadout.rockets, set: (p, v) => (p.loadout.rockets = v as number) },
  { kind: "varuint", get: (p) => p.loadout.portals, set: (p, v) => (p.loadout.portals = v as number) },
  { kind: "varuint", get: (p) => p.loadout.thors, set: (p, v) => (p.loadout.thors = v as number) },
  { kind: "varuint", get: (p) => p.loadout.bricks, set: (p, v) => (p.loadout.bricks = v as number) },
  { kind: "bool", get: (p) => p.status.stealth, set: (p, v) => (p.status.stealth = v as boolean) },
  { kind: "bool", get: (p) => p.status.cloak, set: (p, v) => (p.status.cloak = v as boolean) },
  { kind: "bool", get: (p) => p.status.xradar, set: (p, v) => (p.status.xradar = v as boolean) },
  { kind: "bool", get: (p) => p.status.antiwarp, set: (p, v) => (p.status.antiwarp = v as boolean) },
  { kind: "bool", get: (p) => p.status.multifire, set: (p, v) => (p.status.multifire = v as boolean) },
  { kind: "optnum", get: (p) => p.status.superUntil, set: (p, v) => (p.status.superUntil = v as number | undefined) },
  { kind: "optnum", get: (p) => p.status.shieldsUntil, set: (p, v) => (p.status.shieldsUntil = v as number | undefined) },
  { kind: "optnum", get: (p) => p.status.rocketUntil, set: (p, v) => (p.status.rocketUntil = v as number | undefined) },
  { kind: "varuint", get: (p) => p.combat.bounty, set: (p, v) => (p.combat.bounty = v as number) },
  { kind: "varuint", get: (p) => p.combat.score, set: (p, v) => (p.combat.score = v as number) },
  { kind: "varuint", get: (p) => p.combat.kills, set: (p, v) => (p.combat.kills = v as number) },
  { kind: "varuint", get: (p) => p.combat.deaths, set: (p, v) => (p.combat.deaths = v as number) },
  { kind: "varuint", get: (p) => p.combat.respawnAt, set: (p, v) => (p.combat.respawnAt = v as number) },
  { kind: "optstr", get: (p) => p.combat.lastHitBy, set: (p, v) => (p.combat.lastHitBy = v as PlayerId | null) },
  { kind: "varuint", get: (p) => p.combat.flagsHeld, set: (p, v) => (p.combat.flagsHeld = v as number) },
  { kind: "bool", get: (p) => p.combat.carryingBall, set: (p, v) => (p.combat.carryingBall = v as boolean) },
  { kind: "varuint", get: (p) => p.combat.bulletCooldown, set: (p, v) => (p.combat.bulletCooldown = v as number) },
  { kind: "varuint", get: (p) => p.combat.bombCooldown, set: (p, v) => (p.combat.bombCooldown = v as number) },
];

function blankPlayer(id: PlayerId): Player {
  const kinematics: Kinematics = { x: 0, y: 0, vx: 0, vy: 0, rotation: 0, prevX: 0, prevY: 0, prevRotation: 0 };
  const resources: Resources = { energy: 0, recharge: 0, maxEnergy: 0 };
  const loadout: Loadout = {
    gunLevel: 1, bombLevel: 1, multifire: false, bouncingBombs: false,
    mines: 0, bursts: 0, decoys: 0, repels: 0, rockets: 0, portals: 0, thors: 0, bricks: 0,
  };
  const status: StatusEffects = { stealth: false, cloak: false, xradar: false, antiwarp: false, multifire: false };
  const combat: Combat = {
    bounty: 0, score: 0, kills: 0, deaths: 0, respawnAt: 0, lastHitBy: null,
    flagsHeld: 0, carryingBall: false, bulletCooldown: 0, bombCooldown: 0,
  };
  return { id, name: "", team: 0, shipType: 0, kinematics, resources, loadout, status, combat };
}

// --- Projectile schema -------------------------------------------------------

const PROJ_FIELDS: FieldDef<Projectile>[] = [
  { kind: "u8", get: (p) => (p.kind === "bomb" ? 1 : 0), set: (p, v) => (p.kind = v === 1 ? "bomb" : "bullet") },
  { kind: "string", get: (p) => p.owner, set: (p, v) => (p.owner = v as string) },
  { kind: "f32", get: (p) => p.x, set: (p, v) => (p.x = v as number) },
  { kind: "f32", get: (p) => p.y, set: (p, v) => (p.y = v as number) },
  { kind: "f32", get: (p) => p.vx, set: (p, v) => (p.vx = v as number) },
  { kind: "f32", get: (p) => p.vy, set: (p, v) => (p.vy = v as number) },
  // prevX/prevY are not sent: the RemoteProjectileSimulator overwrites them with
  // the simulated pose (prev === current) and the renderer draws at alpha=1, so a
  // snapshot's projectile prev* is never read. `blankProjectile` defaults them to 0.
  { kind: "varuint", get: (p) => p.life, set: (p, v) => (p.life = v as number) },
  { kind: "varinf", get: (p) => p.bounces, set: (p, v) => (p.bounces = v as number) },
  { kind: "f32", get: (p) => p.radius, set: (p, v) => (p.radius = v as number) },
  { kind: "bool", get: (p) => p.alive, set: (p, v) => (p.alive = v as boolean) },
];

function blankProjectile(id: number): Projectile {
  return {
    id, kind: "bullet", owner: "", x: 0, y: 0, vx: 0, vy: 0,
    life: 0, bounces: 0, radius: 0, alive: true, prevX: 0, prevY: 0,
  };
}

// --- per-entity helpers (shared by quantize / copy / encode / decode) --------

/** Build a fresh entity whose every schema field is copied (and f32 fields
 *  frounded) from `src`. Used to quantize a live entity and to clone a baseline
 *  entity without aliasing it. */
function quantizeEntity<E>(src: E, id: PlayerId | number, fields: FieldDef<E>[], blank: (id: never) => E): E {
  const out = blank(id as never);
  for (const f of fields) f.set(out, quantizeValue(f.kind, f.get(src)));
  return out;
}

/** ceil(n / 8) mask bytes hold one dirty bit per field. */
function maskByteCount(fieldCount: number): number {
  return (fieldCount + 7) >> 3;
}

// --- entity section (delta or keyframe) --------------------------------------

function writeEntitySection<E>(
  w: ByteWriter,
  current: E[],
  baseline: E[] | null,
  fields: FieldDef<E>[],
  idOf: (e: E) => PlayerId | number,
  writeId: (w: ByteWriter, id: PlayerId | number) => void,
): void {
  const baseById = new Map<PlayerId | number, E>();
  if (baseline) for (const e of baseline) baseById.set(idOf(e), e);
  const curIds = new Set(current.map(idOf));

  // Removed: present in baseline, gone now. (Empty for a keyframe.)
  const removed: (PlayerId | number)[] = [];
  for (const id of baseById.keys()) if (!curIds.has(id)) removed.push(id);
  w.writeVaruint(removed.length);
  for (const id of removed) writeId(w, id);

  // Upserts: new entities (full) + changed entities (dirty fields only).
  // Unchanged entities are omitted — the client keeps them from its baseline.
  const nMask = maskByteCount(fields.length);
  const upserts: { e: E; base: E | undefined }[] = [];
  for (const e of current) {
    const base = baseById.get(idOf(e));
    if (!base) {
      upserts.push({ e, base: undefined });
      continue;
    }
    // Any field differs? (Both sides are quantized, so === is exact.)
    for (let i = 0; i < fields.length; i++) {
      if (fields[i].get(e) !== fields[i].get(base)) {
        upserts.push({ e, base });
        break;
      }
    }
  }

  w.writeVaruint(upserts.length);
  for (const { e, base } of upserts) {
    writeId(w, idOf(e));
    const isNew = base === undefined;
    w.writeBool(isNew);
    // Build the dirty mask: all-set for a new/keyframe entity, else only changed.
    const mask = new Uint8Array(nMask);
    for (let i = 0; i < fields.length; i++) {
      const dirty = isNew || fields[i].get(e) !== fields[i].get(base!);
      if (dirty) mask[i >> 3] |= 1 << (i & 7);
    }
    for (const b of mask) w.writeU8(b);
    for (let i = 0; i < fields.length; i++) {
      if (mask[i >> 3] & (1 << (i & 7))) writeValue(w, fields[i].kind, fields[i].get(e));
    }
  }
}

function readEntitySection<E>(
  r: ByteReader,
  baseline: E[] | null,
  fields: FieldDef<E>[],
  readId: (r: ByteReader) => PlayerId | number,
  idOf: (e: E) => PlayerId | number,
  blank: (id: never) => E,
  idLess: (a: PlayerId | number, b: PlayerId | number) => boolean,
): E[] {
  // Start from independent copies of the baseline so we never mutate the client's
  // retained snapshot (it's still needed as a baseline for later deltas).
  const result = new Map<PlayerId | number, E>();
  if (baseline) {
    for (const e of baseline) {
      const id = idOf(e);
      result.set(id, quantizeEntity(e, id, fields, blank));
    }
  }

  const removedCount = r.readVaruint();
  for (let i = 0; i < removedCount; i++) result.delete(readId(r));

  const nMask = maskByteCount(fields.length);
  const upsertCount = r.readVaruint();
  for (let u = 0; u < upsertCount; u++) {
    const id = readId(r);
    const isNew = r.readBool();
    const mask = new Uint8Array(nMask);
    for (let i = 0; i < nMask; i++) mask[i] = r.readU8();
    const target = isNew ? blank(id as never) : result.get(id)!;
    for (let i = 0; i < fields.length; i++) {
      if (mask[i >> 3] & (1 << (i & 7))) fields[i].set(target, readValue(r, fields[i].kind));
    }
    result.set(id, target);
  }

  // Canonical order (by id) so a delta-applied list and a keyframe list of the
  // same state compare equal regardless of the order entities were written in.
  // Every client consumer keys by id, so the order itself is immaterial to feel.
  return [...result.values()].sort((a, b) => (idLess(idOf(a), idOf(b)) ? -1 : 1));
}

const writePlayerId = (w: ByteWriter, id: PlayerId | number) => w.writeString(id as string);
const readPlayerId = (r: ByteReader): PlayerId => r.readString();
const writeProjId = (w: ByteWriter, id: PlayerId | number) => w.writeVaruint(id as number);
const readProjId = (r: ByteReader): number => r.readVaruint();

// --- events (always full — transient, per-broadcast) -------------------------

const EV_BOMB = 0;
const EV_HIT = 1;
const EV_DIED = 2;
const EV_SPAWN = 3;

function writeEvents(w: ByteWriter, events: GameEvent[]): void {
  w.writeVaruint(events.length);
  for (const e of events) {
    switch (e.type) {
      case "bombExploded":
        w.writeU8(EV_BOMB);
        w.writeF32(e.x);
        w.writeF32(e.y);
        w.writeString(e.owner);
        break;
      case "shipHit":
        w.writeU8(EV_HIT);
        w.writeString(e.target);
        w.writeString(e.by);
        w.writeF32(e.damage);
        w.writeF32(e.x);
        w.writeF32(e.y);
        w.writeBool(e.fatal);
        break;
      case "shipDied":
        w.writeU8(EV_DIED);
        w.writeString(e.victim);
        w.writeString(e.killer ?? "");
        w.writeVaruint(e.bounty);
        w.writeF32(e.x);
        w.writeF32(e.y);
        break;
      case "playerSpawned":
        w.writeU8(EV_SPAWN);
        w.writeString(e.player);
        w.writeF32(e.x);
        w.writeF32(e.y);
        break;
    }
  }
}

function readEvents(r: ByteReader): GameEvent[] {
  const n = r.readVaruint();
  const events: GameEvent[] = [];
  for (let i = 0; i < n; i++) {
    const tag = r.readU8();
    if (tag === EV_BOMB) {
      events.push({ type: "bombExploded", x: r.readF32(), y: r.readF32(), owner: r.readString() });
    } else if (tag === EV_HIT) {
      const target = r.readString();
      const by = r.readString();
      const damage = r.readF32();
      const x = r.readF32();
      const y = r.readF32();
      const fatal = r.readBool();
      events.push({ type: "shipHit", target, by, damage, x, y, fatal });
    } else if (tag === EV_DIED) {
      const victim = r.readString();
      const killer = r.readString();
      const bounty = r.readVaruint();
      const x = r.readF32();
      const y = r.readF32();
      events.push({ type: "shipDied", victim, killer: killer.length > 0 ? killer : null, bounty, x, y });
    } else {
      events.push({ type: "playerSpawned", player: r.readString(), x: r.readF32(), y: r.readF32() });
    }
  }
  return events;
}

// --- pings (always full — tiny: one entry per connected player) --------------

function writePings(w: ByteWriter, pings: Record<PlayerId, number>): void {
  const ids = Object.keys(pings);
  w.writeVaruint(ids.length);
  for (const id of ids) {
    w.writeString(id);
    w.writeVaruint(Math.max(0, Math.round(pings[id])));
  }
}

function readPings(r: ByteReader): Record<PlayerId, number> {
  const n = r.readVaruint();
  const pings: Record<PlayerId, number> = {};
  for (let i = 0; i < n; i++) {
    const id = r.readString();
    pings[id] = r.readVaruint();
  }
  return pings;
}

// --- public API --------------------------------------------------------------

/** Round a snapshot's entities through the wire's f32 quantization, returning a
 *  fresh `Snapshot`. The server stores this as the next baseline so its notion of
 *  "unchanged" matches the client's decode exactly (see the module header). Only
 *  `tick`, `players`, and `projectiles` are meaningful in a baseline; the rest is
 *  carried so the value is a complete `Snapshot`.
 *
 *  Entities are sorted by id — the same canonical order `decodeSnapshot` produces
 *  — so a server-side baseline is byte-identical to the client's decoded copy in
 *  array order too, not just field values. (Every consumer keys by id, so the
 *  order itself is immaterial to gameplay; this is purely for clean parity.) */
export function quantizeSnapshot(snap: Snapshot): Snapshot {
  const players = snap.players
    .map((p) => quantizeEntity(p, p.id, PLAYER_FIELDS, blankPlayer))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const projectiles = snap.projectiles
    .map((p) => quantizeEntity(p, p.id, PROJ_FIELDS, blankProjectile))
    .sort((a, b) => a.id - b.id);
  return { ...snap, players, projectiles };
}

/**
 * Encode `snap` (assumed already `quantizeSnapshot`-ed) to bytes, delta-compressed
 * against `baseline` (also quantized) when given, or as a keyframe when `baseline`
 * is null. The frame's header carries `baseline?.tick ?? KEYFRAME` so the decoder
 * can find the matching baseline among its retained snapshots.
 */
export function encodeSnapshot(snap: Snapshot, baseline: Snapshot | null): Uint8Array {
  const w = new ByteWriter();
  const isKeyframe = baseline === null;
  w.writeBool(isKeyframe);
  w.writeVaruint(snap.tick);
  // baselineTick: encoded as tick+1 so the KEYFRAME sentinel (-1) maps to 0 and we
  // can keep using the unsigned varint. Read back with -1.
  w.writeVaruint((isKeyframe ? KEYFRAME : baseline!.tick) + 1);
  w.writeVaruint(snap.lastProcessedInputSeq);
  w.writeVaruint(snap.inputBufferDepth);

  writeEntitySection(w, snap.players, baseline?.players ?? null, PLAYER_FIELDS, (p) => p.id, writePlayerId);
  writeEntitySection(w, snap.projectiles, baseline?.projectiles ?? null, PROJ_FIELDS, (p) => p.id, writeProjId);
  writeEvents(w, snap.events);
  writePings(w, snap.pings);

  return w.bytes().slice(); // detach from the writer's (possibly larger) buffer
}

/** Read the frame header without decoding the body — lets the client look up the
 *  baseline tick it must apply the delta against. */
export function peekSnapshotHeader(bytes: Uint8Array): { tick: number; baselineTick: number; isKeyframe: boolean } {
  const r = new ByteReader(bytes);
  const isKeyframe = r.readBool();
  const tick = r.readVaruint();
  const baselineTick = r.readVaruint() - 1;
  return { tick, baselineTick, isKeyframe };
}

/**
 * Decode bytes back into a `Snapshot`. For a delta frame, `lookupBaseline` is
 * called with the frame's `baselineTick` and must return the previously-decoded
 * snapshot at that tick; if it returns undefined a `MissingBaselineError` is
 * thrown (the caller waits for the next keyframe). Keyframes ignore the lookup.
 */
export function decodeSnapshot(
  bytes: Uint8Array,
  lookupBaseline: (tick: number) => Snapshot | undefined,
): Snapshot {
  const r = new ByteReader(bytes);
  const isKeyframe = r.readBool();
  const tick = r.readVaruint();
  const baselineTick = r.readVaruint() - 1;
  const lastProcessedInputSeq = r.readVaruint();
  const inputBufferDepth = r.readVaruint();

  let baseline: Snapshot | null = null;
  if (!isKeyframe) {
    baseline = lookupBaseline(baselineTick) ?? null;
    if (!baseline) throw new MissingBaselineError(baselineTick);
  }

  const players = readEntitySection(
    r, baseline?.players ?? null, PLAYER_FIELDS, readPlayerId,
    (p) => p.id, blankPlayer, (a, b) => (a as string) < (b as string),
  );
  const projectiles = readEntitySection(
    r, baseline?.projectiles ?? null, PROJ_FIELDS, readProjId,
    (p) => p.id, blankProjectile, (a, b) => (a as number) < (b as number),
  );
  const events = readEvents(r);
  const pings = readPings(r);

  return { tick, players, projectiles, events, lastProcessedInputSeq, inputBufferDepth, pings };
}
