/**
 * LocalSim — the authoritative *self* simulator for the client-authoritative
 * ("defender authority") relay model.
 *
 * Each node runs a `LocalSim` for the players it **owns/defends** — a client owns
 * its local ship; the relay server owns its bot. The owned ship is simulated at
 * 100Hz (movement, firing, and crucially collision→damage→death→respawn *for
 * itself*), so "if you die on your screen, that's authoritative". Everyone else is
 * a *mirror*: present only as read-only context (so a bot's AI can aim at them),
 * never moved/fired/killed here — their own node decides that. The sim systems are
 * unchanged; `World.defends` gates them (see `movement`/`firing`/`collision`/
 * `death`/`respawn`).
 *
 * The linchpin (see `collisionSystem`): the firer's own shots are skipped against
 * the only collision targets — the defended players — so a node never adjudicates
 * its *own* weapons (the defender does). Incoming remote shots are injected here
 * and flown at 100Hz. Hits damage the owned ship; energy ≤ 0 kills it locally; the
 * node then reports the death.
 *
 * **Present-time adjudication (the "what you see is what hits you" fix).** Remote
 * bullets are *drawn* at their **true present** (`now + lead`, dead-reckoned forward
 * — see `remoteProjectiles.ts`/`interpolation.ts`), so to hit-test where they're
 * drawn each injected shot is **caught up to the present on inject**: it's fast-
 * forwarded by the same `lead` the renderer draws it at, then free-runs at 100Hz.
 * Its sim pose then equals its drawn pose, and the owned ship is tested at the
 * present too (where it's drawn — the local ship is never interpolated), so the
 * overlap that kills you is the overlap you can see. This is Continuum's weapon
 * catch-up loop. The bot's server-side `LocalSim` leaves the lead at 0 (a bot has no
 * screen to match, and the small residual keeps it favouring itself).
 */

import { createPlayer, isAlive } from "../sim/player";
import type { GameMap } from "../sim/gamemap";
import type { InputCommand, Player, PlayerId, Projectile } from "../sim/types";
import { World } from "../sim/world";
import { stepProjectile } from "../sim/systems/projectiles";
import { overlaps } from "../sim/systems/collision";
import { TICK_DT, type ShipType } from "../config";

/** Cheap structural clone of an incoming projectile so injecting it into our world
 *  doesn't alias the snapshot's object (which the interpolator still reads). */
function cloneProjectile(p: Projectile): Projectile {
  return { ...p };
}

export class LocalSim {
  /** The authoritative world for the owned player(s) + injected incoming shots +
   *  read-only mirrors. Read by the caller for the owned pose/energy, own shots,
   *  and drained `events` (shipHit/shipDied/playerSpawned/bombExploded). */
  readonly world: World;

  /** The ids this sim owns and decides death/respawn for. */
  private readonly defended: Set<PlayerId>;

  /** Highest incoming-projectile id already injected, per owner. Projectile ids are
   *  monotonic per owner (`firingSystem` + the relay's per-owner id namespace), so
   *  a shot whose id is ≤ the owner's watermark has already been injected (the owner
   *  re-sends its live shots every report) or has long expired — either way it's
   *  skipped. O(1) per shot and one entry per owner, so unlike a fixed-size "seen"
   *  set there is no eviction window in which a still-live, still-re-sent shot could
   *  be re-injected as a phantom duplicate. */
  private readonly lastInjectedId = new Map<PlayerId, number>();

  /** Incoming-shot ids this sim has *consumed* — its injected copy died (it hit the
   *  owned ship or a wall) on this authoritative screen. The firer never adjudicates
   *  its own shots, so its copy of a shot that hit us keeps flying through us (a
   *  mirror) and is still reported/drawn as a remote — this lets the client suppress
   *  drawing that ghost so a bullet/bomb visibly *stops* where it hit, instead of
   *  sailing through. Pruned in `reconcileIncoming` once the id leaves the report. */
  private readonly consumedIncoming = new Set<number>();

  /** How far (sim ticks) to fast-forward an injected incoming shot so it's
   *  adjudicated at the present it's drawn at (≈ the client's render lead). 0 =
   *  adjudicate from the reported pose (the default; the server's bot keeps this). */
  private incomingLeadTicks = 0;

  constructor(map: GameMap, defendedIds: readonly PlayerId[], seed = 1, scoresKills = false) {
    this.world = new World(map, seed, false);
    this.world.defends = new Set(defendedIds);
    this.world.scoresKills = scoresKills;
    this.defended = this.world.defends;
  }

  /** Set the incoming-shot catch-up lead from the client's live forward-extrapolation
   *  lead (ms → ticks), so an injected remote shot is fast-forwarded to the present
   *  it's drawn at rather than adjudicated from its stale reported pose. Called each
   *  frame by the client; left at 0 on the server's bot sim. */
  setIncomingLeadMs(ms: number): void {
    this.incomingLeadTicks = Math.max(0, Math.round(ms / (1000 * TICK_DT)));
  }

  /** Add an owned player at a known spawn pose (e.g. the welcome handshake's spawn,
   *  so every node agrees on where this ship started). */
  addOwned(id: PlayerId, name: string, team: number, shipType: ShipType, x: number, y: number): Player {
    const player = createPlayer(id, name, team, shipType, x, y);
    this.world.players.set(id, player);
    return player;
  }

  /** The owned player (the local ship, or the bot). */
  owned(id: PlayerId): Player | undefined {
    return this.world.players.get(id);
  }

  /** Replace the read-only mirror players (everyone this sim does NOT own) with the
   *  latest known state — used by the relay server so its bot's AI can see the human
   *  ships. A pure client owns only itself and needs no mirrors. */
  setMirrors(players: Iterable<Player>): void {
    for (const id of [...this.world.players.keys()]) {
      if (!this.defended.has(id)) this.world.players.delete(id);
    }
    for (const p of players) {
      if (!this.defended.has(p.id)) this.world.players.set(p.id, p);
    }
  }

  /** Inject incoming remote shots (owner not defended) to be flown and adjudicated
   *  against the owned ship. Deduped by the per-owner id watermark, so the owner's
   *  redundant re-sends and a shot already spent here are ignored. Each new shot is
   *  **caught up to the present** by `incomingLeadTicks` so it's hit-tested where
   *  it's drawn (Continuum's weapon catch-up), then free-runs each `step`. */
  injectIncoming(projectiles: Iterable<Projectile>): void {
    for (const p of projectiles) {
      if (this.defended.has(p.owner)) continue; // our own shot — never self-adjudicate
      const watermark = this.lastInjectedId.get(p.owner);
      if (watermark !== undefined && p.id <= watermark) continue; // already injected / spent
      this.lastInjectedId.set(p.owner, p.id);

      // The reported pose is ~transit old; fast-forward by the same lead the renderer
      // draws it at so its logical pose matches its drawn pose. A shot that hits a
      // wall mid-catch-up arrives already dead — still pushed, so the damage step
      // detonates its (wall) blast exactly as it would for a live one.
      //
      // `stepProjectile` flies + bounces but never tests ship overlap, so we sweep the
      // collision test per tick and stop the catch-up at the first pose that overlaps a
      // defended ship — otherwise a point-blank shot fast-forwards clean *through* us
      // and is never adjudicated (the "I die on their screen but not mine" bug). Left
      // parked at the overlap, the next `step` flies it the rest of a tick (well inside
      // the ~32px hit zone at 4.1px/tick) and the collision step registers the hit.
      const proj = cloneProjectile(p);
      for (let i = 0; i < this.incomingLeadTicks && proj.alive; i++) {
        if (this.overlapsDefended(proj)) break; // would hit us here — let `step` adjudicate it
        stepProjectile(proj, this.world.map);
      }
      this.world.projectiles.push(proj);
    }
  }

  /** Whether `proj` overlaps any owned ship we'd adjudicate a hit against — the same
   *  test `collisionSystem` runs, used to stop the inject catch-up before a shot flies
   *  through us. Mirrors the system's guards (defended + alive; the firer can't be a
   *  defended target since its own shots are never injected). */
  private overlapsDefended(proj: Projectile): boolean {
    for (const id of this.defended) {
      const target = this.world.players.get(id);
      if (target && isAlive(target) && overlaps(proj, target)) return true;
    }
    return false;
  }

  /** Drop already-injected incoming shots that have vanished from the latest report,
   *  i.e. the owner's authoritative copy died (it hit a *wall* or a *third* player
   *  we don't simulate) before our adjudication copy finished its independent flight.
   *  Without this an injected shot keeps flying here forever and can kill us with a
   *  bullet that no longer exists anywhere else and has already left our screen.
   *
   *  `reportedIds` is the id set of the live remote shots in the newest snapshot.
   *  A shot absent from it has either died (retract — it can't keep being a threat)
   *  or merely left our area of interest; in the latter case it is ≥ a weapon's full
   *  reach away and can no longer hit us before expiring, so retracting it is safe
   *  and the per-owner watermark correctly never re-injects it. Defended-owner shots
   *  (our own) are never touched — their ids live in a different namespace.
   *
   *  This stays correct only because the firer reports each shot for its *whole*
   *  life (see `ownProjectiles`): a shot leaves the report when it truly dies, not
   *  when the firer cosmetically "spends" it on us — otherwise every hit would be
   *  retracted here a tick before it landed. */
  reconcileIncoming(reportedIds: ReadonlySet<number>): void {
    this.world.projectiles = this.world.projectiles.filter(
      (p) => this.defended.has(p.owner) || reportedIds.has(p.id),
    );
    // A consumed id that has left the report is no longer drawn as a remote, so it
    // never needs suppressing again — forget it to keep the set bounded to in-flight.
    for (const id of this.consumedIncoming) if (!reportedIds.has(id)) this.consumedIncoming.delete(id);
  }

  /** Whether incoming shot `id` was consumed on our screen (its injected copy died
   *  here). The client uses this to stop drawing the firer's still-flying remote
   *  copy of a shot that already hit us. */
  isIncomingConsumed(id: number): boolean {
    return this.consumedIncoming.has(id);
  }

  /** Advance one authoritative tick with the owned player's intent. Incoming shots
   *  are already in the world (caught up to the present on inject), so they just fly
   *  + adjudicate with this tick's collision. */
  step(inputs: Map<PlayerId, InputCommand>): void {
    // Record which incoming (non-owned) shots this step consumes: any in the world
    // before the step but gone after died here (hit our ship or a wall). Their firer
    // keeps flying + reporting its own copy, so the client suppresses drawing it.
    const incomingBefore: number[] = [];
    for (const p of this.world.projectiles) if (!this.defended.has(p.owner)) incomingBefore.push(p.id);

    this.world.step({ inputs });

    if (incomingBefore.length > 0) {
      const stillAlive = new Set<number>();
      for (const p of this.world.projectiles) if (!this.defended.has(p.owner)) stillAlive.add(p.id);
      for (const id of incomingBefore) if (!stillAlive.has(id)) this.consumedIncoming.add(id);
    }
  }

  /** Drop in-flight incoming shots — used when the client's loop resumed after the
   *  tab was suspended (the loop stalled despite the audio keep-alive), so a backlog
   *  of remote shots doesn't all adjudicate at once as a lethal barrage. Favours the
   *  defender: while suspended it was "away" (the relay despawned it for others), so
   *  it doesn't retroactively eat those shots. The per-owner watermark still
   *  suppresses their re-injection from later snapshots. */
  clearIncoming(): void {
    this.world.projectiles = this.world.projectiles.filter((p) => this.defended.has(p.owner));
  }

  /** The owned player's own live projectiles — what a client reports to the relay
   *  (it owns its shots) and what the server includes in snapshots for the bot.
   *
   *  This is reported for a shot's **whole life** — until it actually dies (wall /
   *  expiry) in this authoritative sim — even after the client has cosmetically
   *  "spent" it on an enemy (see `cosmeticHits.ts`, which only stops *drawing* it).
   *  That honesty is load-bearing: the defender's `reconcileIncoming` retracts an
   *  injected shot the instant it leaves the report, so a shot dropped here early
   *  would be yanked from the defender's sim before it could adjudicate the hit —
   *  the cause of "bullets/bombs do no damage". The firer never adjudicates its own
   *  shots, so keeping a spent shot flying costs nothing but its lingering corpse. */
  ownProjectiles(): Projectile[] {
    return this.world.projectiles.filter((p) => this.defended.has(p.owner));
  }
}
