# Architecture

This is the **contract** every feature obeys. Before adding anything — a weapon,
an item, a HUD panel — find where it plugs into the layers and pipeline below. If
a change doesn't fit, that's a signal to revisit this document, not to bolt the
feature on sideways.

It builds directly on the golden rule in the [README](../README.md): `src/sim/`
is pure game logic with no rendering imports, because the same code runs on the
server. Everything here is a consequence of taking that rule seriously.

---

## 1. The four layers

Every feature is split across these four layers *before* it is written. A feature
is almost never one file — it's usually a bit of **A** + one system in **B**, an
**C** event, and a widget in **D**.

| Layer | What it is | Where it runs | Rule |
|---|---|---|---|
| **A — Sim state** | The nouns: the data that *is* the game this tick | Server (authoritative) | Plain, serializable data. No methods, no Pixi, no DOM. |
| **B — Sim systems** | The verbs: ordered pure functions that transform A each tick | Server | `(world, ctx) → mutations + events`. No I/O, no randomness outside a seeded RNG. |
| **C — Event bridge** | Transient "something happened" records produced by B | Server → client | One-shot, fire-and-forget. Render, audio, and netcode all consume them. |
| **D — Client** | HUD, minimap, chat, scoreboard, menu, sound, camera, interpolation | Client only | Reads A + drains C. Never mutates A directly; sends `InputCommand`s instead. |

**The litmus test for A:** if you can't JSON-serialize it and send it over a
wire, it doesn't belong in sim state. This is what makes networking mechanical
later (see §5).

---

## 2. The data model (Layer A)

### 2.1 The world is keyed collections, not singletons

Today `World` holds a single `ship`. The **Milestone 0 refactor** generalizes it:

```ts
class World {
  tick: number;
  players: Map<PlayerId, Player>;     // was: ship
  projectiles: Projectile[];          // each tagged with an owner PlayerId
  prizes: Prize[];
  flags: Flag[];
  balls: Ball[];                      // powerball(s)
  bricks: Brick[];
  rng: SeededRng;                     // deterministic; never Math.random() in sim
  events: GameEvent[];                // drained each tick (Layer C)
}
```

Single-player is just "one player among N." Nothing in the sim assumes a player
count.

### 2.2 A Player is grouped components, not a flat bag of fields

A player accretes a lot of state. Group it so it stays legible and so systems can
own a slice:

```ts
interface Player {
  id: PlayerId;
  name: string;
  team: TeamId;
  shipType: ShipType;        // 0..7, or "spectator"

  kinematics: { x; y; vx; vy; rotation; prevX; prevY; prevRotation };
  resources:  { energy; recharge };
  loadout:    Loadout;       // see 2.3 — what this ship CAN do + current ammo
  status:     StatusEffects; // see 2.4 — timed toggles (stealth, cloak, …)
  combat:     { bounty; deaths; respawnAt; flagsHeld; carryingBall };
}
```

`prevX/prevY/prevRotation` stay on kinematics for the renderer's interpolation —
that pattern already works in the prototype; we keep it.

### 2.3 Loadout = config-driven capability + runtime ammo

Most "features" you'd name (bullet level, multifire, # of bombs, mines, repels,
bursts) are **not code** — they're a player's current loadout, which is mostly a
copy of config:

```ts
interface Loadout {
  gunLevel: 1 | 2 | 3;       // → bullet color/damage
  multifire: boolean;
  bombLevel: 1 | 2 | 3;
  bouncingBombs: boolean;
  // counts of consumables:
  mines; bursts; decoys; repels; rockets; portals; thors; bricks;
}
```

A Spider firing vs a Warbird firing is the *same* code reading *different* config.
This is how we get 8 ships without 8 copies of any system.

### 2.4 Status effects: toggles vs timed — one system, not six

Subspace has **three distinct mechanisms** here; don't conflate them (and don't
write `stealth.ts`, `cloak.ts`, … — one `statusSystem` drives them all):

1. **Acquired capability** — *can* the player use it at all? Granted by the
   ship's Initial config or by picking up the green. Permanent until death.
   Lives in `Loadout` (see 2.3), e.g. `hasStealth`, `hasMultifire`.
2. **Active toggle** — is it *on right now*? Player-controlled on/off; **drains
   energy per tick while on** (`.ini`: `StealthEnergy`/`CloakEnergy`/
   `XRadarEnergy`/`AntiWarpEnergy`); forced off if energy can't pay. **No timer.**
   These are stealth, cloak, xradar, antiwarp, multifire.
3. **Timed effect** — auto-expires after a fixed duration. The *small* set:
   super, shields (prizes), and rocket (a timed thrust burst).

```ts
interface StatusEffects {
  // Category 2 — player-controlled toggles. Just on/off; drain energy while on.
  stealth: boolean;
  cloak: boolean;
  xradar: boolean;
  antiwarp: boolean;
  multifire: boolean;

  // Category 3 — timed; store the tick at which it expires (0/absent = off).
  superUntil?: number;
  shieldsUntil?: number;
  rocketUntil?: number;
}
```

The **ship config table** declares which capabilities a ship may acquire at all.
The toggle on/off lives here in `Status`; the *permission* to toggle it lives in
`Loadout`/config. The `statusSystem` (pipeline step 9) does three jobs: apply
per-tick energy drains for any active toggle (forcing it off if energy is
exhausted), and clear any timed effect whose `*Until` tick has passed.

### 2.5 Config: data tables keyed by ship type

All tunables stay in `config.ts` (the README's rule). They generalize from the
prototype's single `SHIP`/`BULLET`/`BOMB` consts into tables:

```ts
SHIPS: Record<ShipType, ShipConfig>     // 8 entries, ported from the EG .ini
// each ShipConfig carries Initial AND Maximum tiers (Phase 1 uses Maximum)
WEAPONS: per-level bullet/bomb/burst/… params
PRIZES, FLAG, SOCCER, BRICK, …          // mirror the .ini sections
```

Source of truth is `original_data/extreme_games_config.ini`. `config.ts`
documents every unit conversion (the README/gotchas already nail these).

---

## 3. The tick pipeline (Layer B)

`World.step()` is **not** a god-method. It's an explicit, ordered list of
systems. The order is itself a documented design decision — many bugs are just
"wrong system order."

```
step(ctx) {                          // ctx = per-player InputCommands + tick #
  1.  intent        // resolve each player's InputCommand → desired actions
  2.  movement      // rotate, thrust, drag, wall-bounce   (have this)
  3.  firing        // spawn projectiles from loadout; debit energy/ammo/cooldown
  4.  items         // activate repel(impulse field)/burst/decoy/portal/antiwarp
  5.  projectiles   // move, bounce, lifetime, mine-arming  (have basic version)
  6.  collision     // projectile↔ship, ship↔ship, ship↔prize/flag/ball/goal
  7.  damage        // apply hits → energy; queue deaths        ← NOT YET BUILT
  8.  death/respawn // kill credit, bounty transfer, respawn timers  ← keystone
  9.  status        // drain energy for active toggles (force off if empty);
                    //   expire timed effects (super/shields/rocket)
  10. resources     // energy recharge
  11. prizes        // spawn greens, pickup
  12. objectives    // flag claim/carry/drop, ball pass/goal scoring
  13. regions       // safe zones, no-antiwarp areas, etc.
  14. (events already accumulated in this.events for the client to drain)
}
```

**Damage → death/respawn (steps 7–8) is the first thing to build after the
refactor.** Nothing competitive — kills, bounty, the scoreboard, flags — works
without it. The prototype has movement, firing, and projectile flight; it has no
concept of getting hit.

Each system is `(world, ctx) => void` that mutates the world and pushes to
`world.events`. Pure: no DOM, no network, no `Math.random()` (use `world.rng`).

---

## 4. The event bridge (Layer C)

Events are how the sim tells the outside world *what happened* without knowing how
it's drawn or heard. The prototype already has this (`bombExploded`). It grows
into a tagged union:

```ts
type GameEvent =
  | { type: "weaponFired";   ... }
  | { type: "bombExploded";  x; y; ... }
  | { type: "shipHit";       target; by; damage; ... }
  | { type: "shipDied";      victim; killer; ... }
  | { type: "prizeGrabbed";  player; prize; ... }
  | { type: "flagClaimed" | "goalScored" | "warp" | ... }
```

Three consumers, all in Layer D / net: the **renderer** (explosions, shimmer),
the **audio** manager (the original `.wav`s), and the **kill-feed / chat**.
Events are transient — produced, drained, discarded each frame. They are never
sim state.

---

## 5. Networking shape (decide now, build in Phase 1)

We don't write netcode yet, but we name its three wire shapes today so every
feature is built net-ready. This is the cheapest rework-prevention available.

1. **`InputCommand`** (client → server) — exists. Grows to include use-item,
   change-ship, send-chat. The client sends *intent*, never state.
2. **`Snapshot`** (server → client) — the serializable subset of `World` (= the
   Layer A list). **Because A is plain data, the snapshot essentially *is* the
   world.** That equivalence is the whole payoff of the layer discipline.
3. **`GameEvent[]`** (server → client) — Layer C, for effects/audio/kill-feed.

### 5.1 Snapshots are per-client, not global

The crucial refinement: a snapshot is **the world as visible to player P**, not
the whole world.

```ts
serializeSnapshotFor(world, playerId): Snapshot
```

This is where **stealth/cloak/xradar** and **area-of-interest culling** live:
the server decides what player P is *allowed* to see and omits the rest. Modeled
this way, stealth is a real, server-enforced mechanic instead of a client-side
fib a cheater could strip out. Build the seam as per-client from day one even if
the first version sends everyone everything.

### 5.2 Client prediction & interpolation

The prototype already interpolates between sim ticks using `prevX/prevY` + an
`alpha`. That same machinery becomes **entity interpolation** between server
snapshots. The local player gets **client-side prediction** (simulate locally,
reconcile against the authoritative snapshot) — which works *only because the sim
is deterministic and runnable on the client too*. Determinism (seeded RNG, fixed
order, fixed timestep) is therefore a hard requirement, not a nicety.

---

## 6. The client & UI (Layer D)

### 6.1 Rendering: Pixi reads sim state, drains events

`render/` owns all Pixi. It reads world state to place sprites and drains
`world.events` for one-shot effects. It never writes to sim state.

### 6.2 UI uses the original bitmap fonts in Pixi, with hidden DOM input

Decision (locked): the HUD, chat, scoreboard, and menu are **drawn in Pixi using
the original Subspace bitmap fonts** (`hugefont.png`, `largefont.png`,
`shrtfont/tallfont/specfont`, plus `energy_font.png` and `led_font.png` for the
energy and timer digits). Rationale and trade-offs are in §6.4.

- A one-time tool slices each font PNG into a glyph atlas that Pixi `BitmapText`
  can consume (Subspace's font format isn't BMFont `.fnt`).
- Color variants (chat colors, team colors, green points) come from Pixi `tint`
  on a single atlas — no duplicate font assets.
- **Text input** (typing in chat) is captured by a hidden/offscreen DOM
  `<input>` — which gives IME, mobile keyboards, and paste for free — but the
  *visible* text is rendered by us in Pixi.

### 6.3 UI is data + a thin renderer

To keep UI swappable and the sim ignorant of it, UI surfaces are **models**
(plain data) rendered by a small in-house toolkit:

```
ui/
  models/   ScoreboardModel, ChatModel, HudModel   (plain data, derived from A+C)
  widgets/  Label, Panel, ScrollList, InputLine     (Pixi bitmap-font primitives)
```

A panel renders a model; it doesn't reach into `World`. This means the look can
change without touching gameplay, and the toolkit is reused across every panel.

### 6.4 Why bitmap-in-Pixi over a DOM/HTML overlay

- **DOM downside:** browsers anti-alias text; the `.ttf` recreations go soft on
  retina/2× displays, and DOM text scales by *blurring* while the game art scales
  by crisp nearest-neighbor — so at fullscreen the UI and the world would have
  different "pixel character." That mismatch is the feel we're protecting.
- **Pixi-bitmap downside (accepted):** we hand-build text widgets (wrap, scroll,
  caret) and wire a hidden input for typing. Bounded, one-time, and reusable.
- Net: bitmap-in-Pixi is the only route to *pixel-identical* original text that
  scales in lockstep with the world.

---

## 7. Target module map

The layers above imply this structure (extends today's tree):

```
src/
  config.ts            A — all tunables; SHIPS[8] + weapon/prize/flag tables
  sim/
    types.ts           A — Player, Projectile, Prize, Flag, Ball, Snapshot, GameEvent
    world.ts           the keyed collections + step() pipeline driver
    rng.ts             seeded deterministic RNG
    systems/           B — one file per system, run in documented order
      movement.ts  firing.ts  items.ts  projectiles.ts  collision.ts
      damage.ts  respawn.ts  status.ts  resources.ts  prizes.ts  objectives.ts
    gamemap.ts collision-tiles.ts loop.ts   (existing primitives)
  net/                 (Phase 1) snapshot serialize/deserialize, prediction, interp
  render/              D — Pixi: world sprites, effects (drains events), camera
  ui/                  D — models/ + widgets/ (bitmap-font toolkit), hidden input
  audio/               D — sound manager (drains events)
  input/               client: keys → InputCommand
  main.ts              wiring + the requestAnimationFrame loop
```

---

## 8. Worked example: adding mines (the template)

This is how *every* feature session should reason. A mine = a stationary, armed
bomb that triggers on proximity.

- **A (state):** no new entity — a mine is a `Projectile` with `kind:"mine"`,
  `vx=vy=0`, and an `armedAt` tick. `Loadout.mines` already holds the count.
- **B (systems):**
  - *firing*: a "drop mine" intent spawns the mine projectile and decrements
    `loadout.mines` (gated by the per-ship max-mines config).
  - *projectiles*: a mine doesn't move; it counts down `armedAt`.
  - *collision*: once armed, proximity to an enemy ship triggers detonation —
    reusing the **exact same** bomb-damage path (radius, shrapnel) as a bomb.
- **C (events):** reuse `bombExploded` (maybe a `mine:true` flag for a different
  sound/sprite).
- **D (client):** render the mine sprite (`mines.png`); audio plays the existing
  detonation `.wav`; no new HUD beyond the existing ammo count.

Notice how little is *new*: mines mostly reuse the bomb damage path and the
projectile container. That reuse is the dividend of the layer discipline — and
it's why the catalog (`docs/feature-catalog.md`) tags every feature with the A/B/
C/D pieces it touches, so we can see this reuse before writing code.

---

## 9. Two opinions held strongly

1. **No heavyweight ECS library.** Arrays of plain structs + ordered system
   functions is the sweet spot for a deterministic 100Hz netcode sim:
   serialization-friendly, debuggable, deterministic. Full ECS
   (archetypes/queries) adds indirection that fights snapshotting and
   determinism. We use the *ideas* of ECS (data + systems), not a framework.

2. **Entities stay plain data; behavior lives in systems.** The moment an entity
   grows a method that does real work, snapshotting and server/client parity get
   harder. Keep logic in `sim/systems/`.
