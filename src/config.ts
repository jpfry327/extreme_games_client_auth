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

// --- Networking (M2) ---------------------------------------------------------
// Client-side netcode tuning. The server's port + broadcast rate live in
// server/index.ts; these are values the browser client needs.
export const NET = {
  /** How far in the past (ms) remote entities are rendered, so the client always
   *  has two buffered snapshots straddling render time to interpolate between.
   *  ~100ms ≈ two snapshots at the 20Hz broadcast rate. Bigger = smoother under
   *  jitter but more visible lag on other ships. (roadmap M2.2 / architecture §5.2)
   *
   *  Failure mode it guards: too small and a single late/jittered snapshot leaves
   *  the buffer empty at render time, forcing extrapolation (below). Tuned against
   *  the network simulator to sit ~one jitter-spike above the 50ms broadcast gap. */
  interpDelayMs: 75,

  /** When the snapshot buffer starves (a lag spike or a run of dropped snapshots
   *  leaves no sample newer than render time), remote entities are dead-reckoned
   *  forward from their last known velocity for at most this long, then frozen in
   *  place. Caps how far a wrong guess can drift before the next snapshot snaps it
   *  back — a small visible glide instead of either a hard freeze or an unbounded
   *  fly-off. (roadmap M2.5: "extrapolation window + clamp") */
  extrapolateMaxMs: 100,

  /** Reconciliation correction smoothing (roadmap M2.5). When a snapshot corrects
   *  the predicted local ship, the residual error is absorbed into a render-offset
   *  that decays to zero with this half-life rather than snapping. Smaller =
   *  tighter/snappier correction; larger = floatier but gentler. 80ms ≈ the error
   *  is ~halved every 5 frames at 60fps, gone within ~a quarter second. */
  correctionHalfLifeMs: 80,

  /** A correction bigger than this (px) is treated as a teleport — a respawn or a
   *  genuine divergence — not a misprediction to smooth. Smoothing a map-spanning
   *  jump would slide the ship visibly across the screen, so beyond this we drop
   *  the offset and let it snap. ~9 ship-radii. */
  maxSmoothDistancePx: 128,

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

// --- Server-side lag compensation (M2.9) -------------------------------------
// "What you see is what you hit." The server adjudicates each projectile hit
// against where its targets were in the *firer's* view at the moment the shot
// was sampled — not the server's present — so a shot that visually connects on
// your screen registers despite the interpolation delay (~interpDelayMs) and the
// wire. The amount of rewind rides in each input (`InputCommand.renderTick`) and
// is stamped onto the spawned projectile (`Projectile.compTicks`), so the server
// stays a pure function of its inputs — the determinism contract still holds.
export const LAGCOMP = {
  /** Length of the server's per-tick pose-history ring (ticks). Must comfortably
   *  exceed the largest rewind we ever apply — interpDelay (~7.5t @75ms) + max
   *  RTT/2 + jitter — so a lookup `compTicks` ago is still in range. 120t = 1.2s
   *  @100Hz, matching the roadmap's sizing. Runtime-only; never serialized. */
  historyTicks: 120,

  /** Hard cap on a single projectile's `compTicks` (ticks). The dial on the
   *  favour-the-shooter trade: it bounds how far back a target can be rewound, so
   *  a very laggy — or spoofed — client can't reach arbitrarily far into the past,
   *  and — more importantly for *feel* — it bounds the "I dodged behind cover and
   *  still got hit" unfairness the rewind imposes on the *victim* (the cost lag
   *  comp pays to make the shooter feel instant). 15t = 150ms, the bottom of the
   *  roadmap's 150–250ms band: still comfortably covers interpDelay (~7.5t @75ms)
   *  + a ~75ms one-way link, so an 80–150ms-RTT player's shots still register,
   *  while a player above ~150ms RTT trades back to some under-compensation
   *  (bombs starting to pass through again) rather than inflicting a larger
   *  victim-side dodge-then-die window. Also implicitly capped by `historyTicks-1`
   *  (you can't rewind past what's recorded). */
  maxCompTicks: 15,
} as const;
