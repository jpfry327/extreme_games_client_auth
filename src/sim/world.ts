import { WARBIRD, type ShipType } from "../config";
import { GameMap } from "./gamemap";
import { createPlayer } from "./player";
import { SeededRng } from "./rng";
import { findSpawn } from "./spawn";
import { collisionSystem } from "./systems/collision";
import { damageSystem } from "./systems/damage";
import { deathSystem } from "./systems/death";
import { firingSystem } from "./systems/firing";
import { movementSystem } from "./systems/movement";
import { projectileSystem } from "./systems/projectiles";
import { respawnSystem } from "./systems/respawn";
import { warpSystem } from "./systems/warp";
import type {
  Contact,
  GameEvent,
  Player,
  PlayerId,
  Projectile,
  StepContext,
  TeamId,
} from "./types";

/** The single local player's id. With no network yet, there's exactly one
 *  human player and the client owns it. (Networking assigns real ids in M2.) */
export const LOCAL_PLAYER_ID: PlayerId = "local";

/**
 * The whole game state for one tick — Layer A, the serializable nouns. The
 * world is keyed collections, not singletons: single-player is just "one player
 * among N", so nothing in the sim assumes a player count (architecture §2.1).
 *
 * `step(ctx)` advances everything by exactly one fixed tick. This is the piece
 * that would run, unchanged, on the server.
 */
export class World {
  tick = 0;
  players = new Map<PlayerId, Player>();
  projectiles: Projectile[] = [];

  /** Projectile↔ship overlaps found by the collision system (step 6) and
   *  consumed by the damage system (step 7). Transient, sim-internal, rebuilt
   *  every tick — never part of a snapshot. */
  contacts: Contact[] = [];

  /** Deterministic RNG — the sim never calls Math.random() (architecture §5.2). */
  rng: SeededRng;

  /** Events produced this tick (Layer C). Appended to during step(); the client
   *  drains and clears this once per drawn frame (see main.ts). */
  events: GameEvent[] = [];

  /** Which players currently hold the warp key (debug). Runtime-only, like
   *  `events`/`contacts` — never serialized. Lets `warpSystem` edge-trigger on the
   *  press instead of warping every tick of the hold. */
  warpHeld = new Set<PlayerId>();

  /** Which player this client controls / the camera follows. Server-side this
   *  has no meaning; it's a client convenience that rides along on the world.
   *  Set by main.ts after the server sends `welcome` (M2.1+). */
  localPlayerId: PlayerId = LOCAL_PLAYER_ID;

  /** Ownership scope for the **client-authoritative relay model** — the set of
   *  players this node is the *defender* for, i.e. the ones whose death/respawn
   *  this world is allowed to decide. `null` means "all players" (the legacy
   *  server-authoritative path and every single-world unit test). A client's
   *  `LocalSim` sets this to `{ localPlayerId }`; the server sets it to its bot(s).
   *  Players outside the scope are *mirrors* — present as collision targets but
   *  never killed/respawned here; their own defender decides that. */
  defends: Set<PlayerId> | null = null;

  /** Whether this node owns the scoreboard, i.e. may credit kills (kills++,
   *  bounty transfer, score) when a defended player it simulates dies. `true` on
   *  the authoritative server and the legacy single-world path; `false` on a
   *  client `LocalSim` (the server scores from the client's `DeathReport`
   *  instead, so the client never double-credits). */
  scoresKills = true;

  /** Whether this world is the defender for `id` (and thus may kill/respawn it). */
  defendsPlayer(id: PlayerId): boolean {
    return this.defends === null || this.defends.has(id);
  }

  /** Monotonically increasing counter for stable projectile ids. Incremented by
   *  the firing system each time a projectile is spawned, so snapshots can track
   *  entities across ticks without relying on object identity (architecture §5). */
  nextProjectileId = 0;

  constructor(
    public readonly map: GameMap,
    seed = 1,
    addLocalPlayer = true,
  ) {
    this.rng = new SeededRng(seed);
    if (addLocalPlayer) this.addPlayer(LOCAL_PLAYER_ID, "Player", 0, WARBIRD);
  }

  /** Convenience accessor for the client's own player. */
  get localPlayer(): Player {
    return this.players.get(this.localPlayerId)!;
  }

  /** Add a player at a fresh spawn point and return it. This is the one path
   *  for everyone who enters the world — the local player, the M1 bot, and the
   *  networked players of M2. */
  addPlayer(id: PlayerId, name: string, team: TeamId, shipType: ShipType): Player {
    const spawn = findSpawn(this.map, this.rng);
    const player = createPlayer(id, name, team, shipType, spawn.x, spawn.y);
    this.players.set(player.id, player);
    return player;
  }

  /**
   * Advance the simulation one fixed tick by running each system in order. The
   * order is itself a design decision (architecture §3): a system reads the
   * world as left by the systems before it. Steps not yet built are listed so
   * the intended shape stays visible — they're filled in over M4–M5.
   *
   *   1. intent       — (folded into movement/firing for now)
   *   2. movement     — rotate, thrust, drag, wall-bounce        ✅
   *   3. firing       — spawn projectiles; debit energy/cooldown ✅
   *   4. items        — repel/burst/decoy/…                       (M5)
   *   5. projectiles  — move, bounce, lifetime                    ✅
   *   6. collision    — projectile↔ship                          ✅ (M1)
   *   7. damage       — apply hits → energy; emit shipHit         ✅ (M1)
   *   8a. death       — kill credit, bounty, respawn timer        ✅ (M1)
   *   8b. respawn     — EnterDelay countdown, re-spawn            ✅ (M1)
   *   9. status       — toggle energy drain; expire timed effects (M5)
   *  10. resources    — energy recharge (in movement for now)     (M1+)
   *  11. prizes / 12. objectives / 13. regions                    (later)
   */
  step(ctx: StepContext): void {
    this.tick++;
    warpSystem(this, ctx);
    movementSystem(this, ctx);
    firingSystem(this, ctx);
    projectileSystem(this);
    collisionSystem(this);
    damageSystem(this);
    deathSystem(this);
    respawnSystem(this);
  }
}
