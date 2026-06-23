import { SHIP } from "../config";
import { moveAndCollide } from "./collision";
import type { GameMap } from "./gamemap";
import type { InputCommand, ShipState } from "./types";

export function createShip(x: number, y: number): ShipState {
  return {
    x,
    y,
    vx: 0,
    vy: 0,
    rotation: 0,
    energy: SHIP.maxEnergy,
    bulletCooldown: 0,
    bombCooldown: 0,
    prevX: x,
    prevY: y,
    prevRotation: 0,
  };
}

/**
 * Snap a continuous angle to the nearest of the ship's N facing directions.
 * Subspace ships turn in 40 discrete steps; thrust is applied along the snapped
 * heading, which is part of what makes the movement feel the way it does.
 */
export function snapDirection(rotation: number, directions: number): number {
  const step = (Math.PI * 2) / directions;
  return Math.round(rotation / step) * step;
}

/** Advance the ship by exactly one simulation tick. Mutates `ship`. */
export function stepShip(ship: ShipState, input: InputCommand, map: GameMap): void {
  // Save the pose at the START of the tick for render interpolation.
  ship.prevX = ship.x;
  ship.prevY = ship.y;
  ship.prevRotation = ship.rotation;

  // --- Rotation (continuous) ---
  if (input.rotateLeft) ship.rotation -= SHIP.rotationPerTick;
  if (input.rotateRight) ship.rotation += SHIP.rotationPerTick;

  // --- Thrust along the snapped 40-direction heading ---
  const heading = snapDirection(ship.rotation, SHIP.directions);
  // rotation 0 points UP, so facing vector is (sin, -cos).
  const fx = Math.sin(heading);
  const fy = -Math.cos(heading);

  const burning = input.afterburner && ship.energy > SHIP.afterburnerEnergyPerTick;
  const thrust = burning ? SHIP.afterburnerThrust : SHIP.thrust;
  const maxSpeed = burning ? SHIP.afterburnerMaxSpeed : SHIP.maxSpeed;

  if (input.thrust) {
    ship.vx += fx * thrust;
    ship.vy += fy * thrust;
  }
  if (input.reverse) {
    ship.vx -= fx * thrust;
    ship.vy -= fy * thrust;
  }
  if (burning && (input.thrust || input.reverse)) {
    ship.energy -= SHIP.afterburnerEnergyPerTick;
  }

  // --- Drag + speed cap ---
  ship.vx *= SHIP.drag;
  ship.vy *= SHIP.drag;
  const speed = Math.hypot(ship.vx, ship.vy);
  if (speed > maxSpeed) {
    const k = maxSpeed / speed;
    ship.vx *= k;
    ship.vy *= k;
  }

  // --- Move + wall bounce ---
  const r = moveAndCollide(map, ship.x, ship.y, ship.vx, ship.vy, SHIP.radius, SHIP.bounceFactor);
  ship.x = r.x;
  ship.y = r.y;
  ship.vx = r.vx;
  ship.vy = r.vy;

  // --- Energy recharge ---
  if (ship.energy < SHIP.maxEnergy) {
    ship.energy = Math.min(SHIP.maxEnergy, ship.energy + SHIP.rechargeRate);
  }

  // --- Weapon cooldowns ---
  if (ship.bulletCooldown > 0) ship.bulletCooldown--;
  if (ship.bombCooldown > 0) ship.bombCooldown--;
}
