/**
 * ============================================================================
 *  TUNING CONFIG  —  edit numbers here to change how the game feels.
 * ============================================================================
 *
 * Ship + weapon values are ported from the REAL Extreme Games config
 * (original_data/extreme_games_config.ini). That file stores values in classic
 * Subspace integer units; the conversions below turn them into the per-tick
 * units our 100Hz simulation uses. The conversions were validated against the
 * svs settings.json (e.g. its rotation 0.051836 back-solves to a raw rotation
 * of ~330, exactly between EG's Initial 300 and Maximum 360).
 *
 *   Subspace raw  ->  our per-tick unit
 *   ----------------------------------------------------------------
 *   Speed         ->  px/tick   = raw / 1000          (3200 -> 3.2)
 *   Thrust        ->  px/tick^2 = raw / 1000          (30   -> 0.030)
 *   Rotation      ->  rad/tick  = raw * PI / 20000    (300  -> 0.0471)
 *   Recharge      ->  energy/tick = raw / 1000        (3000 -> 3.0)
 *   Energy        ->  used directly                   (1650)
 *   AliveTime     ->  ticks, used directly  (value is in 1/100 s)
 *   FireDelay     ->  ticks, used directly  (value is in 1/100 s)
 *   FireEnergy    ->  used directly
 *
 * Per the architecture (§2.5), tunables live in tables keyed by ship type, with
 * an Initial AND a Maximum tier. A fresh Warbird flies at Initial; collecting
 * green prizes ramps it toward Maximum (the lobby default, wired in M4). M0
 * keeps spawning at Initial so gameplay is unchanged from the prototype.
 */

const DEG_TO_RAD_TICK = Math.PI / 20000; // raw rotation -> radians/tick

// --- Simulation clock --------------------------------------------------------
export const TICK_HZ = 100; // Subspace runs the sim at 100Hz
export const TICK_DT = 1 / TICK_HZ; // seconds per tick (0.01s)

// --- Map ---------------------------------------------------------------------
export const TILE_SIZE = 16; // each tile is 16x16 px (Subspace standard)
export const MAP_TILES = 1024; // svs map is 1024x1024 tiles
export const WORLD_SIZE = MAP_TILES * TILE_SIZE; // 16384 px square

// --- Ship type identity ------------------------------------------------------
// Subspace has 8 ships, indexed 0..7 (Warbird..Shark). "spectator" is a
// non-flying observer slot. M0 only fills in the Warbird.
export type ShipType = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
export const WARBIRD: ShipType = 0;

/** Per-tier movement + survivability stats. EG gives an Initial and a Maximum;
 *  green prizes interpolate between them. (See the file header for units.) */
export interface ShipTier {
  rotationPerTick: number; // rad/tick
  thrust: number; // px/tick^2
  maxSpeed: number; // px/tick
  maxEnergy: number;
  rechargeRate: number; // energy/tick
}

/** Settings for one weapon (gun or bomb) at fire time + in flight. */
export interface WeaponConfig {
  speed: number; // px/tick, added to the firer's velocity
  fireDelayTicks: number; // cooldown between shots
  lifetimeTicks: number; // ticks before it ages out
  fireEnergy: number; // energy debited per shot
  damage: number; // applied to a hit ship (unused until M1 combat)
  radius: number; // collision half-extent, px
  bounces: number; // wall bounces before it dies (Infinity = bounce forever)
}

/** Everything tunable about one ship, ported from its EG `.ini` section. */
export interface ShipConfig {
  name: string;
  directions: number; // discrete facing steps (and sprite frames)
  radius: number; // ship collision half-extent, px
  bounceFactor: number; // wall-bounce velocity retention
  drag: number; // velocity retained per tick (1.0 = frictionless space)

  // Afterburner (hold Shift) is a modern extra — classic Subspace has none.
  // Tuned by feel, not from the EG config.
  afterburner: { maxSpeed: number; thrust: number; energyPerTick: number };

  initial: ShipTier; // freshly-spawned, un-upgraded
  maximum: ShipTier; // fully prized-up (lobby default from M4 on)

  bullet: WeaponConfig;
  bomb: WeaponConfig;
}

// --- The ship table ----------------------------------------------------------
// Only the Warbird is authored in M0 (per the roadmap). The remaining 7 are
// added in M4 straight from the `.ini`. `Partial` keeps that honest: TypeScript
// forces callers through `shipConfig()`, which throws on an unauthored ship
// rather than silently flying a phantom.
export const SHIPS: Partial<Record<ShipType, ShipConfig>> = {
  [WARBIRD]: {
    name: "Warbird",
    directions: 40,
    radius: 14, // Radius=0 means "use default" = 14 px (matches svs xRadius/yRadius)
    bounceFactor: 16 / 26, // EG [Misc] BounceFactor=26 -> retention 16/N = 0.615
                           //   (N=16 is lossless; svs ran a bouncier 22 = 0.727)
    drag: 1.0, // classic Subspace is frictionless (space!)
    afterburner: { maxSpeed: 5.0, thrust: 0.06, energyPerTick: 5 },

    initial: {
      rotationPerTick: 300 * DEG_TO_RAD_TICK, // InitialRotation=300 -> 0.0471 rad/tick
      thrust: 30 / 1000, // InitialThrust=30   -> 0.030 px/tick^2
      maxSpeed: 3200 / 1000, // InitialSpeed=3200  -> 3.2 px/tick
      maxEnergy: 1650, // InitialEnergy=1650
      rechargeRate: 3000 / 1000, // InitialRecharge=3000 -> 3.0 energy/tick
    },
    maximum: {
      rotationPerTick: 360 * DEG_TO_RAD_TICK, // MaximumRotation=360
      thrust: 33 / 1000, // MaximumThrust=33
      maxSpeed: 3500 / 1000, // MaximumSpeed=3500
      maxEnergy: 2800, // MaximumEnergy=2800
      rechargeRate: 4200 / 1000, // MaximumRecharge=4200
    },

    bullet: {
      speed: 4100 / 1000, // BulletSpeed=4100 -> 4.1 px/tick
      fireDelayTicks: 6, // BulletFireDelay=6 (energy cost is what really gates it)
      lifetimeTicks: 65, // BulletAliveTime=65 ticks (~0.65s)
      fireEnergy: 22, // BulletFireEnergy=22
      damage: 210, // BulletDamageLevel=210 (unused until M1)
      radius: 2,
      bounces: Infinity, // EG bullets bounce until their lifetime runs out
    },
    bomb: {
      speed: 4300 / 1000, // BombSpeed=4300 -> 4.3 px/tick
      fireDelayTicks: 175, // BombFireDelay=175 (~1.75s between bombs)
      lifetimeTicks: 250, // BombAliveTime=250 ticks (~2.5s)
      fireEnergy: 325, // BombFireEnergy=325
      damage: 5600, // BombDamageLevel=5600 (unused until M1)
      radius: 4,
      bounces: 0, // BombBounceCount=0
    },
  },
};

/** Look up a ship's config, throwing if it isn't authored yet. Use this rather
 *  than indexing `SHIPS` directly so an unfinished ship fails loudly. */
export function shipConfig(type: ShipType): ShipConfig {
  const cfg = SHIPS[type];
  if (!cfg) throw new Error(`No ShipConfig authored for ship type ${type}`);
  return cfg;
}

// --- Combat & scoring (M1) ---------------------------------------------------
// Arena-wide combat rules, ported from the EG `.ini`. Unlike ship stats these
// aren't per-ship — they're properties of the game mode. (Per-weapon damage
// already lives on each ship's `bullet`/`bomb` WeaponConfig above.)
export const COMBAT = {
  /** [Bomb] BombExplodePixels — radius of a bomb's blast. A bomb deals its full
   *  damage at the center and falls off linearly to 0 at this distance. */
  bombExplodePixels: 18,

  /** [Kill] EnterDelay — ticks a killed player waits before respawning. 200
   *  ticks @100Hz = 2s, the EG lobby value. */
  enterDelayTicks: 200,

  /** [Kill] BountyIncreaseForKill — flat bounty the killer gains per kill. The
   *  victim's own bounty is also rolled into the killer's *score* (below). */
  bountyIncreaseForKill: 10,

  /** [Kill] RewardBase — flat points per kill, on top of the victim's bounty.
   *  EG runs this at 0 (score is purely the victim's bounty). */
  killPointsBase: 0,
} as const;

// --- Upstream state-report pacing (relay model) ------------------------------
// In the client-authoritative relay model the client owns its ship and reports
// its authoritative *state* (`net/reportSender.ts`), paced to this cadence. State
// is last-wins, so a dropped report is simply superseded by the next — no
// redundancy or retransmit needed (unlike the old input stream).
export const INPUT = {
  /** Uplink flush cadence (ms). ~16ms ≈ one per render frame ≈ 60Hz, so a report
   *  leaves essentially the same instant the state is produced → ~0 added uplink
   *  latency. Raise toward ~33ms (~30Hz) to cut packets at the cost of up to that
   *  much added uplink latency (NOT the downstream view of other players). */
  sendIntervalMs: 16,
} as const;

// --- Relay server (client-authoritative model) -------------------------------
// Server-side tunables for the mirror/relay (net/relayHost.ts) — NOT browser
// values (those are in NET below).
export const RELAY = {
  /** If a client sends no state report for this long (ms), the server treats it
   *  as "away" and stops relaying its (now-frozen) ship to the other clients — a
   *  clean despawn, the minimal precursor to spectator mode. It reappears the
   *  instant a report resumes. Comfortably above the ~16ms report cadence + normal
   *  jitter so a live-but-slow client is never falsely hidden, yet low enough that
   *  a truly suspended tab (its self-sim loop stalled) stops being an unkillable
   *  frozen target within ~2s. The defender model can't kill a sleeping ship, so
   *  the relay simply removes it from view until it wakes. */
  inactiveTimeoutMs: 2000,
} as const;

// --- Networking (M2) ---------------------------------------------------------
// Client-side netcode tuning. The server's port + broadcast rate live in
// server/index.ts; these are values the browser client needs.
export const NET = {
  /** Forward dead-reckoning lead (ms) — how far *ahead* the client extrapolates
   *  remote entities so they're drawn (and incoming shots adjudicated) at their
   *  **true present**, the Subspace/Continuum model (it dead-reckons remotes to
   *  now, it does NOT render them in the past). The per-frame lead is estimated
   *  from the link — `(localPing/2 + remotePing/2) + ½ snapshot-interval` — and
   *  clamped here; see `computeLeadMs` in main.ts.
   *
   *  This replaced the old "render ~interpDelay in the past" model (below), which
   *  was the root cause of the laggy defender-authority feel: the attacker aimed at
   *  the target's *past* while the defender adjudicated near its *present*, a gap of
   *  `interpDelay + RTT` that dominated even locally. Drawing/adjudicating at the
   *  present collapses that gap to the un-modeled-motion residual. */
  lead: {
    /** Floor (ms). Locally (≈0 ping) the lead is just ½ the broadcast interval. */
    minMs: 0,
    /** Ceiling (ms). Caps how far we project a high-ping remote; beyond this the
     *  defender is simply favoured by the excess latency (no lag comp, by design).
     *  Kept ≤ `extrapolateMaxMs` so a normal lead is never clipped by the cap. */
    maxMs: 120,
  },

  /** Total forward dead-reckoning budget (ms) past the newest snapshot, = the
   *  steady-state `lead` PLUS any staleness when snapshots stop arriving. Under
   *  normal flow this is `lead + ~½ interval` (well under the cap); on a lag spike
   *  or a run of dropped snapshots the entity keeps coasting on last velocity until
   *  it hits this cap, then freezes — a small visible glide instead of a hard
   *  freeze or an unbounded fly-off. Must exceed `lead.maxMs` so a normal lead is
   *  never clipped. (roadmap M2.5: "extrapolation window + clamp") */
  extrapolateMaxMs: 200,

  /** Default in-transport network-simulator parameters (roadmap M2.5). Applied
   *  symmetrically to each direction (client→server inputs and server→client
   *  snapshots). Off by default; toggled and tuned live from the #netsim debug
   *  panel so bad conditions are reproducible on demand. These are the *defaults*
   *  the panel initializes to — the live values live on the SimulatedTransport. */
  netSim: {
    enabled: false,
    /** One-way base added latency, ms, each direction (so ~2× added RTT). */
    latencyMs: 80,
    /** Uniform ± jitter, ms, added to each packet's latency (reorders packets). */
    jitterMs: 30,
    /** Per-packet drop chance, percent, each direction. */
    lossPct: 3,
  },
} as const;

// --- Area-of-interest culling (M2.14) ----------------------------------------
// Each client is sent only the entities near it — the per-client snapshot filter
// (`net/aoi.ts`) mirrors Subspace's `max(WeaponRange, screen)` rule. M2.14 does
// distance culling only; stealth/cloak concealment plugs into the same filter in
// M5. Snapshot size then scales with local density, not arena population.

/** Longest distance (px) any weapon can travel = max over authored ships of
 *  `speed * lifetimeTicks` (a bullet bounces but still dies at its lifetime, so
 *  that product is its true reach). Recomputed from `SHIPS` so it tracks config
 *  as the remaining ships are authored in M4. Floored so a partial table still
 *  yields a sane AOI. */
function computeWeaponReach(): number {
  let reach = 512; // floor — covers an empty/partial ship table
  for (const ship of Object.values(SHIPS)) {
    if (!ship) continue;
    reach = Math.max(
      reach,
      ship.bullet.speed * ship.bullet.lifetimeTicks,
      ship.bomb.speed * ship.bomb.lifetimeTicks,
    );
  }
  return reach;
}

export const AOI = {
  /** Screen half-extents (px) a client can see around its ship. The include test
   *  is rectangular (a viewport, like Subspace) expanded by `weaponReach` on each
   *  axis — i.e. you receive anything on your screen OR close enough to shoot you,
   *  which is the `max(WeaponRange, screen)` rule in AABB form. ~1520×1200 view. */
  viewHalfWidth: 760,
  viewHalfHeight: 600,
  /** Longest weapon reach (px), derived from `SHIPS` (see above). Added to the
   *  view half-extents so a long-range bomb stream is received before it's drawn. */
  weaponReach: computeWeaponReach(),
  /** Hysteresis band (px) added to the include box for entities the viewer
   *  already received last broadcast, so an entity hovering at the boundary
   *  doesn't flicker in/out every frame. ~2 ship-radii of slack. */
  hysteresisPx: 96,
} as const;
