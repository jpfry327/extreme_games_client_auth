/**
 * ============================================================================
 *  TUNING CONFIG  —  edit numbers here to change how the game feels.
 * ============================================================================
 *
 * Ship + weapon values are ported from the REAL Extreme Games Warbird config
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
 * Where the EG config gives both "Initial" and "Maximum" values, we use the
 * INITIAL values — that's a freshly-spawned, un-upgraded Warbird. (Real
 * Subspace raises these toward Maximum as you collect green prizes; once we add
 * prizes, that's the ramp we'll implement.)
 */

const DEG_TO_RAD_TICK = Math.PI / 20000; // raw rotation -> radians/tick

// --- Simulation clock --------------------------------------------------------
export const TICK_HZ = 100; // Subspace runs the sim at 100Hz
export const TICK_DT = 1 / TICK_HZ; // seconds per tick (0.01s)

// --- Map ---------------------------------------------------------------------
export const TILE_SIZE = 16; // each tile is 16x16 px (Subspace standard)
export const MAP_TILES = 1024; // svs map is 1024x1024 tiles
export const WORLD_SIZE = MAP_TILES * TILE_SIZE; // 16384 px square

// --- Ship: Warbird (Extreme Games, Initial values) ---------------------------
// The ship has 40 discrete facing directions (matching the 40 sprite frames).
// Rotation accumulates continuously, but thrust + the drawn frame snap to the
// nearest of these 40 directions — Subspace's distinctive "stepped" turn.
export const SHIP = {
  directions: 40,

  rotationPerTick: 300 * DEG_TO_RAD_TICK, // InitialRotation=300 -> 0.0471 rad/tick
  thrust: 30 / 1000, // InitialThrust=30   -> 0.030 px/tick^2
  maxSpeed: 3200 / 1000, // InitialSpeed=3200  -> 3.2 px/tick

  maxEnergy: 1650, // InitialEnergy=1650
  rechargeRate: 3000 / 1000, // InitialRecharge=3000 -> 3.0 energy/tick

  radius: 14, // Radius=0 means "use default" = 14 px (matches svs xRadius/yRadius)
  bounceFactor: 0.727, // svs value; corresponds to EG [Misc] BounceFactor=26

  // Afterburner (hold Shift) is a modern extra — classic Subspace has no
  // afterburner. Tuned by feel, not from the EG config.
  afterburnerMaxSpeed: 5.0,
  afterburnerThrust: 0.06,
  afterburnerEnergyPerTick: 5,

  // Classic Subspace is frictionless (space!). Set to 1.0 for authentic EG
  // coasting; lower it slightly (e.g. 0.999) if you prefer the ship to settle.
  drag: 1.0,
};

// --- Bullet (Warbird gun) ----------------------------------------------------
export const BULLET = {
  speed: 4100 / 1000, // BulletSpeed=4100   -> 4.1 px/tick (added to ship velocity)
  fireDelayTicks: 6, // BulletFireDelay=6  (energy cost is what really gates it)
  lifetimeTicks: 65, // BulletAliveTime=65 ticks (~0.65s)
  fireEnergy: 22, // BulletFireEnergy=22
  damage: 210, // BulletDamageLevel=210 (unused until we add combat)
  radius: 2,
  bounces: Infinity, // EG bullets bounce until their lifetime runs out
};

// --- Bomb (Warbird, fired with Tab) -----------------------------------------
export const BOMB = {
  speed: 4300 / 1000, // BombSpeed=4300     -> 4.3 px/tick
  fireDelayTicks: 175, // BombFireDelay=175  (~1.75s between bombs)
  lifetimeTicks: 250, // BombAliveTime=250 ticks (~2.5s)
  fireEnergy: 325, // BombFireEnergy=325
  damage: 5600, // BombDamageLevel=5600 (unused until we add combat)
  radius: 4,
  bounces: 0, // BombBounceCount=0
};
