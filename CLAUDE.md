# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # Vite dev server at http://localhost:5173
npm run server       # Node headless game server (tsx --watch server/index.ts)
npm run build        # TypeScript typecheck + production build
npm run preview      # Serve the production build
npm test             # Run tests once (vitest run)
npm run test:watch   # Run tests in watch mode
```

Run a single test file: `npx vitest run src/sim/sim.test.ts`

## Architecture

Read `docs/architecture.md` for the full contract. Every feature must fit the four-layer model before being written.

### The golden rule

**`src/sim/` is pure game logic — no Pixi, no DOM, no `Math.random()`.**  
The same sim code runs on the browser client and the Node headless server. Any import of `pixi.js` or DOM APIs in `sim/` breaks this.

### The four layers

| Layer | Where | Rule |
|---|---|---|
| **A — Sim state** (`sim/types.ts`) | Server-authoritative | Plain, JSON-serializable data. No methods. |
| **B — Sim systems** (`sim/systems/`, `sim/world.ts`) | Server | Pure `(world, ctx) → void` functions. No I/O. No randomness outside `world.rng`. |
| **C — Events** (`world.events`) | Server → client | Transient, fire-and-forget, drained each frame. Never stored in snapshots. |
| **D — Client** (`render/`, `input/`, future `ui/`, `audio/`) | Client only | Reads Layer A + drains Layer C. Never mutates sim state directly; sends `InputCommand`s instead. |

### Tick pipeline

`World.step()` runs at a fixed **100Hz**. It is an explicitly ordered list of systems — the order is a design decision, not an implementation detail:

```
1. intent       2. movement     3. firing       4. items
5. projectiles  6. collision    7. damage       8. death/respawn
9. status       10. resources   11. prizes      12. objectives
13. regions     14. (events accumulated → client drains)
```

Steps 7–8 (damage / death / respawn) are the keystone for all competitive features.

### Data model highlights

- `World.players: Map<PlayerId, Player>` — never a singleton `ship`.
- `Player` is grouped components: `kinematics`, `resources`, `loadout`, `status`, `combat`.
- `Projectile` carries a stable server-assigned `id` for snapshot diffing.
- `world.events: GameEvent[]` — produced by systems, drained by the renderer and audio each frame.
- `world.rng` — seeded deterministic RNG; never `Math.random()` in sim. Determinism is a hard requirement for client-side prediction.

### Config

`src/config.ts` is the source of truth for every tunable gameplay number, ported from `original_data/extreme_games_config.ini`. The file documents unit conversions. Config grows into `SHIPS: Record<ShipType, ShipConfig>` tables as the 8 ships are added (M4).

### Networking shape (`src/net/`)

Three wire message types. Control/input is JSON text; snapshots are a **binary,
delta-compressed** frame as of M2.13 (see Current milestone status):
1. **`InputCommand`** (client → server) — player intent; never state. JSON.
2. **`Snapshot`** (server → client) — serialized Layer A state. Because Layer A is plain data, the snapshot essentially *is* the world. Sent as a binary delta against the client's acked baseline (`net/snapshotCodec.ts`); the loopback path still passes the plain object.
3. **`GameEvent[]`** (server → client) — Layer C, for effects/audio/kill-feed (carried in the snapshot frame).

`Transport` is an interface (`src/net/transport.ts`); `LoopbackTransport` and `WebSocketTransport` are interchangeable implementations. Swapping them is a one-line change in `main.ts`.

Snapshots are **per-client** (`serializeSnapshotFor(world, playerId)`), which is where stealth/AOI culling will live. Build this seam per-client even when first version sends everyone everything.

### Render / interpolation

- `FixedLoop` in `sim/loop.ts` accumulates real elapsed time and drives exact 10ms sim steps.
- The renderer runs per `requestAnimationFrame`, interpolating between `prevX/prevY/prevRotation` (previous tick) and current state using the leftover `alpha`.
- For remote players under the multiplayer transport, this same mechanism extends to interpolating between buffered server snapshots with `interpDelay` (~100ms).

## Current milestone status

Per `docs/roadmap.md`, the full standard netcode model (M2.0–M2.10) is complete, and
the M2.11+ responsiveness/efficiency pass is underway. The sequence is:
```
M0 ✓ → M1 ✓ → M2.0–M2.10 ✓ (full netcode model)
     → M2.11 ✓ (measure & tune) → M2.12 ✗ (UDP transport — SKIPPED) → M2.13 ✓ binary+delta
     → M2.14 AOI/stealth → M2.15 input batching → M3 (UI) → ...
```

The three legs of the model: **client prediction** (own ship/shots at present — M2.4/M2.6),
**entity interpolation** (remotes smoothed in the past — M2.2/M2.8), and **lag compensation**
(server rewinds targets to the firer's view — M2.9).

M2.9 makes a shot that *visually connects* on the firer's screen actually register, fixing
"eaten bombs" (a remote ship is drawn ~`interpDelayMs` in the past, but collision tested the
present, so shots sailed through the drawn ghost). The pieces:
- **`sim/history.ts`** (`TickHistory`): a runtime-only `world.history` ring (`LAGCOMP.historyTicks`
  = 120t) of each player's `{x, y, radius, alive}`, recorded at the end of every `World.step()`.
  Never serialized — only the authoritative server accrues it.
- **`InputCommand.renderTick`**: the server tick the client's render view corresponded to when it
  sampled the command (`SnapshotInterpolator.renderTick()`, stamped in `main.ts`). The rewind rides
  *in the input*, so the server stays a pure function of its inputs — determinism holds.
- **`Projectile.compTicks`**: `firingSystem` stamps `spawnTick − renderTick` (clamped to
  `LAGCOMP.maxCompTicks` = 25t = 250ms and the history length) onto each shot; it carries for the
  shot's whole life so every flight-tick `collisionSystem` overlap test reaches `compTicks` into the
  past. The shot still *flies* in the present; only the *overlap test* rewinds.
- **Scope:** both projectile *direct-hit* detection (`collisionSystem`) and bomb *splash*
  (`detonateBomb`) are lag-compensated to the shot's `compTicks` — the splash had to be, since a
  Subspace bomb does all its damage via splash and a present-based blast on the ghost does ~zero
  damage to a mover. Hits/damage stay 100% server-authoritative — no predicted kills, no rollback of
  consequences. `ShipHitEvent.rewound` flags rewind hits.

The netcode debug overlay is at M2.11. Alongside the M2.5 `smooth off Npx` / `netsim …` and
M2.9 `lagcomp Nt (~Nms) rewind hits N` lines, it has a **link-health** block: snapshot
interval + jitter, the live→target adaptive interp delay and buffer depth, and per-second
rates for snapshot loss/stale and extrapolation/freeze/comp-clamp events. `compTicks` shows
`CLAMPED` when the desired rewind exceeds `LAGCOMP.maxCompTicks` (shots under-compensated).

M2.11 also: **raised `LAGCOMP.maxCompTicks` 15t→25t (250ms)** so a ~100ms-RTT shot's full view
delay (`interpDelayMs` + RTT ≈ 175ms) is covered rather than clamped (the "bombs hit but don't
register" bug); **made the interpolation delay adaptive** (`net/adaptiveInterp.ts`, driven by
`net/netHealth.ts`) so a jittery link stops starving the buffer; and reconciled the
broadcast-rate doc drift (~33Hz, not 20Hz).

M2.13 replaces the JSON snapshot on the WebSocket data plane with a **binary, field-level
delta** codec (M2.12 UDP was skipped). The seam is unchanged: the server still builds a plain
`Snapshot` (Layer A); `net/snapshotCodec.ts` encodes it to bytes and the client decodes it back
to the identical shape, so the interpolator/predictor/renderer are untouched. The loopback
`GameServer` still passes the plain object — binary is purely the wire form. Pieces:
- **`net/byteBuffer.ts`** — `ByteWriter`/`ByteReader` primitives (LEB128 varint, f32, bool,
  string). `writeVaruint` throws on a non-finite value (a bullet's `bounces` is `Infinity`,
  which would otherwise loop forever); the `bounces` field uses a dedicated `varinf` kind that
  round-trips `Infinity`.
- **`net/snapshotCodec.ts`** — a schema-driven codec. Each `Player`/`Projectile` is an ordered
  field list indexing a per-entity dirty bitmask; a delta writes only changed fields, a keyframe
  writes all. Floats are quantized to f32, and the codec is *symmetric* (`quantizeSnapshot` =
  what the client decodes), so a delta-applied world equals a full-snapshot one bit-for-bit.
  Only players/projectiles are delta'd; tick/ack/events/pings ride in full (tiny).
- **Acked-baseline (Quake3) model** — the client piggybacks the newest tick it decoded on its
  input stream (`InputMsg.ackSnapshotTick`); the server (`net/serverSnapshots.ts`
  `SnapshotChannel`) delta-encodes the next snapshot against that baseline, or sends a keyframe
  when none is usable (fresh join / lost ack / aged-out / a ~60-broadcast periodic interval).
  Loss-robust: the client only acks what it holds, so the server only diffs against something
  decodable. Snapshots are WebSocket **binary** frames; control messages stay JSON **text**
  frames; the transport tells them apart by frame type.
- **Server CPU** — the old per-client `structuredClone` is gone: one shared snapshot is built
  from the live world and quantized **once** per broadcast (the next baseline), then encoded per
  client (O(players × clients) clone → one O(players) quantize).

## Key constraints

- **No ECS library.** Plain arrays of structs + ordered system functions. ECS indirection fights snapshotting and determinism.
- **Entities stay plain data; behavior lives in systems.** Methods on entities make snapshotting harder.
- **UI is bitmap-font-in-Pixi, not DOM.** The original font PNGs are rendered via Pixi `BitmapText` to stay pixel-identical with the game art at any scale. A hidden DOM `<input>` handles text entry only.
- **Per-client snapshots from day one.** Even if first version sends everyone everything, the `serializeSnapshotFor(world, playerId)` seam must exist.
