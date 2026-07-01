# Netcode — client-authoritative, Subspace-faithful

This is the **contract** for M2 networking, the way [architecture.md](architecture.md)
is the contract for the sim. It supersedes the old server-authoritative assumption
sketched in architecture §5 (which predates this decision — that section is due a
revision pass).

The model is the *original* Subspace/Continuum model, not the Valve/Overwatch
server-authoritative one. It was chosen because it is **known-playable** (it ran
Subspace for 20+ years) and because it is the only model that reproduces the one
thing we are protecting: the local prototype's feel — opponents move smoothly and
their bullets/bombs come out of their ship with **zero visible lag**.

Two reference implementations were studied and corroborate each other:
- **Client:** [plushmonkey/nullspace](https://github.com/plushmonkey/nullspace)
  (`src/null/PlayerManager.cpp`, `WeaponManager.cpp`, `net/Connection.cpp`,
  `Clock.{h,cpp}`). Identical logic also lives in `plushmonkey/zero` under `zero/game/`.
- **Server:** [fcxcode/eg-asss](https://github.com/fcxcode/eg-asss)
  (`src/core/net.c`, `game.c`; `src/packets/*.h`).

---

## 0. The insight that makes it feel lag-free

The prototype already has the one property this whole model rests on: **a
projectile is a pure function of its spawn state + the map.** In
[firing.ts](../src/sim/systems/firing.ts) a projectile is created with
`{x, y, vx, vy, life, bounces, radius}`, and [projectiles.ts](../src/sim/systems/projectiles.ts)
advances it with no other inputs. Its entire future is fixed at spawn.

So we never stream projectile positions. We broadcast the **fire event once**
(folded into a position packet) and **every client simulates the projectile
forward locally**. That is precisely why an opponent's bullets appear instantly
at their ship — the same reason your local bot's bullets do today. There is no
per-frame weapon traffic and therefore no weapon lag by construction.

The rest of the design is: **keep the local sim exactly as it is for the ship you
own, and replace "the M1 bot" with "a remote player played back via
dead-reckoning."**

---

## 1. Authority model — who decides what

| Thing | Authority | Consequence |
|---|---|---|
| My ship's position / velocity / energy | **My client** | Simulated locally from my input, exactly like today. The server never corrects it. |
| My ship's **death** and who killed me | **My client (the victim)** | I detect the lethal hit against *myself* and announce "I died, killer = X". This is the classic Subspace "defender authority": lag disputes resolve in the victim's favour. |
| Remote ships' positions | Their client | I only *play back* what they assert; I never simulate their movement from input. |
| Projectiles | Spawned by a fire event, then simulated locally on every client | Deterministic-enough playback; no streaming. |
| Kill broadcast, score, bounty | Server (relays the victim's claim) | Reliable, ordered. |

Both references confirm the server runs **no physics**: it receives position
packets, does cheap validation, and re-broadcasts. eg-asss has no server-side
speed check, no energy simulation, and no teleport sanity check. Anti-cheat, when
it comes, is **client-integrity checksums** — never physics validation. Building
server physics validation would break the feel and depart from the proven model,
so we explicitly do not.

---

## 2. The key restructuring: two entity modes per client

Today [world.ts](../src/sim/world.ts) runs *every* player through the full
pipeline from a `StepContext` of inputs. Networked, each client splits players
into two modes.

**Local player (authoritative) — the full pipeline, unchanged:**

```
movement → firing → projectiles → collision(self) → damage(self) → death(self)
```

Runs from *my* input, exactly as it does now.

**Remote players (playback) — NOT input-driven:**
- Position/velocity come from received packets, advanced by **dead reckoning**:
  extrapolated forward through the *real* `movementSystem` physics so wall-bounces
  still look right (see §4).
- Their **fire events** spawn projectiles locally, reusing the `firingSystem`
  spawn logic seeded from the transmitted shooter pos/vel/rotation + weapon
  descriptor.
- I do **not** run their `damage`/`death`. I never decide a remote ship died.

### 2.1 Why we do NOT need cross-machine determinism

Because the **victim** is the only one who decides its own death, cross-client
projectile simulation only needs to look *visually* close — not be bit-exact. The
authoritative hit test runs on exactly one machine: the victim's, against its own
hull. So we do **not** need lockstep float determinism across machines (which JS
`Math.sin`/`cos` can't guarantee anyway).

Each client authoritatively simulates only: **(a)** its own ship, and **(b)**
incoming projectiles vs its own hull. Everything else is smoothed playback. This
removes the hardest problem in netcode before it starts. Short projectile
lifetimes make any shooter-vs-victim divergence a non-issue in practice — it is
how the original worked.

### 2.2 The one meaningful sim change

`damage` and `death` must operate only on the **local** player's own ship in
networked mode. Concretely: a `World.authoritativePlayerId`, with `damageSystem`
and `deathSystem` filtered to it. Single-player / bot mode still runs the full
pipeline for every player so M1-style local testing is unaffected.

---

## 3. Wire protocol

Weapon fire is folded **into the position packet** (a 2-byte weapon descriptor),
exactly like both references — there is no separate C2S "fire" message.

| Packet | Dir | Channel | Notes |
|---|---|---|---|
| **Position** (rotation, x, y, vx, vy, energy, bounty, status bits, **weapon**, tick) | C2S → relay → S2C | **unreliable** | ~10 Hz (min every 5 ticks); **plus one immediately on every shot** — this is what makes fires feel instant. Server stamps sender id + measured `c2slatency`. |
| **Death** (killerId, bounty) | C2S | reliable | The victim announces its own death. |
| **Kill** (killer, killed, bounty, flags, green) | S2C | reliable | Server validates the named killer, then rebroadcasts to all. |
| **Enter / Leave** (player joined/left + identity) | S2C | reliable | Roster management. |
| **Time sync** (echo client tick + server tick) | both | special | Clock offset + RTT estimation (§5). |
| Chat, ship/freq change, prize | both | reliable | Later milestones (M3+). |

The weapon descriptor mirrors the original `struct Weapons`: `{ type, level,
bouncing, shrapLevel, shrap, alternate }`, mapping onto our `ProjectileKind` +
`Loadout.gunLevel` / `bombLevel`.

Encoding note: the original packs these into tight fixed-point structs (position
×16, velocity ×160). We can start with a straightforward binary or even JSON
encoding behind `protocol.ts` and tighten later; the *shape* is what matters now.

---

## 4. Remote-player smoothing — the "no visible lag" algorithm

This is the heart of the feel. Adapted from nullspace's `OnPositionPacket` to our
`Kinematics`. On receiving a position packet from remote player P, aged
`simTicks` ticks (flight time + clock offset, from §5):

1. Save P's currently-rendered position.
2. Hard-set P's `kinematics` to the packet's `{x, y, vx, vy, rotation}`.
3. **Extrapolate forward `simTicks` ticks** through the real movement physics →
   `projected` (where P should be *right now*).
4. Restore the rendered position; compute `error = projected − rendered`.
5. **Decide:**
   - `|error|` ≥ **4 tiles** on either axis, or the warp/flash status bit is set
     → **snap** to `projected` (play the warp effect).
   - else → set a **200 ms linear correction**: `lerpVelocity = error / 0.2s`,
     applied on top of real velocity and decayed to zero over 200 ms.
6. Every frame, P advances by `velocity·dt + lerpVelocity·dt`. The existing
   `prevX/prevY` + `alpha` interpolation in the renderer draws the sub-tick blend.

Net effect: opponents render at the **estimated present**, coasting at their last
known velocity, with any correction smeared invisibly across 200 ms. No
interpolation-in-the-past delay — that is the entire point, and the difference
from the server-authoritative model.

Freeze and hide any player not heard from within a timeout (~2 s / 200 ticks,
`kPlayerTimeout`).

---

## 5. Time & clock sync

Run the **100 Hz tick** we already have ([loop.ts](../src/sim/loop.ts),
`TICK_DT`). Add:

- A `serverTimeOffset`, estimated from periodic sync packets: the client sends its
  tick; the server echoes it and stamps its own tick. Average over a ring buffer
  (~32 samples) to resist jitter; snap tiny offsets to 0.
- Stamp each outgoing position with `localTick + offset` (server time). Force it
  monotonic (bump if ≤ the last one sent) — the server discards non-newer positions.
- On receive, compute the packet's age in ticks → that is the `simTicks` fed into
  the extrapolation in §4. Drop packets older than ~3 s as a desync guard.

The server also measures staleness per incoming position (`c2slatency = now −
packet.time`) and stamps it into the relayed packet so downstream clients can
lag-compensate. RTT/ping falls out of the reliable-channel ACK round trips.

---

## 6. Server — the Node relay

Deliberately thin. **No `World`, no `step()`.**

1. Accept connections, assign player ids, maintain the roster.
2. Keep only **last-known position per player** (for area-of-interest distance).
3. On a position packet: cheap-validate (length, optional checksum, player is
   playing) → **repack** (stamp sender id + `c2slatency`) → fan out to relevant
   players.
4. Area-of-interest: forward to players whose screen (`xres + yres`) could contain
   the sender, with a longer range for weapons. **For the M2 lobby, start by
   sending everyone everything** — architecture §5.1 says build the per-client
   seam but ship the trivial version first.
5. Death packet: validate the named killer exists and is in-arena → broadcast a
   reliable Kill → drive score/bounty.
6. Multiplex the reliable and unreliable channels (see §7).

This mirrors eg-asss exactly: a relay + validator + fan-out, not a simulator.

---

## 7. Transport — the one real decision

Browsers cannot do raw UDP, so the original's hand-rolled reliable/unreliable UDP
layer must be mapped onto a web transport. Options:

- **WebSocket (TCP)** — simplest, universal, trivial in Node (`ws`). Downside:
  head-of-line blocking, no true unreliable channel.
- **WebTransport (HTTP/3 / QUIC)** — real unreliable datagrams *and* reliable
  streams; the cleanest match. Downside: Node server support is still immature;
  browser support skews Chromium.
- **WebRTC DataChannels** — true unordered/unreliable mode. Downside: signalling
  + STUN/TURN complexity, heavier Node side.

**Decision: a transport interface exposing `sendReliable()` / `sendUnreliable()`,
shipped on WebSocket for M2.** This design tolerates TCP unusually well because
*nothing depends on ordering for correctness* — position packets need only
freshness, and the dead-reckoning in §4 masks the jitter TCP introduces. Stale
outbound positions are dropped client-side. Swapping the unreliable channel to
WebTransport datagrams later is a contained change behind the interface, and is
the right move only if we start targeting higher-latency / lossier networks.

---

## 8. Module map

Extends the tree in architecture §7. The sim under `src/sim/` stays **almost
untouched** — its purity is what lets it run on both sides (the only change is
§2.2).

```
src/net/
  transport.ts      # interface: sendReliable/sendUnreliable + onMessage; WebSocket impl
  protocol.ts       # packet encode/decode (position, death, kill, sync, enter/leave)
  clock.ts          # tick + serverTimeOffset (sync packet handling)
  remotePlayers.ts  # dead-reckoning + 200ms lerp + snap (§4); drives non-local Players
  localPlayer.ts    # samples input → runs authoritative sim → emits position/death
  session.ts        # connection lifecycle, roster, wires the above into the frame loop
server/             # Node relay (separate entry): connections, roster, AOI fan-out, kill validate
```

---

## 9. Risks / gotchas

- **Config parity is non-negotiable.** Every client derives projectile velocity
  from `config.ts` (`shooterVel + heading·weaponSpeed`). All clients must share
  identical weapon/ship config or bullets diverge. Keep [config.ts](../src/config.ts)
  the single source of truth and, ideally, have the server ship config on join.
- **No cross-machine float determinism needed** (§2.1) — but shooter and victim
  should agree closely enough that the victim's self-hit feels fair. Short
  projectile lifetimes make this a non-issue.
- **The `damage`/`death` split (§2.2)** is the one place the pipeline meaningfully
  changes. Scope it so single-player/bot mode still runs the full pipeline.
- **Anti-cheat is deferred by design.** The faithful model trusts the client; real
  defense is client-integrity checksums (eg-asss `security.c`), not physics.
- **Docs to revise alongside this:** architecture §5 still describes the old
  server-authoritative assumption and should be updated to point here.
