import { Application, Container, Sprite, Texture } from "pixi.js";
import { ASSETS } from "../assets";
import { SHIP } from "../config";
import type { GameMap } from "../sim/gamemap";
import type { Projectile } from "../sim/types";
import type { World } from "../sim/world";
import { EffectsLayer } from "./effects";
import { loadSheet } from "./textures";
import { TileLayer } from "./tiles";

/** Linear interpolation helper. */
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

// Blue color row, first animation frame. Sheets are laid out [row = color],
// so index = row * cols + col. Row 2 is blue in both sheets.
const BLUE_BULLET_FRAME = 2 * ASSETS.bullets.cols; // row 2, col 0 = 8
const BLUE_BOMB_FRAME = 2 * ASSETS.bombs.cols; // row 2, col 0 = 20
// trail.png shares the same [row = color] layout; row 2 is the blue puff,
// frames 20..29 fading out — matching the blue bomb above.
const BLUE_TRAIL_FRAME = 2 * ASSETS.trail.cols; // row 2, col 0 = 20

// Bomb-trail tuning (real-time milliseconds, not sim ticks — these are visuals).
const TRAIL_FRAME_MS = 28; // per puff frame -> ~280ms puff lifetime
const TRAIL_EMIT_MS = 16; // spacing between puffs along the bomb's path
const BURST_FRAME_MS = 35; // per explosion frame -> ~350ms detonation

export class Renderer {
  readonly app = new Application();

  private world!: Container; // camera-moved container holding everything
  private tiles!: TileLayer;
  private shipSprite!: Sprite;
  private shipFrames!: Texture[];
  private bulletFrames!: Texture[];
  private bombFrames!: Texture[];
  private projectilePool: Sprite[] = [];

  // Cosmetic effects, split into two layers so trails sit behind the bomb and
  // explosions burst on top.
  private trailFrames!: Texture[];
  private burstFrames!: Texture[];
  private trails!: EffectsLayer;
  private bursts!: EffectsLayer;
  // When each live bomb last dropped a trail puff (real-time clock, ms).
  private lastTrailEmit = new WeakMap<Projectile, number>();
  private clockMs = 0;

  /** Create the Pixi canvas, load textures, build the scene. */
  async init(mount: HTMLElement, map: GameMap): Promise<void> {
    await this.app.init({
      resizeTo: window,
      background: 0x00010a,
      antialias: false,
      roundPixels: true,
    });
    mount.appendChild(this.app.canvas);

    this.shipFrames = await loadSheet(ASSETS.ship.url, ASSETS.ship.cols, ASSETS.ship.rows, ASSETS.ship.frames);
    this.bulletFrames = await loadSheet(ASSETS.bullets.url, ASSETS.bullets.cols, ASSETS.bullets.rows, ASSETS.bullets.frames);
    this.bombFrames = await loadSheet(ASSETS.bombs.url, ASSETS.bombs.cols, ASSETS.bombs.rows, ASSETS.bombs.frames);
    const trailSheet = await loadSheet(ASSETS.trail.url, ASSETS.trail.cols, ASSETS.trail.rows, ASSETS.trail.frames);
    // We only ever draw the blue puff row, so keep just those frames.
    this.trailFrames = trailSheet.slice(BLUE_TRAIL_FRAME, BLUE_TRAIL_FRAME + ASSETS.trail.cols);
    this.burstFrames = await loadSheet(ASSETS.empburst.url, ASSETS.empburst.cols, ASSETS.empburst.rows, ASSETS.empburst.frames);
    const tilesetFrames = await loadSheet(ASSETS.tileset.url, ASSETS.tileset.cols, ASSETS.tileset.rows);

    this.world = new Container();
    this.app.stage.addChild(this.world);

    this.tiles = new TileLayer(tilesetFrames, map);
    this.world.addChild(this.tiles.container);

    // Trail puffs render above the tiles but below the ship and projectiles.
    this.trails = new EffectsLayer();
    this.world.addChild(this.trails.container);

    this.shipSprite = new Sprite(this.shipFrames[0]);
    this.shipSprite.anchor.set(0.5);
    this.world.addChild(this.shipSprite);

    // Explosions render on top of everything.
    this.bursts = new EffectsLayer();
    this.world.addChild(this.bursts.container);

    const onResize = () => this.tiles.resize(this.app.screen.width, this.app.screen.height);
    window.addEventListener("resize", onResize);
    onResize();
  }

  /** Draw one frame, blending between the last two sim ticks by `alpha`.
   *  `dtSeconds` is the real frame time, used to drive the cosmetic effects. */
  draw(world: World, alpha: number, dtSeconds: number): void {
    const sw = this.app.screen.width;
    const sh = this.app.screen.height;
    const ship = world.ship;
    this.clockMs += dtSeconds * 1000;

    // Interpolated camera target = where the ship visually is this frame.
    const camX = lerp(ship.prevX, ship.x, alpha);
    const camY = lerp(ship.prevY, ship.y, alpha);

    // Move the world so the ship sits at screen center (rounded = crisp pixels).
    this.world.x = Math.round(sw / 2 - camX);
    this.world.y = Math.round(sh / 2 - camY);

    this.tiles.update(camX, camY, sw, sh);

    // Ship: place at interpolated world pos, pick frame from its facing.
    this.shipSprite.x = camX;
    this.shipSprite.y = camY;
    this.shipSprite.texture = this.shipFrames[directionFrame(ship.rotation)];

    this.drawProjectiles(world, alpha);
    this.drawEffects(world, alpha, dtSeconds * 1000);
  }

  /** Turn sim bomb-detonation events into explosions, drop trail puffs behind
   *  flying bombs, and advance both effect layers. */
  private drawEffects(world: World, alpha: number, dtMs: number): void {
    // Detonations the sim reported this frame -> spawn an EMP burst at each.
    if (world.events.length) {
      for (const e of world.events) {
        if (e.type === "bombExploded") {
          this.bursts.spawn(this.burstFrames, e.x, e.y, BURST_FRAME_MS);
        }
      }
      world.events.length = 0; // consumed
    }

    // Emit trail puffs behind each live bomb, spaced out in real time so the
    // trail looks the same regardless of frame rate.
    for (const p of world.projectiles) {
      if (p.kind !== "bomb") continue;
      const last = this.lastTrailEmit.get(p);
      if (last !== undefined && this.clockMs - last < TRAIL_EMIT_MS) continue;
      this.lastTrailEmit.set(p, this.clockMs);
      const x = lerp(p.prevX, p.x, alpha);
      const y = lerp(p.prevY, p.y, alpha);
      this.trails.spawn(this.trailFrames, x, y, TRAIL_FRAME_MS);
    }

    this.trails.update(dtMs);
    this.bursts.update(dtMs);
  }

  private drawProjectiles(world: World, alpha: number): void {
    const projectiles = world.projectiles;
    // Grow the pool if needed.
    while (this.projectilePool.length < projectiles.length) {
      const s = new Sprite(this.bulletFrames[0]);
      s.anchor.set(0.5);
      this.projectilePool.push(s);
      this.world.addChild(s);
      // Keep explosions drawing above the projectile sprites we just added.
      this.world.addChild(this.bursts.container);
    }
    for (let i = 0; i < this.projectilePool.length; i++) {
      const s = this.projectilePool[i];
      const p = projectiles[i];
      if (!p) {
        s.visible = false;
        continue;
      }
      s.visible = true;
      // Bullets are tiny (5x5) so we scale them up; bombs (16x16) draw native.
      if (p.kind === "bomb") {
        s.texture = this.bombFrames[BLUE_BOMB_FRAME];
        s.scale.set(1);
      } else {
        s.texture = this.bulletFrames[BLUE_BULLET_FRAME];
        s.scale.set(2);
      }
      s.x = lerp(p.prevX, p.x, alpha);
      s.y = lerp(p.prevY, p.y, alpha);
    }
  }
}

/** Map a continuous rotation (0 = up, clockwise positive) to one of the 40
 *  ship frames. Frame 0 points up; frames advance clockwise. */
function directionFrame(rotation: number): number {
  const n = SHIP.directions;
  const twoPi = Math.PI * 2;
  let r = rotation % twoPi;
  if (r < 0) r += twoPi;
  return Math.round((r / twoPi) * n) % n;
}
