# Roadmap

> **⚑ Netcode pivot (post-M2.12 decision gate taken).** The project has switched from
> server-authoritative netcode to the original Subspace **client-authoritative ("defender
> authority") relay model**: each node simulates only the ships it owns, the server is a
> mirror/scoreboard relay, and **the defending client decides its own death**. The client
> now sends *state*, not intent. Server-side prediction, reconciliation, and lag
> compensation are retired; the snapshot/AOI/interpolation stack is kept. See the pivot
> section in `CLAUDE.md` and the design in `net/localSim.ts` / `net/relayHost.ts`.
> Anti-cheat is deferred. The M2 material below is retained as pre-pivot history.

The build order. Each milestone is sequenced by **dependency** and ends in a
**playable build** — never a half-wired refactor you can't run. Features are
sequenced so the **shared systems** (damage, status, items, UI toolkit) land
before the many features that ride on them (see the reuse map in
[feature-catalog.md](feature-catalog.md)).

This doc is written so a **cold future session** can pick up any milestone from
here alone: each has a goal, what it unlocks, a concrete scope checklist, what's
explicitly *out* of scope (to keep it tight), and the playable end state. Always
read [architecture.md](architecture.md) first — it's the contract.

## Principles for every milestone

- **End playable.** Every milestone produces a build you can run and feel.
- **Stay net-ready.** Build against the multiplayer-shaped state from M0 even
  before the network exists. Never assume one player.
- **Config-driven.** New numbers go in `config.ts` / the ship tables, never
  inline. Source of truth is the EG `.ini`.
- **Sim stays pure & deterministic.** No Pixi/DOM/`Math.random()` in `sim/`.
  This is what makes the sim **unit-testable** — write tests for damage,
  collision, and physics; determinism means they're stable.
- **Sequence shared systems before their riders.** Don't build mines before the
  damage path; don't build chat before the UI toolkit.

---

## Sequencing at a glance

```
M0  Foundational refactor ........ multiplayer-shaped sim (no new gameplay)
M1  Combat core .................. damage/death/respawn/bounty (vs local bot)   ← keystone
M2  Multiplayer + netcode ........ server + snapshots + the full 3-leg model    ← model ✓; M2.11+ = responsiveness/efficiency
M3  Client surfaces / UI ......... bitmap-font toolkit, chat, statbox, minimap
M4  All 8 ships .................. from config + sheets + ship select
M5  Special items & status ....... repel, burst, mines, toggles, super/shields
M6  Lobby polish ................. full statbox, menu, kill feed, sound, "max ship" mode
─── Phase 1 complete: a joinable, persistent EG-style lobby ───
P2  Competitive ................. flags/baseduel, powerball, bricks/doors, matchmaking, accounts
```

**Why this order:** combat (M1) is the keystone everything competitive needs, and
it can be validated cheaply against a local bot *before* netcode. Networking (M2)
is the project's biggest unknown — "does server-authoritative + prediction feel
good?" — so it comes early, while scope is still just Warbird + bullets/bombs.
Everything after rides on systems already proven.

---

## M0 — Foundational refactor

**Goal:** move the prototype onto the multiplayer-shaped architecture with **zero
gameplay change** — it still plays exactly like today, one local Warbird.

**Unlocks:** literally everything else. Every later feature assumes this shape.

**Scope:**
- [ ] `World.ship` → `players: Map<PlayerId, Player>`; grouped components
      (`kinematics/resources/loadout/status/combat`) per [arch §2](architecture.md).
- [ ] `step(input)` → `step(ctx)` where `ctx` carries per-player `InputCommand`s.
- [ ] Split the inlined `step()` into an **ordered system pipeline** under
      `sim/systems/` (start with `movement`, `firing`, `projectiles`). Document
      the order at the call site.
- [ ] Tag each `Projectile` with an owner `PlayerId`.
- [ ] Add `sim/rng.ts` (seeded) — no `Math.random()` in sim.
- [ ] Generalize `SHIP`/`BULLET`/`BOMB` consts → `SHIPS: Record<ShipType, ShipConfig>`
      tables in `config.ts` (only Warbird filled in for now, with Initial+Maximum).
- [ ] Renderer iterates `players`/`projectiles` collections instead of singletons.

**Out of scope:** any new feature, any second player, any new ship.

**Playable end state:** indistinguishable from today's prototype — but the
codebase is now ready for everything. (Good place for first sim unit tests.)

**Refs:** architecture §2, §3, §7.

---

## M1 — Combat core (the keystone)

**Goal:** make ships killable. Hit registration → damage → death → respawn →
bounty/points. Validate it **single-process against a local dev bot**.

**Unlocks:** kills, bounty, scoreboard, kill feed, flags, KotH — the entire
competitive half of the catalog. The prototype currently can't register a hit.

**Why a bot, not netcode yet:** damage is a pure sim system; it doesn't care
whether the second player's `InputCommand`s come from the network or a local AI.
A dummy/bot target validates combat feel cheaply, and — per your Chaos Zone
screenshot (ChaosBot0–8) — **lobby bots are a real feature**, so this code isn't
throwaway; it grows into lobby AI filler.

**Scope:**
- [ ] `systems/collision.ts`: projectile↔ship (use ship `Radius`).
- [ ] `systems/damage.ts`: apply bullet/bomb damage to `energy`; bomb radius
      (`BombExplodePixels`), proximity trigger. Emit `shipHit`.
- [ ] `systems/death.ts`: energy ≤ 0 → death; kill credit, bounty transfer
      (`BountyIncreaseForKill`), points (`killPoints`). Emit `shipDied`.
- [ ] `systems/respawn.ts`: respawn timer (`EnterDelay`), spawn points (`[Spawn]`).
- [ ] A trivial `Bot` that emits `InputCommand`s as a second player.
- [ ] Minimal on-screen kill feed + death explosion (reuse explode0–2/empburst).

**Out of scope:** networking, other ships, items, polished statbox, real AI.

**Playable end state:** you fight a bot — bullets/bombs hurt, you die, explode,
respawn; bounty and points tick; a kill line appears.

**Refs:** catalog §5; architecture §3 (pipeline steps 6–8), §4.

---

## M2 — Multiplayer transport & the full netcode model  ✓

**Goal:** the authoritative server runs the sim headless; browsers connect and
fight on it with prediction-smooth own-ship movement, instant-feeling weapons,
smoothly interpolated opponents, and server-side lag compensation so a shot that
visually connects on your screen actually registers.

**Status: model complete.** Built across eleven individually-runnable slices
(M2.0–M2.10). Summarized below; the per-slice detail lives in git history. The
**responsiveness & efficiency pass** that follows (M2.11–M2.15) is the still-open
work — the model is correct but, over the real internet, not yet as good as
original Subspace.

**What shipped (M2.0–M2.10):**
- **Loopback seam (M2.0):** client↔server split *in-process* first — a separate
  authoritative `World` (server) and a never-stepped *view* `World` (client),
  `serializeSnapshotFor`/`applySnapshot`, stable projectile ids.
- **WebSocket transport + headless server (M2.1):** Node server steps at 100Hz,
  broadcasts at ~33Hz; `WebSocketTransport` behind the `Transport` interface; JSON
  wire protocol (hello/welcome/input/snapshot).
- **Entity interpolation (M2.2):** remote players rendered `interpDelayMs` in the
  past, lerped between buffered snapshots; buffer-starvation extrapolate-then-freeze.
- **Input sequencing + acks (M2.3):** one seq-stamped command per sim tick; server
  per-player input buffer (repeat-last on a gap); ack stamped on each snapshot;
  netcode debug overlay.
- **Client prediction + reconciliation (M2.4):** local ship rewind-and-replay
  against the ack every frame; a prediction-error meter proves determinism parity.
- **Correction smoothing + condition hardening (M2.5):** decaying render-offset so
  corrections ease instead of snapping; in-transport network simulator
  (latency/jitter/loss); determinism integration test.
- **Own-weapon prediction (M2.6):** local shots spawn instantly and reconcile to
  their server twin; no predicted kills.
- **Identity, server-side bot, join/leave + sanity caps (M2.7).**
- **Deterministic remote-projectile simulation (M2.8):** other players' bullets
  simulated locally so wall bounces don't teleport.
- **Server-side lag compensation (M2.9):** a `world.history` pose ring; the rewind
  rides in `InputCommand.renderTick` → `Projectile.compTicks`; both direct-hit and
  bomb splash are rewound; hits stay 100% server-authoritative.
- **Predicted own-bomb explosions (M2.10):** local detonation effects drawn
  instantly, deduped against the delayed server copy.

**The model in one paragraph:** the server is the single source of truth at 100Hz.
The client holds a *predicted* world (own ship + own shots, at present) and a
*view* world (everyone else, interpolated ~`interpDelayMs` in the past). The server
rewinds targets to the firer's view to adjudicate hits. All three legs of the
standard model — **prediction**, **interpolation**, **lag compensation** — are in
place and covered by determinism tests.

**Refs:** architecture §5, §5.1, §5.2.

---

## M2 netcode — responsiveness & efficiency pass

The M2.0–M2.10 model is *correct*, but on the live Railway deployment over real
internet (~90–100ms RTT) it is **not yet playable**: shots that visually connect
get eaten, remote ships jump, own bombs feel delayed, and the whole thing reads as
laggy rather than like original Subspace. Two root causes:

1. **Transport.** Snapshots ride **TCP** (WebSocket). A single dropped or delayed
   packet head-of-line-blocks every snapshot queued behind it, so real-internet
   loss/jitter arrives as *stalls* (ships jump, interpolation freezes), not the
   smooth jitter the interpolator was tuned for. Original Subspace uses **UDP**
   precisely to avoid this — a stale position packet is discarded, newest wins.
2. **Tuning & serialization.** The netcode constants are tuned for the
   zero-latency loopback/simulator, not a 100ms link — e.g. the lag-comp rewind
   cap (`maxCompTicks` = 15t = 150ms) is *below* the real view delay
   (`interpDelayMs` 75ms + ~RTT ≈ 175ms), so connecting shots get clamped and
   under-rewound, i.e. eaten. Separately, full-state JSON snapshots are
   `structuredClone`d per client (O(players²), no delta, no AOI), which caps how
   many players the server can ever carry.

These sub-steps tackle that, **cheapest-and-highest-leverage first**, with an
explicit decision gate. Each is one Claude Code session and ends in a runnable,
**measurable** build.

---

### M2.11 — Measure & tune (diagnostics + the cheap wins)  ✓

**Goal:** before any rewrite, instrument the live build and exhaust the
zero-architecture-change wins — they may make 100ms playable on their own, and
either way they produce the data that says whether the transport rewrite below is
worth it. **Do this first; it's free and it's the diagnosis.**

**Scope:**
- [x] **HUD network-health panel:** a "link health" block on the netcode overlay —
      snapshot inter-arrival interval + jitter, the live→target adaptive interp
      delay and buffer depth, and per-second rates for snapshot loss/stale and
      extrapolation/freeze/comp-clamp events; the `lagcomp` line shows `CLAMPED`
      when the wanted rewind exceeds the cap. (`net/netHealth.ts`, wired in
      `main.ts`; RTT/ack lines already existed from M2.3/M2.7.)
- [x] **Fix the lag-comp cap.** `LAGCOMP.maxCompTicks` raised 15t (150ms) → **25t
      (250ms)** so a ~100ms-RTT shot's real view delay (`interpDelayMs` + RTT ≈
      175ms, up to ~interp 200ms + RTT under jitter) is covered instead of clamped;
      the 120t history ring covers it. Favour-the-shooter trade re-documented.
- [x] **Adaptive interpolation delay.** `interpDelayMs` is now the initial/fallback;
      the live delay is driven from measured snapshot spacing + jitter
      (`net/adaptiveInterp.ts`), raised fast / lowered slow, clamped to
      `[minMs, maxMs]`, so a jittery link stops starving the buffer (the "remote
      ships jump" symptom).
- [x] **Reconcile constant/doc drift:** `BROADCAST_EVERY` comment fixed to ~33Hz
      (was "20Hz"); `maxCompTicks` code now matches the 25t/250ms in `CLAUDE.md`;
      stale "20Hz" comments across `protocol.ts`/`interpolation.ts`/`main.ts`
      updated. Overlay/`CLAUDE.md` bumped to M2.11.
- [ ] Re-measure at 100ms with the network simulator set to match the live link —
      **owner action:** open the build, set #netsim to ~80±30ms / 3% loss (≈ the
      Railway link), and read the new overlay to confirm clamps drop and the buffer
      stops starving. Unit/typecheck/build all green.

**Follow-ups from the first live ~100ms test (all shipped under M2.11):**
- [x] **Standing input-queue backlog fixed.** The live overlay showed `rtt 355ms`
      while the network ping was ~95ms: the server consumed one input/tick with no
      drain, so a burst/drift built a *standing* queue adding ~260ms. `serverInput`
      now caps the queue at a small jitter buffer (drop oldest); overlay shows true
      `ping` vs `ack` and the `in-buf` depth so the gap is visible.
- [x] **TCP_NODELAY + no per-message compression** on the server — Nagle/delayed-ACK
      was batching the tiny input/snapshot/ping frames (a big part of why app-ping
      sat well above the raw network path).
- [x] **Predicted hit *feedback* (`net/predictedHits.ts`).** The moment one of your
      in-flight shots overlaps an enemy *as drawn*, the burst/spark is shown now and
      the shot stopped there, instead of waiting ~1 RTT for the server. Covers both
      *un-acked* shots (retracted from the replay via `Predictor.markHit`) **and
      acked-but-in-flight** shots (suppressed from the render view by id until the
      server removes them) — the latter matters because at any real latency a shot is
      acked ~1 RTT (≈tens of px) after firing, so a combat-range hit is almost always
      already acked; gating on un-acked alone only ever fired point-blank. Cosmetic
      only — damage/kills/death stay authoritative (no predicted kills); accepted
      Subspace-style trade of an occasional miss-burst. This is what masks the
      fundamental ~1-RTT feedback delay that *no* model (relay included) removes.

**Out of scope:** transport change, serialization change, AOI culling. The
non-lossy version of the queue fix (client-side send pacing) is a later item.

**Playable end state:** the same architecture, but quantified and de-laggified —
the self-inflicted ~260ms backlog is gone (`ping ≈ ack`), offense *feels* instant
(predicted bursts), and the overlay says whether any remaining pain is the wire
(loss/stale → M2.12) or fundamental. **This is the decision input for M2.12.**

---

### M2.12 — UDP-style transport (the head-of-line-blocking fix)

**DECIDED NOT TO IMPLEMENT THIS!! SKIPPING!!**

---

### M2.13 — Binary snapshots + delta compression  ✓

**Goal:** stop sending full-state JSON every broadcast. Cut per-client CPU
(`structuredClone` + `JSON.stringify` is O(players²)) and bandwidth so the server
scales past a handful of players.

**Scope:**
- [x] Binary snapshot writer/reader (`net/byteBuffer.ts` + `net/snapshotCodec.ts`):
      a schema-driven, **field-level** codec packing floats as f32 and ints as
      LEB128 varints — no JSON. Snapshots ride the WebSocket as *binary* frames;
      control messages (hello/welcome/reject/input) stay JSON *text* frames, and
      the transport tells them apart by frame type. The loopback `GameServer` path
      keeps the plain `Snapshot` object (binary is purely the wire form).
- [x] **Delta encoding:** the acked-baseline (Quake3) model. Each client
      piggybacks the newest snapshot tick it decoded on its input stream
      (`InputMsg.ackSnapshotTick`, reusing the M2.3 input channel); the server
      delta-encodes the next snapshot against *that* baseline (a per-entity dirty
      bitmask + only the changed fields), stamping the `baselineTick` so the client
      applies the delta onto the right retained snapshot. A keyframe is sent when no
      usable baseline exists (fresh join, lost ack, aged-out) or on a periodic
      interval (~60 broadcasts). `net/serverSnapshots.ts` (`SnapshotChannel`) owns
      the per-client baseline bookkeeping. Loss-robust: the client only ever acks
      what it holds, so the server only ever diffs against something decodable.
- [x] Dropped the per-client `structuredClone`: the server builds **one** shared
      snapshot from the live world per broadcast and quantizes it **once** (the
      next baseline), then encodes per client — replacing the old O(players ×
      clients) clone.
- [x] Tests (`net/snapshotCodec.test.ts`): a delta-applied client world equals a
      full-snapshot one bit-for-bit across a stepped sequence; keyframe recovery
      after a dropped baseline; entity add/remove; all four event types + pings;
      server-side baseline selection (keyframe-until-ack-then-delta). Verified
      end-to-end against the live headless server over a real socket (keyframe →
      deltas → periodic keyframe).

**Bit-for-bit parity note:** floats are quantized to f32, so the codec is
*symmetric* — the server stores `quantizeSnapshot(sent)` as the next baseline,
exactly what the client reconstructs by decoding, so "unchanged" on the server is
"keep the baseline value" on the client and they're equal. (Gotcha found in
build: a varint field can be `Infinity` — bullets bounce until lifetime ends, so
`Projectile.bounces` is `Infinity` — which loops `writeVaruint` forever; handled
by a dedicated `varinf` field kind, and `writeVaruint` now throws on non-finite
input rather than hanging.)

**Out of scope:** AOI culling (M2.14) — though delta + AOI compose cleanly. The
shared baseline ring becomes per-client once AOI makes per-client content differ;
the encode/baseline machinery is unchanged.

**Playable end state:** identical feel, a fraction of the bytes and server CPU
(a steady 2-player scene's delta is <½ its keyframe; a cruising ship sends a
handful of floats, not ~45 fields); bandwidth now scales with *change*, not roster
size.

---

### M2.14 — Area-of-interest culling & stealth filtering  ✓ (distance AOI; stealth → M5)

**Goal:** fill the per-client `serializeSnapshotFor` filter seam built back in
M2.0 — send each player only what they can see. The precondition for Subspace's
"50+ players on screen" and for stealth being server-enforced.

**Decision:** M2.14 shipped **distance/AOI culling only**. Stealth/cloak
concealment was scoped out to M5 to keep the milestone tight; the filter leaves a
single, marked seam (one per-player predicate in `filterSnapshotFor`) that M5's
toggle systems plug into without touching the per-client baseline machinery.

**Scope:**
- [x] Distance / weapon-range AOI (`net/aoi.ts`): include an entity only if within
      view + weapon range of the recipient — a rectangular viewport expanded by
      `weaponReach` on each axis, mirroring Subspace's `max(WeaponRange, screen)`
      rule as one cheap AABB. Always include the recipient and their own shots.
      Constants live in `config.AOI` (`viewHalfWidth/Height`, `hysteresisPx`, and
      `weaponReach` derived from `SHIPS`).
- [x] Spawn/despawn semantics across the AOI edge: the delta codec's removal list
      despawns an entity leaving view and re-adds a full entity on re-entry; an
      `hysteresisPx` band stops boundary flicker; the interpolator's join/respawn
      pin makes re-entry pop in without smearing.
- [x] **Per-client delta baselines** (`net/serverSnapshots.ts`): now that content
      differs per client, each client keeps its own ring of the *filtered*
      quantized snapshots it was sent, so deltas diff against exactly what the
      client holds. The shared world is still quantized **once** per broadcast; the
      per-client cost is one AABB scan + the delta encode that already ran.
- [ ] ~~Wire stealth/cloak into the same filter~~ → **deferred to M5** (seam marked
      in `filterSnapshotFor`).
- [x] Tests (`net/aoi.test.ts`): predicate boundary + hysteresis; a far player is
      absent; own shots always sent; crossing the AOI boundary despawns via delta
      and re-enters as a full entity; delta-equals-full bit-for-bit holds through
      the filter+channel.

**Out of scope:** stealth/cloak/xradar and the rest of M5's toggles (M5 owns
those; this builds the seam they plug into).

**Playable end state:** snapshot size scales with *local density*, not arena
population. (Stealth server-enforcement lands when M5 fills the marked seam.)

---

### M2.15 — Upstream input batching & loss tolerance  ✓

**Goal:** stop sending one framed message per 10ms tick (~100 msg/s/client). Batch
and add redundancy so input survives loss without a retransmit — the upstream
counterpart to the downstream work above.

**Scope:**
- [x] Coalesce the tick-commands produced within a render frame into **one**
      datagram. `InputMsg.input` → **`inputs: SequencedInput[]`**; `InputSender`
      (`net/inputSender.ts`) paces the wire send to `INPUT.sendIntervalMs`
      (default **~16ms ≈ 60Hz**, ≈ one datagram per render frame). The pacing
      lives outside the transports (loopback stays immediate; policy is
      unit-testable), driven from `main.ts` off the existing
      `ClientInputManager.unacked` ring — `produce()` still emits every tick, so
      the stream/seqs are unchanged. **Default chosen at 60Hz (not 30Hz)** so the
      uplink adds ~0 latency vs the old per-tick send — inputs leave on the same
      frame they do today, just coalesced — since the link is already latency-
      sensitive; raising toward ~33ms (~30Hz) is a config-only bandwidth trade.
- [x] **Redundancy:** each datagram re-includes the newest `INPUT.redundantTicks`
      (default 10) un-acked inputs (just `unacked.slice(-N)` — inputs are tiny),
      so a dropped datagram is covered by the next without a round-trip. The
      server already dedups by `seq` (`PlayerQueue.push` drops stale ≤
      `lastProcessedSeq` and duplicates already queued), so the overlap is free on
      receive; `server/index.ts` just loops `inputs.push` over `msg.inputs`.
- [x] Verified the M2.3 fixed-tick model and the M2.4 replay are unaffected:
      production is unchanged (one seq per tick, same order), the determinism
      integration suite stays green, and a unit test feeds producer→sender→server
      and asserts a *wholly dropped* datagram reaches the **same final processed
      seq** (redundancy carried the lost commands forward — no gap).
- [x] Overlay (M2.11 "measurable build"): an **upstream** line shows datagram send
      rate (`up …/s`, down from ~100), inputs per datagram (`batch …`), and the
      redundancy depth (`redund …`).

**Out of scope:** input compression beyond batching.

**Playable end state:** a fraction of the upstream message rate (~100→~60 msg/s,
coalesced), and a single lost input packet no longer causes a server-side gap /
repeat-last hiccup — covered by the in-datagram redundancy, no round-trip.

---

## M3 — Client surfaces / UI foundation

**Goal:** build the bitmap-font UI toolkit and the lobby's core surfaces so it
**looks and reads like Subspace** (per your screenshots).

**Unlocks:** chat, statbox, minimap, nametags, menus — and the toolkit every
later UI rides on.

**Scope:**
- [ ] One-time tool: slice the original font PNGs (`hugefont`/`largefont`/
      `shrtfont`/`tallfont`/`specfont`/`energy_font`/`led_font`) into a glyph
      atlas for Pixi `BitmapText`.
- [ ] `ui/widgets/`: `Label`, `Panel`, `ScrollList`, `InputLine` (bitmap-font).
- [ ] Hidden DOM `<input>` for chat typing; render visible text in Pixi.
- [ ] `ui/models/`: `ChatModel`, `StatboxModel`, `HudModel` (data, derived from sim).
- [ ] **Chat** (public + team), color by type via tint.
- [ ] **Statbox** (name, bounty, points; W/L/R stub).
- [ ] **Minimap/radar** (`MapZoomFactor`, player dots, viewport box).
- [ ] HUD on real fonts: energy bar/number, nametags + bounty.

**Out of scope:** full menu/hotkeys, squads, ticker, kill-feed polish (→ M6).

**Playable end state:** the multiplayer build now has authentic chat, a player
list, a working minimap, and pixel-perfect original-font text.

**Refs:** catalog §8, §9; architecture §6.

---

## M4 — All 8 ships

**Goal:** every ship flyable with correct per-ship physics, weapons, and visuals,
at **Maximum** tier (lobby default).

**Unlocks:** ship variety; the data-driven payoff of M0's config tables.

**Scope:**
- [ ] Author `SHIPS[0..7]` from the `.ini` (Warbird…Shark), Initial+Maximum.
- [ ] Wire ship sheets `ship0..7` (+ `_red`/`_junk` variants).
- [ ] Per-ship/per-level **bullet & bomb colors** (sheet rows).
- [ ] Ship-select (menu or `=`), spawn at chosen ship.
- [ ] Per-ship weapon params (multifire angle, bomb thrust, burst speed, etc.).

**Out of scope:** items/toggles (M5), turret/attach (defer to M5/M6).

**Playable end state:** pick any of the 8 ships; each flies and fires per its EG
config with the right colors.

**Refs:** catalog §1, §2; architecture §2.5.

---

## M5 — Special items & status effects

**Goal:** the full combat toolkit. Build the **status system** and **items
system** once; the individual items/toggles are then thin.

**Unlocks:** repel/burst (named in Phase 1 scope), mines, the stealth/cloak/etc
toggles, super/shields.

**Scope (in dependency order):**
- [ ] `systems/status.ts`: toggle energy-drain + force-off + timed-expiry
      (per [arch §2.4](architecture.md)).
- [ ] `systems/items.ts`: the use-item dispatch.
- [ ] **Repel** (radial impulse on projectiles+ships; `RepelDistance/Speed/Time`).
- [ ] **Burst** (radial bullets).
- [ ] **Mines** (stationary armed bomb; reuse bomb damage path; `TeamMaxMines`).
- [ ] **Shrapnel** on bomb death.
- [ ] Toggles: **cloak, stealth, xradar, antiwarp, multifire** — and wire
      stealth/cloak into `serializeSnapshotFor` (the per-client AOI seam built in
      M2.14).
- [ ] Timed: **super, shields**; **rocket**, **decoy**, **portal**, **brick**.

**Out of scope:** prizes/greens (lobby is max-ship-no-greens; greens are a later
mode), flags/ball (Phase 2).

**Playable end state:** the lobby has the full EG combat toolkit; stealth/cloak
actually hide you server-side.

**Refs:** catalog §2, §3; architecture §2.4, §5.1.

---

## M6 — Lobby polish → Phase 1 complete

**Goal:** turn "it works" into "people want to hang out here." The persistent
EG-style lobby ships.

**Scope:**
- [ ] Full **statbox**: W/L/R, squads, freq coloring, sorting (your menu screenshot).
- [ ] **Menu**: F1 help, hotkeys overlay, ship select, settings, set banner.
- [ ] **Kill feed / notifications**, **ticker** (`TickerDelay`), streaks.
- [ ] **Frequencies/teams** assignment + limits (`[Team]`), basic `?`commands.
- [ ] **Sound manager** — wire all original `.wav`s to events.
- [ ] Animation polish: warp-in, cloak/stealth shimmer, thrust, super.
- [ ] **Attach/turret** (ride a captain) — EG lobby staple.
- [ ] Arena mode flag: **Maximum loadout, greens off** (lock in the lobby ruleset).
- [ ] Remappable controls (addresses the `Ctrl` limitation in the README).

**Playable end state:** a joinable, persistent, good-looking EG-style lobby with
8 ships, full combat toolkit, chat, radar, sound, and stats. **Phase 1 done.**

**Refs:** catalog §6 (teams), §7, §8, §9.

---

## Phase 2 — Competitive (only if Phase 1 shows promise)

Sketched, not detailed — these get their own planning pass when Phase 1 is proven.

- **Flags / base duel:** flag entities, carry/claim/turf, flagger modifiers,
  flag-duel scoring, base maps. (catalog §6)
- **Powerball / soccer:** ball carry/pass/goal, soccer modes. (catalog §6)
- **World objects:** bricks, doors, wormholes (gravity + teleport). (catalog §6)
- **Greens mode:** the full prize system as an alternate arena ruleset. (catalog §4)
- **Matchmaking:** TagPro-style queue → short 5-min matches.
- **Accounts, persistence, leaderboards.**

---

## A note on milestone size

M0–M1 are each likely a few focused sessions. **M2's model is complete** — it was
built as eleven buildable slices (M2.0–M2.10), now collapsed into the single M2
summary above. The open netcode work is the **responsiveness & efficiency pass**
(M2.11–M2.15): five sessions, one buildable slice each, ordered
cheapest-and-highest-leverage first (measure/tune → UDP transport → binary+delta →
AOI → input batching), with a decision gate after M2.12 that either continues the
authoritative path or pivots to the Subspace relay model. M3–M6 are larger and will
split into sub-sessions naturally (e.g. M5 is "status system" then one session per
item cluster). When you start a milestone, the first session's job is often to
scaffold the system(s) and one vertical slice; later sessions fill in the riders.
Keep each session ending on a runnable build.
