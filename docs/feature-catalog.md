# Feature catalog

The exhaustive inventory of Subspace/Continuum gameplay, ground-truthed against
the EG config (`original_data/extreme_games_config.ini`) and cross-checked for
completeness against the feature-complete [nullspace](https://github.com/plushmonkey/nullspace)
client.

**How to read this.** Every feature is sliced across the four layers from
[architecture.md](architecture.md): **A** = sim state, **B** = sim system(s),
**C** = events, **D** = client. `—` means the layer isn't touched. The point of
the slicing is to expose **reuse** — e.g. mines, bursts, and shrapnel all reuse
the bomb/bullet damage path — *before* any code is written. The "Deps" column
drives the sequencing in [roadmap.md](roadmap.md).

Legend for status: ✅ in prototype · 🔶 partial · ⬜ not built · 🔭 deferred/out of scope.

`✱` next to a feature = on the critical path (most other features depend on it).

---

## 1. Ship & movement

| Feature | A — state | B — system | C — events | D — client | Deps |
|---|---|---|---|---|---|
| Rotate / thrust / reverse ✅ | kinematics | movement | — | ship sprite, exhaust | — |
| Speed cap, drag, frictionless coast ✅ | kinematics | movement | — | — | — |
| Wall bounce ✅ | kinematics | movement (tile collision) | `wallBounce` (sound) | bounce sfx | gamemap |
| Afterburner ✅ | resources | movement (energy drain) | — | exhaust, hud | — |
| **8 ships from config** ✱ ⬜ | `shipType` on player | movement/firing read `SHIPS[type]` | — | per-ship sheet `ship0..7` | config tables |
| Initial vs Maximum tiers ⬜ | loadout/config | (config selection) | — | — | config |
| Spawn points ⬜ | — (config `[Spawn]`) | respawn picks spawn | `warp` | warp-in anim | death/respawn |
| Gravity wells (wormholes) ⬜ | — (map objects) | movement adds pull | — | — | wormholes |
| Ship radius / collision size ⬜ | config `Radius` | collision | — | — | collision |
| Safe zones ⬜ | region (map tile) | regions (no-fire, fast-regen) | `enterSafe` | tint/indicator | regions |
| Attach / turret ✱ ⬜ | `attachedTo` on player | movement (ride host), firing (turret) | `attach` | drawn on host ship | 8 ships, teams |

Notes: turret penalties exist per ship (`TurretThrustPenalty`, `TurretSpeedPenalty`).
Attach is how EG players ride a captain — important for the lobby feel.

---

## 2. Weapons (projectiles)

All projectiles share one `Projectile` entity (`kind`) and the projectile-flight
+ damage systems. New weapons are mostly a `kind` + a config row, not new systems.

| Feature | A — state | B — system | C — events | D — client | Deps |
|---|---|---|---|---|---|
| Bullets L1–3 🔶 | projectile `kind:bullet`, `level` | firing, projectiles | `weaponFired` | bullets.png (color=level) | — |
| Bouncing bullets ⬜ | projectile `bounces` | projectiles | — | — | bullets |
| Multifire ⬜ | loadout `hasMultifire`, status toggle | firing (spread by `MultiFireAngle`) | `weaponFired` | — | bullets |
| Bombs L1–3 🔶 | projectile `kind:bomb`, `level` | firing, projectiles | `bombExploded` ✅ | bombs.png, empburst | — |
| Bouncing bombs ⬜ | projectile `bounces` | projectiles | — | — | bombs |
| Proximity bombs ✱ ⬜ | proximity radius | collision (proximity trigger) | `bombExploded` | — | bombs, **damage** |
| EMP bombs ⬜ | bomb `emp` flag | damage (energy-drain + `EBombShutdownTime`) | `shipHit` | emp visual | damage |
| Mines ⬜ | projectile `kind:mine`, `armedAt` | firing (drop), projectiles (arm), collision | `bombExploded` | mines.png | proximity bombs |
| Shrapnel ⬜ | spawned bullets on bomb death | damage→spawn (count/`Random`) | `weaponFired` | bullets | bombs, **damage** |
| Bursts ⬜ | radial bullets, count | items (fire N bullets) | `weaponFired` | — | bullets |
| Thor ⬜ | projectile `kind:thor` (ignores walls) | projectiles, collision | `bombExploded` | — | bombs |
| Decoy ⬜ | decoy entity (mirrors player) | items, `DecoyAliveTime` | `decoy` | ship sprite (fake) | 8 ships |
| Rocket ⬜ | status `rocketUntil` | items (timed thrust `RocketThrust`) | `rocket` | rocket.png, exhaust | status |
| Energy cost + cooldown gating ✅ | resources, cooldowns | firing | — | — | — |

Notes: bullet color = level (sheet rows); damage `BulletDamageLevel` (+upgrade
per level). Bomb radius `BombExplodePixels`, delay `BombExplodeDelay`. Mine cap
`TeamMaxMines`. **Everything in this section that does harm is blocked on the
damage system (§5).**

---

## 3. Special items & status toggles

See [architecture §2.4](architecture.md): **capability** (in loadout, from config
or green) vs **toggle** (on/off, drains energy, no timer) vs **timed** (auto-expire).

| Feature | Kind | A — state | B — system | C — events | D — client | Deps |
|---|---|---|---|---|---|---|
| Cloak ⬜ | toggle | `status.cloak`, `hasCloak` | status (drain `CloakEnergy`) | — | invisible to enemies on screen | snapshot filtering |
| Stealth ⬜ | toggle | `status.stealth` | status (drain `StealthEnergy`) | — | hidden on enemy radar | snapshot filtering |
| XRadar ⬜ | toggle | `status.xradar` | status (drain `XRadarEnergy`) | — | reveals full radar | minimap |
| Antiwarp ⬜ | toggle | `status.antiwarp` | status; blocks enemy warp in `AntiWarpPixels` | — | indicator | warp |
| Multifire ⬜ | toggle | `status.multifire` | firing | — | — | bullets |
| Super ⬜ | timed | `status.superUntil` (`SuperTime`) | status, damage (invuln) | `prizeGrabbed` | shimmer | damage |
| Shields ⬜ | timed | `status.shieldsUntil` (`ShieldsTime`) | status, damage (absorb) | — | shield.png | damage |
| Repel ✱ ⬜ | consumable | `loadout.repels` | items (radial impulse `RepelDistance`/`Speed`/`Time`) | `repel` | repel.png | projectiles, movement |
| Portal ⬜ | consumable + entity | `loadout.portals`, portal entity | items (drop + warp, `WarpPointDelay`) | `warp` | — | warp |
| Brick ⬜ | consumable + entity | `loadout.bricks`, brick wall | items (drop wall `BrickTime`) | `brick` | brick tiles | collision/tiles |
| Warp (random) ⬜ | one-shot | — | items (random reposition) | `warp` | warp anim | spawn logic |

---

## 4. Prizes / greens

| Feature | A — state | B — system | C — events | D — client | Deps |
|---|---|---|---|---|---|
| Green spawning (timed) ⬜ | prize entities | prizes (`PrizeFactor`/`Delay`/`MaxExist`) | — | prize.png | rng |
| Green pickup ⬜ | prize, player loadout | collision→prizes (grant) | `prizeGrabbed` | prizes.png, sfx | loadout |
| Prize weighting ⬜ | — (`[PrizeWeight]`) | prizes (weighted random) | — | — | rng |
| MultiPrize green ⬜ | — | prizes (`MultiPrizeCount`) | `prizeGrabbed` | — | greens |
| Negative greens ⬜ | — (`PrizeNegativeFactor`) | prizes (downgrade) | `prizeGrabbed` | — | greens |
| Death prizes (drop on death) ⬜ | prize entities | death→spawn (`DeathPrizeTime`) | — | — | death |
| **"Max ship, no greens" mode** ✱ ⬜ | arena setting | prizes disabled; loadout=Maximum | — | — | config |

Note: Phase 1 lobby uses the last row (everyone Maximum, greens off). The full
prize machinery above is built but gated behind an arena mode.

---

## 5. Combat & scoring — the keystone

**Nothing competitive exists until §5.1–5.3 do.** The prototype can fire but
cannot register a hit. This is the first build after the M0 refactor.

| Feature | A — state | B — system | C — events | D — client | Deps |
|---|---|---|---|---|---|
| **Damage application** ✱ ⬜ | resources.energy | damage (apply on hit) | `shipHit` | damage flash, sfx | collision |
| **Death / explosion** ✱ ⬜ | player alive flag | death | `shipDied` | explode0–2, sfx | damage |
| **Respawn** ✱ ⬜ | `respawnAt` | respawn (`EnterDelay`) | `warp` | warp-in | spawn points |
| Kill credit + bounty ⬜ | combat.bounty | death (`BountyIncreaseForKill`) | `shipDied` | kill feed | death |
| Points / score ⬜ | player score | death (`killPoints`) | `shipDied` | statbox | death |
| Kill feed / messages ⬜ | — | (from `shipDied`) | `shipDied` | notification area | chat |
| Streaks ⬜ | player streak | death | `streak` | ticker | death |
| W/L/R stats ⬜ | per-player stats | death | — | statbox | death |
| Bounty display ⬜ | combat.bounty | — | — | nametag, statbox | — |

---

## 6. World objects & game modes

| Feature | A — state | B — system | C — events | D — client | Deps |
|---|---|---|---|---|---|
| Flags (carry/claim) ⬜ | flag entities, `flagsHeld` | objectives (pickup/drop/turf) | `flagClaimed`,`flagDropped` | flag.png, dropflag | collision, teams |
| Flag duel scoring ⬜ | team flag counts | objectives | `flagVictory` | overlay | flags |
| Flagger modifiers ⬜ | flagger flags | objectives (fire cost/dmg/speed adj) | — | — | flags |
| Powerball / soccer ⬜ | ball entities, `carryingBall` | objectives (carry/pass/goal `[Soccer]`) | `goalScored`,`ballPass` | powerb.png, goal.png | collision |
| Goals ⬜ | — (map/`goal.png`) | objectives | `goalScored` | — | powerball |
| Bricks (temp walls) ⬜ | brick entities | items, collision (`BrickTime`) | `brick` | brick tiles | tiles |
| Doors (timed open/close) ⬜ | door state | regions (`DoorMode`/`DoorDelay`) | — | icondoor, tiles | tiles |
| Wormholes (grav + teleport) ⬜ | — (map objects) | movement (gravity), warp | `warp` | — | gravity, warp |
| King of the Hill ⬜ | hill timer/holder | objectives | `kothWin` | king.png, kingex | death |

---

## 7. Teams, freqs & spectating

| Feature | A — state | B — system | C — events | D — client | Deps |
|---|---|---|---|---|---|
| Frequencies (teams) ✱ ⬜ | `team` on player | (assignment, `[Team]` limits) | `freqChange` | statbox color | — |
| Private freqs ⬜ | team id | (`?team` command) | — | — | chat commands |
| Spectator mode ⬜ | `shipType: spec` | movement (free cam) | — | spectator UI | camera |
| Freq size limits ⬜ | — (`MaxPerTeam`) | assignment | — | freq msg | teams |

---

## 8. Social, chat & commands

Mostly Layer D + net; near-zero sim. Chat is a message stream, not world state.

| Feature | A — state | B/net | C — events | D — client | Deps |
|---|---|---|---|---|---|
| Public arena chat ✱ ⬜ | — | net message | `chat` | chat panel, hidden input | UI toolkit |
| Team / freq chat ⬜ | — | net message | `chat` | chat (color) | chat |
| Private messages ⬜ | — | net message | `chat` | chat | chat |
| Channel chat ⬜ | — | net message | `chat` | chat | chat |
| `?`commands ⬜ | — | command handler | — | — | chat |
| Chat colors by type ⬜ | — | — | — | bitmap-font tint | chat, fonts |
| Ticker messages ⬜ | — | net (`TickerDelay`) | `ticker` | ticker line | chat |
| Banners 🔭 | banner image | net | — | banner draw | (cosmetic, later) |

---

## 9. Client surfaces (Layer D only)

These read sim state / drain events; they never mutate the world. All text uses
the original **bitmap fonts in Pixi** (architecture §6).

| Surface | Reads | Notes |
|---|---|---|
| Energy bar + number ✅/🔶 | resources | `energy_font.png` digits |
| Item/status indicators ⬜ | loadout, status | icons.png; counts of repels/bursts/etc |
| Statbox / player list ✱ ⬜ | players, stats | name, bounty, squad, W/L/R; expands in menu |
| Minimap / radar ✱ ⬜ | players, flags | `MapZoomFactor`, `RadarMode`; radarh/radarv; flagger dots |
| Chat window ✱ ⬜ | chat stream | scrollback + hidden DOM input |
| Menu (F1/help/ship select/settings) ⬜ | — | menutext, hotkeys, ship pick |
| Name tags + bounty ⬜ | players | bitmap font over ship |
| Timer / arena clock ⬜ | tick | `led_font.png` |
| Kill feed / notifications ⬜ | `shipDied` events | notification area |
| Explosion anims ✅ | events | explode0–2, empburst |
| Exhaust / thrust ✅/🔶 | kinematics | exhaust.png |
| Cloak/stealth shimmer ⬜ | status | overlay |
| Warp-in / spawn anim ⬜ | `warp` events | — |
| Sound manager ⬜ | events | all original `.wav`s present |
| LVZ custom objects 🔭 | — | map/screen graphics; deferred |

---

## 10. Networking & infra (Phase 1)

| Feature | Notes |
|---|---|
| Authoritative server @100Hz ✱ ⬜ | runs `sim/` headless |
| Per-client snapshots ✱ ⬜ | `serializeSnapshotFor` (stealth/xradar/AOI filtering) |
| Client prediction + reconciliation ⬜ | local player; needs deterministic sim |
| Entity interpolation 🔶 | tick-interp machinery already exists |
| Input transport ⬜ | `InputCommand` over WebSocket |
| Lag compensation ⬜ | later polish |
| Accounts / persistence / leaderboards 🔭 | Phase 2 |

**Explicitly out of scope:** the original VIE/Continuum **encryption + wire
protocol** (we use our own WebSocket protocol — see README), map/LVZ downloading,
and audio chat (`AllowAudioMessages=0`).

---

## Reuse map (why the slicing matters)

The catalog reveals that the long weapon/item list collapses onto a few shared
systems. Build these well once and most features are config + a thin hook:

- **Projectile container + flight** → bullets, bombs, mines, thor, bursts, shrapnel.
- **Damage path** (radius, energy, shrapnel spawn) → bombs, mines, EMP, bullets, bursts.
- **Status system** → cloak, stealth, xradar, antiwarp, multifire, super, shields.
- **Items (impulse/spawn-on-use)** → repel, burst, decoy, portal, brick, rocket, warp.
- **Objectives** → flags, powerball, KotH (all "carry a thing, score a thing").
- **Prizes** → every green is one weighted table + a grant function.
- **UI toolkit** (bitmap font + models) → statbox, chat, minimap, menu, nametags.

This is the input to [roadmap.md](roadmap.md): sequence the *shared systems*
first, then the features that ride on them are cheap.
