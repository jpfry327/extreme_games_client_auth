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
 * its *own* weapons (the defender does). Incoming remote shots, injected here and
 * flown at 100Hz, are tested against the owned ship at the **present** (favouring
 * the defender — no lag-comp rewind). Hits damage the owned ship; energy ≤ 0 kills
 * it locally; the node then reports the death.
 */

import { createPlayer } from "../sim/player";
import type { GameMap } from "../sim/gamemap";
import type { InputCommand, Player, PlayerId, Projectile } from "../sim/types";
import { World } from "../sim/world";
import type { ShipType } from "../config";

/** Bound on the remembered incoming-projectile ids (see `seen`). Comfortably
 *  larger than the live shot count; old ids are never re-reported once the owner's
 *  shot expires, so evicting the oldest is safe. */
const MAX_SEEN = 1024;

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

  /** Incoming-projectile ids already injected or spent here, so a redundant
   *  re-report (the owner re-sends live shots) isn't simulated twice. Insertion-
   *  ordered; evicts oldest past `MAX_SEEN`. */
  private readonly seen = new Set<number>();

  /** Incoming shots queued by `injectIncoming`, added to the world on the next
   *  `step` so they're flown and adjudicated on the same tick boundary as the
   *  owned ship. */
  private pendingIncoming: Projectile[] = [];

  constructor(map: GameMap, defendedIds: readonly PlayerId[], seed = 1, scoresKills = false) {
    this.world = new World(map, seed, false);
    this.world.defends = new Set(defendedIds);
    this.world.scoresKills = scoresKills;
    this.defended = this.world.defends;
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
   *  against the owned ship. Deduped by id against `seen`, so the owner's redundant
   *  re-sends and a shot already spent here are ignored. */
  injectIncoming(projectiles: Iterable<Projectile>): void {
    for (const p of projectiles) {
      if (this.defended.has(p.owner)) continue; // our own shot — never self-adjudicate
      if (this.seen.has(p.id)) continue; // already injected or spent here
      this.markSeen(p.id);
      this.pendingIncoming.push(cloneProjectile(p));
    }
  }

  /** Advance one authoritative tick with the owned player's intent. Injects any
   *  pending incoming shots first so they're present for this tick's collision. */
  step(inputs: Map<PlayerId, InputCommand>): void {
    if (this.pendingIncoming.length > 0) {
      for (const p of this.pendingIncoming) this.world.projectiles.push(p);
      this.pendingIncoming.length = 0;
    }
    this.world.step({ inputs });
  }

  /** Drop incoming shots queued but not yet flown — used when the client's loop
   *  resumed after the tab was suspended (the loop stalled despite the audio
   *  keep-alive), so a backlog of remote shots doesn't flush in a single tick as a
   *  lethal barrage. Favours the defender: while suspended it was "away" (the relay
   *  despawned it for others), so it doesn't retroactively eat those shots. The
   *  `seen` set still suppresses their re-injection from later snapshots. */
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

  private markSeen(id: number): void {
    this.seen.add(id);
    if (this.seen.size > MAX_SEEN) {
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
  }
}
