import { Container, Sprite, Texture } from "pixi.js";

/** A single playing animation: walks `frames` once, then removes itself. */
interface Effect {
  sprite: Sprite;
  frames: Texture[];
  frameMs: number;
  elapsedMs: number;
}

/**
 * A pile of short, fire-and-forget sprite animations (bomb-trail puffs,
 * explosions). Each effect plays its frame list once and then disappears; the
 * sprites are pooled and reused so spawning is allocation-free in steady state.
 *
 * This is purely cosmetic and lives entirely in the render layer — the sim
 * knows nothing about it.
 */
export class EffectsLayer {
  readonly container = new Container();
  private active: Effect[] = [];
  private pool: Sprite[] = [];

  /** Start an animation at world (x, y). Plays `frames` once over
   *  frames.length * frameMs, drawn additively so it glows against space. */
  spawn(frames: Texture[], x: number, y: number, frameMs: number, scale = 1): void {
    const sprite = this.pool.pop() ?? this.makeSprite();
    sprite.visible = true;
    sprite.texture = frames[0];
    sprite.x = x;
    sprite.y = y;
    sprite.scale.set(scale);
    this.active.push({ sprite, frames, frameMs, elapsedMs: 0 });
  }

  /** Advance every live effect by `dtMs` real milliseconds, retiring finished
   *  ones back into the pool. */
  update(dtMs: number): void {
    for (let i = this.active.length - 1; i >= 0; i--) {
      const e = this.active[i];
      e.elapsedMs += dtMs;
      const frame = Math.floor(e.elapsedMs / e.frameMs);
      if (frame >= e.frames.length) {
        e.sprite.visible = false;
        this.pool.push(e.sprite);
        this.active.splice(i, 1);
        continue;
      }
      e.sprite.texture = e.frames[frame];
    }
  }

  private makeSprite(): Sprite {
    const s = new Sprite();
    s.anchor.set(0.5);
    s.blendMode = "add"; // glow on black space; trails/bursts are dark RGB
    this.container.addChild(s);
    return s;
  }
}
