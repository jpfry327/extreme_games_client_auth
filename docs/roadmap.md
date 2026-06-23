# Roadmap

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
M2  Multiplayer transport ........ server + snapshots + prediction              ← de-risks the core bet
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

## M2 — Multiplayer transport

**Goal:** the authoritative server runs the sim headless; two browsers connect
and fight on it. This is the architecture's payoff and the project's biggest bet.

**Unlocks:** real multiplayer; replaces the bot with real players (bot stays as
AI filler). Proves the snapshot + prediction model against real gameplay.

**Scope:**
- [ ] `net/`: a server process running `sim/` at 100Hz, headless.
- [ ] WebSocket transport: client → `InputCommand`; server → `Snapshot` + `events`.
- [ ] `serializeSnapshotFor(world, playerId)` — start global, but build the
      **per-client seam** now (filtering comes with stealth in M5).
- [ ] Client-side **prediction + reconciliation** for the local player.
- [ ] **Entity interpolation** for remote players (extend the existing tick-interp).
- [ ] Join/leave, basic player identity (name), debug-quality nametags.

**Out of scope:** polished UI, chat, ships beyond Warbird, items, accounts.

**Playable end state:** open two tabs → both join a server → see and fight each
other with prediction-smooth movement. The core bet is now de-risked.

**Refs:** catalog §10; architecture §5.

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
      stealth/cloak into `serializeSnapshotFor` (the M2 per-client seam).
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

M0–M2 are each likely a few focused sessions; M3–M6 are larger and will split
into sub-sessions naturally (e.g. M5 is "status system" then one session per item
cluster). When you start a milestone, the first session's job is often to scaffold
the system(s) and one vertical slice; later sessions fill in the riders. Keep each
session ending on a runnable build.
