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
 * **Render-time adjudication (the "what you see is what hits you" fix).** Remote
 * bullets are *drawn* `interpDelay` in the past (on the same timeline as the remote
 * ships that fired them — see `remoteProjectiles.ts`), but were historically *hit-
 * tested* at the present, so a shot connected up to `interpDelay` of travel before
 * it visually reached you — you'd "dodge a bomb on screen and die anyway". To close
 * that gap each injected shot is **held out of the world for `incomingDelayTicks`
 * (≈ interpDelay)** before it starts flying, so at any present tick its sim pose
 * equals its drawn pose: the collision test then runs against the bullet exactly
 * where it's drawn. The owned ship is still tested at the present (where it too is
 * drawn — the local ship is never interpolated), so the overlap that kills you is
 * the overlap you can see. The bot's server-side `LocalSim` leaves the delay at 0
 * (a bot has no screen to be fair to, and present-time keeps it favouring itself).
 */

import { createPlayer } from "../sim/player";
import type { GameMap } from "../sim/gamemap";
import type { InputCommand, Player, PlayerId, Projectile } from "../sim/types";
import { World } from "../sim/world";
import { TICK_DT, type ShipType } from "../config";

/** An injected incoming shot waiting to start flying — held until the world reaches
 *  `releaseTick` so the shot is adjudicated where it's *drawn*, not ahead of it. */
interface PendingShot {
  proj: Projectile;
  releaseTick: number;
}

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

  /** Incoming shots queued by `injectIncoming`, released into the world once the
   *  world reaches each shot's `releaseTick` (see render-time adjudication above). */
  private pendingIncoming: PendingShot[] = [];

  /** How long (sim ticks) to hold an injected incoming shot before it starts
   *  flying, so it's adjudicated where it's drawn (≈ the client's interp delay).
   *  0 = adjudicate at the present (the default; the server's bot sim keeps this). */
  private incomingDelayTicks = 0;

  constructor(map: GameMap, defendedIds: readonly PlayerId[], seed = 1, scoresKills = false) {
    this.world = new World(map, seed, false);
    this.world.defends = new Set(defendedIds);
    this.world.scoresKills = scoresKills;
    this.defended = this.world.defends;
  }

  /** Set the incoming-shot adjudication delay from the client's live interpolation
   *  delay (ms → ticks), so injected remote shots are hit-tested where they're
   *  drawn (`now − interpDelay`) rather than at the present. Called each frame by
   *  the client; left at 0 on the server's bot sim. */
  setIncomingDelayMs(ms: number): void {
    this.incomingDelayTicks = Math.max(0, Math.round(ms / (1000 * TICK_DT)));
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

  /** Queue incoming remote shots (owner not defended) to be flown and adjudicated
   *  against the owned ship. Deduped by the per-owner id watermark, so the owner's
   *  redundant re-sends and a shot already spent here are ignored. Each new shot is
   *  held for `incomingDelayTicks` so it's adjudicated where it's drawn. */
  injectIncoming(projectiles: Iterable<Projectile>): void {
    for (const p of projectiles) {
      if (this.defended.has(p.owner)) continue; // our own shot — never self-adjudicate
      const watermark = this.lastInjectedId.get(p.owner);
      if (watermark !== undefined && p.id <= watermark) continue; // already injected / spent
      this.lastInjectedId.set(p.owner, p.id);
      this.pendingIncoming.push({
        proj: cloneProjectile(p),
        releaseTick: this.world.tick + this.incomingDelayTicks,
      });
    }
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
   *  (our own) are never touched — their ids live in a different namespace. */
  reconcileIncoming(reportedIds: ReadonlySet<number>): void {
    this.world.projectiles = this.world.projectiles.filter(
      (p) => this.defended.has(p.owner) || reportedIds.has(p.id),
    );
    this.pendingIncoming = this.pendingIncoming.filter((e) => reportedIds.has(e.proj.id));
  }

  /** Advance one authoritative tick with the owned player's intent. Releases any
   *  held incoming shots whose delay has elapsed first, so they're present for this
   *  tick's collision exactly when their drawn pose catches up to them. */
  step(inputs: Map<PlayerId, InputCommand>): void {
    if (this.pendingIncoming.length > 0) {
      const stillHeld: PendingShot[] = [];
      for (const e of this.pendingIncoming) {
        if (e.releaseTick <= this.world.tick) this.world.projectiles.push(e.proj);
        else stillHeld.push(e);
      }
      this.pendingIncoming = stillHeld;
    }
    this.world.step({ inputs });
  }

  /** Drop incoming shots queued but not yet flown — used when the client's loop
   *  resumed after the tab was suspended (the loop stalled despite the audio
   *  keep-alive), so a backlog of remote shots doesn't flush in a single tick as a
   *  lethal barrage. Favours the defender: while suspended it was "away" (the relay
   *  despawned it for others), so it doesn't retroactively eat those shots. The
   *  per-owner watermark still suppresses their re-injection from later snapshots. */
  clearIncoming(): void {
    this.pendingIncoming.length = 0;
  }

  /** The owned player's own live projectiles — what a client reports to the relay
   *  (it owns its shots) and what the server includes in snapshots for the bot. */
  ownProjectiles(): Projectile[] {
    return this.world.projectiles.filter((p) => this.defended.has(p.owner));
  }

  /** Drop own projectiles the client has cosmetically "spent" on an enemy hit
   *  (visual-only relay feedback — see `cosmeticHits.ts`). Only own (defended)
   *  shots are eligible; incoming injected shots are never touched. Safe because
   *  the defender already holds its own injected copy and adjudicates the real
   *  hit, so removing our local copy only stops the shot flying on / a missed bomb
   *  stray-detonating on a far wall — it never changes damage. */
  dropOwnProjectiles(shouldDrop: (id: number) => boolean): void {
    this.world.projectiles = this.world.projectiles.filter(
      (p) => !(this.defended.has(p.owner) && shouldDrop(p.id)),
    );
  }
}
