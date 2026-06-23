/**
 * Shared simulation types. This module (and everything under src/sim/) is pure
 * game logic with NO rendering imports — the same code is intended to run on a
 * server later, so it must stay renderer-agnostic.
 */

/** One frame of player intent, sampled from the keyboard each render frame. */
export interface InputCommand {
  rotateLeft: boolean;
  rotateRight: boolean;
  thrust: boolean; // forward
  reverse: boolean; // backward
  afterburner: boolean;
  fire: boolean; // gun
  bomb: boolean; // bomb
}

export interface ShipState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rotation: number; // radians, continuous; 0 = pointing up

  energy: number;
  bulletCooldown: number; // ticks remaining until next gun shot allowed
  bombCooldown: number; // ticks remaining until next bomb allowed

  // Previous-tick pose, kept so the renderer can interpolate between ticks.
  prevX: number;
  prevY: number;
  prevRotation: number;
}

export type ProjectileKind = "bullet" | "bomb";

/** A bullet or a bomb — they share the same flight physics, differing only in
 *  their config (speed, lifetime, bounces) and how they're drawn. */
export interface Projectile {
  kind: ProjectileKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number; // ticks remaining
  bounces: number; // bounces remaining
  alive: boolean;

  prevX: number;
  prevY: number;
}

/**
 * Transient things that happened during a tick which the renderer (or, later, a
 * network client) turns into visuals/sounds. The sim stays renderer-agnostic: it
 * only records *what* happened and *where*, never how to draw it.
 */
export interface BombExplodedEvent {
  type: "bombExploded";
  x: number;
  y: number;
}

export type GameEvent = BombExplodedEvent;
