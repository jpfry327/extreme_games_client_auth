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

// --- Netcode: remote-player smoothing (M2.1, netcode §4) ---------------------
// How a remote opponent's motion is played back from position packets.
export const NET = {
  /** Length of the linear error-correction smear, in ticks. netcode §4 sets a
   *  200 ms correction; at 100 Hz that's 20 ticks. A received packet's position
   *  error is closed evenly over this many ticks. */
  lerpTicks: 20,

  /** Snap threshold, in tiles (per axis). If dead reckoning is off from a fresh
   *  packet by at least this much, we hard-warp instead of smoothing — netcode
   *  §4 uses 4 tiles. */
  snapTiles: 4,

  /** Ticks a received packet is assumed to have aged in flight, used to
   *  extrapolate a remote to its estimated present (netcode §4 `simTicks`).
   *  M2.1 placeholder: a fixed estimate (~half a send interval + a little
   *  latency). M2.4 replaces this with the clock-derived packet age. */
  ageTicks: 8,
} as const;

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
