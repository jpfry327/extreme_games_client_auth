import { shipConfig } from "../../config";
import { moveAndCollide } from "../collision";
import type { GameMap } from "../gamemap";
import { isAlive, snapDirection, tierFor } from "../player";
import type { InputCommand, Player, StepContext } from "../types";
import type { World } from "../world";

/** A player with no input this tick coasts: no rotation, no thrust. */
const IDLE: InputCommand = {
  rotateLeft: false,
  rotateRight: false,
  thrust: false,
  reverse: false,
  afterburner: false,
  fire: false,
  bomb: false,
};

/**
 * Pipeline step 2 — movement. For each player: rotate, thrust along the snapped
 * heading, apply drag + speed cap, then move and bounce off walls.
 *
 * NOTE: energy recharge and weapon-cooldown countdown also happen here, exactly
 * where the prototype's `stepShip` ran them (recharge *before* firing). The
 * architecture eventually splits these into a dedicated `resources` system
 * (pipeline step 10); they stay here in M0 so the firing energy budget — and
 * thus gameplay — is byte-identical to the prototype. Moving them is a
 * deliberate later change, not an oversight.
 */
export function movementSystem(world: World, ctx: StepContext): void {
  for (const player of world.players.values()) {
    if (!world.defendsPlayer(player.id)) continue; // a mirror — its own node moves it
    if (!isAlive(player)) continue; // dead ships don't move or recharge
    stepPlayer(player, ctx.inputs.get(player.id) ?? IDLE, world.map);
  }
}

function stepPlayer(player: Player, input: InputCommand, map: GameMap): void {
  const k = player.kinematics;
  const res = player.resources;
  const config = shipConfig(player.shipType);
  const tier = tierFor(player);

  // Save the pose at the START of the tick for render interpolation.
  k.prevX = k.x;
  k.prevY = k.y;
  k.prevRotation = k.rotation;

  // --- Rotation (continuous) ---
  if (input.rotateLeft) k.rotation -= tier.rotationPerTick;
  if (input.rotateRight) k.rotation += tier.rotationPerTick;

  // --- Thrust along the snapped 40-direction heading ---
  const heading = snapDirection(k.rotation, config.directions);
  // rotation 0 points UP, so facing vector is (sin, -cos).
  const fx = Math.sin(heading);
  const fy = -Math.cos(heading);

  const ab = config.afterburner;
  const burning = input.afterburner && res.energy > ab.energyPerTick;
  const thrust = burning ? ab.thrust : tier.thrust;
  const maxSpeed = burning ? ab.maxSpeed : tier.maxSpeed;

  if (input.thrust) {
    k.vx += fx * thrust;
    k.vy += fy * thrust;
  }
  if (input.reverse) {
    k.vx -= fx * thrust;
    k.vy -= fy * thrust;
  }
  if (burning && (input.thrust || input.reverse)) {
    res.energy -= ab.energyPerTick;
  }

  // --- Drag + speed cap ---
  k.vx *= config.drag;
  k.vy *= config.drag;
  const speed = Math.hypot(k.vx, k.vy);
  if (speed > maxSpeed) {
    const scale = maxSpeed / speed;
    k.vx *= scale;
    k.vy *= scale;
  }

  // --- Move + wall bounce ---
  const r = moveAndCollide(map, k.x, k.y, k.vx, k.vy, config.radius, config.bounceFactor);
  k.x = r.x;
  k.y = r.y;
  k.vx = r.vx;
  k.vy = r.vy;

  // --- Energy recharge (see NOTE above re: pipeline placement) ---
  if (res.energy < res.maxEnergy) {
    res.energy = Math.min(res.maxEnergy, res.energy + res.recharge);
  }

  // --- Weapon cooldowns ---
  if (player.combat.bulletCooldown > 0) player.combat.bulletCooldown--;
  if (player.combat.bombCooldown > 0) player.combat.bombCooldown--;
}
