# Subspace — browser clone

A from-scratch, browser-based reimagining of the 90s/2000s 2D space shooter
**Subspace / Continuum**, with the feel of the classic **Extreme Games (EG)**
server. The goal is not to reimplement the original client/server protocol, but
to rebuild the game cleanly so it can be modernized and brought to a new
generation — while still feeling like the game we grew up on.

Built with **TypeScript + Vite + PixiJS**, with the simulation kept strictly
separate from rendering so it can run authoritatively on a server.

---

## Where the project is today

A **single-player prototype** that already nails the core feel:

- Fly a **Warbird** around the real **svs** arena (the actual original map data).
- **Authentic EG physics** at a fixed 100Hz sim — rotation, thrust, speed cap,
  frictionless coasting, wall bounce — all ported from the real EG config.
- **Weapons:** gun (blue bullets, infinite wall-bounce, short ~0.65s range) and
  bombs (blue, ~2.5s), with energy cost + cooldown gating.
- **Afterburner** (Shift), energy + recharge, on-screen HUD.
- Smooth rendering at any refresh rate via tick interpolation.
- Viewport-culled tile rendering, so the 1024×1024 (16384px) map is cheap.
- Fullscreen + Keyboard Lock support (F).

It is single-player only — no networking, no other ships, no minimap/chat yet.
Those are Phase 1 (below).

## Running it

```bash
npm install
npm run dev          # opens http://localhost:5173
```

Controls:

| Key | Action |
|---|---|
| Arrow keys | rotate / thrust / reverse |
| `Z` (or `Ctrl`) | fire gun |
| `Tab` | fire bomb |
| `Shift` | afterburner |
| `F` | toggle fullscreen |

> **Why `Z`/`Tab` instead of Subspace's `Ctrl`/`Ctrl+Tab`?** A browser can't
> reclaim OS/browser-reserved combos: macOS steals `Ctrl`+arrows for Mission
> Control, and the browser steals `Ctrl+Tab` for tab-switching. `Z` (near where
> `Ctrl` sits) and plain `Tab` are reliably capturable. Remappable controls are
> on the roadmap.

Other scripts:

```bash
npm run build        # typecheck + production build
npm run preview      # serve the production build
```

---

## Architecture

**The golden rule:** `src/sim/` is pure game logic with **no rendering imports**.
The same code is intended to run on the server, so it must never import from
`src/render/` or from `pixi.js`. This separation is the single most important
design decision in the project — it's what makes the multiplayer Phase 1
possible without a rewrite.

```
src/
  config.ts        ← ALL tunable gameplay numbers (start here to change feel)
  assets.ts        ← asset URLs + sprite-sheet grid layouts

  sim/             ← pure simulation (no Pixi). This becomes the server.
    types.ts         shared state shapes (ShipState, Projectile, InputCommand)
    gamemap.ts       tile grid + solidity queries
    collision.ts     move-a-box-through-tiles, with wall bounce
    ship.ts          per-tick ship physics (rotation, thrust, drag, bounce)
    projectiles.ts   firing + per-tick bullet/bomb physics (unified Projectile)
    world.ts         ties ship + projectiles together; one step() = one tick
    loop.ts          fixed-timestep driver (always 100Hz) + interpolation alpha

  map/
    loader.ts      ← browser-side: fetch map.json -> GameMap

  input/
    keyboard.ts    ← held keys -> InputCommand
    fullscreen.ts  ← Fullscreen + Keyboard Lock helpers

  render/          ← everything PixiJS
    textures.ts      load images + slice sprite sheets into frames
    tiles.ts         viewport-culled tile renderer (pooled sprites)
    renderer.ts      Pixi app, camera, ship + projectile sprites, interpolation

  main.ts          ← wires it all together; the requestAnimationFrame loop + HUD
```

### Simulation / rendering split

- **Simulation** runs at a fixed **100Hz** (matching real Subspace). `FixedLoop`
  accumulates real elapsed time and advances the world in exact 10ms steps, so
  physics is deterministic and identical regardless of refresh rate.
- **Rendering** runs once per `requestAnimationFrame`. Each tick the sim saves
  the previous pose; the renderer **interpolates** between previous and current
  using the leftover `alpha`. This same interpolation is what will smooth out the
  gaps between networked server snapshots in Phase 1.

### Where to tune the feel

Everything that changes how the game *plays* lives in **`src/config.ts`**, ported
from the real EG config (`original_data/extreme_games_config.ini`). That file
uses classic Subspace integer units; `config.ts` documents the exact conversions
to our per-tick units (validated against the svs `settings.json`).

Note: the prototype currently uses the EG **Initial** (un-upgraded) Warbird
values. Phase 1 calls for everyone starting at **Maximum** ship (no greens), so
that's a planned switch.

### Data & assets

- The map is the real **svs** arena: `assets/arenas/svs/map.json`, a sparse
  `{ flatIndex: tileValue }` object over a 1024×1024 tile grid. Any non-zero tile
  is a solid wall.
- `tileset.bmp` is converted to `tileset.png` (browsers can't load BMP):
  `sips -s format png tileset.bmp --out tileset.png`.
- Sprite-sheet layouts come from `assets/arenas/svs/resources.json`. Sheets are
  laid out `[row = color]` × `[column = animation frame]` (row 0 red, row 1 gold,
  row 2 blue, …) for bullets and bombs.
- All original graphics, tilesets, and sounds live under `assets/`; the full EG
  ship/weapon parameters are in `original_data/extreme_games_config.ini`.

---

## Roadmap

### ▶ Phase 1 — Persistent lobby (current focus)

A classic-EG-style **persistent public arena** that anyone can join in-browser.
The aim is to drum up interest and validate the feel with real players before
investing in matchmaking. Scope:

- **Authoritative game server** running the `sim/` at 100Hz. Clients send
  `InputCommand`s; the server simulates and broadcasts world snapshots; clients
  interpolate (the architecture is already built for this).
- **Browser multiplayer** — connect over WebSocket, see and fight other players.
- **All 8 ships** — Warbird, Javelin, Spider, Leviathan, Terrier, Weasel,
  Lancaster, Shark — each with its own physics/weapon config from the EG `.ini`,
  and its own sprite sheet (`ship0`–`ship7`).
- **Everyone starts at MAX ship** — no greens/prizes; switch config from Initial
  to Maximum values.
- **Correct weapon visuals** — per-ship, per-level bullet and bomb colors.
- **Special items working** — repel, burst (and the groundwork for mines, etc.).
- **Minimap / radar** — the corner overview of the arena and nearby players.
- **Chat** — public arena chat.
- **Explosion animations** — ship/bomb explosions (`explode0`–`explode2` sheets).

### Phase 2 — Competitive modes (later, if Phase 1 shows promise)

- **5v5 base duel** in the EG flag-duel tradition.
- **Matchmaking + short matches** (TagPro-style: visit, queue, play ~5 min).
- Accounts, stats, leaderboards.

### Ongoing polish & systems (woven through both phases)

- **Animations:** thrust/engine exhaust (sheet already loaded), explosions,
  warp-in, cloak/stealth/super shimmer, flag/goal effects.
- **Sound:** all original `.wav` effects are present (guns, bombs, bounces,
  alarms) — wire up a sound manager.
- **Remappable controls** + saved keybindings (addresses the `Ctrl` limitation).
- **Prizes/greens** as an optional mode once the max-ship lobby is proven.
- **Mobile / touch** controls, eventually.

---

## Known rough edges

- Only the Warbird exists so far (one ship sheet wired up).
- No sound yet.
- Ship frame orientation assumes frame 0 = up, clockwise; tweak
  `directionFrame()` in `render/renderer.ts` if it ever looks off.
