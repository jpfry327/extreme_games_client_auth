import { Application, Container, Sprite, Texture } from "pixi.js";
import { ASSETS } from "../assets";
import { shipConfig } from "../config";
import type { GameMap } from "../sim/gamemap";
import { isAlive } from "../sim/player";
import type { Player } from "../sim/types";
import type { World } from "../sim/world";
import { EffectsLayer } from "./effects";
import { NametagLayer } from "./nametags";
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
const BURST_FRAME_MS = 35; // per empburst frame -> ~350ms bomb detonation
const EXPLODE_FRAME_MS = 20; // per explode1 frame -> ~720ms ship explosion (36 frames)
const HIT_FRAME_MS = 22; // per damage frame -> ~220ms bullet-hit spark (10 frames)

export class Renderer {
  readonly app = new Application();

  private world!: Container; // camera-moved container holding everything
  private tiles!: TileLayer;
  private shipLayer!: Container;
  private projectileLayer!: Container;
  private shipFrames!: Texture[];
  private bulletFrames!: Texture[];
  private bombFrames!: Texture[];
  private shipPool: Sprite[] = [];
  private projectilePool: Sprite[] = [];

  // Cosmetic effects, split into two layers so trails sit behind the bomb and
  // explosions burst on top.
  private trailFrames!: Texture[];
  private burstFrames!: Texture[]; // empburst — bomb detonations
  private explodeFrames!: Texture[]; // explode1 — ship deaths
  private hitFrames!: Texture[]; // damage — bullet-hit sparks
  private trails!: EffectsLayer;
  private bursts!: EffectsLayer;
  // Player nametags (name + bounty), drawn above the ships.
  private nametags!: NametagLayer;
  // When each live bomb last dropped a trail puff (real-time clock, ms),
  // keyed by projectile id so snapshot-replaced objects are tracked correctly.
  private lastTrailEmit = new Map<number, number>();
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
    this.explodeFrames = await loadSheet(ASSETS.explode1.url, ASSETS.explode1.cols, ASSETS.explode1.rows, ASSETS.explode1.frames);
    this.hitFrames = await loadSheet(ASSETS.damage.url, ASSETS.damage.cols, ASSETS.damage.rows, ASSETS.damage.frames);
    const tilesetFrames = await loadSheet(ASSETS.tileset.url, ASSETS.tileset.cols, ASSETS.tileset.rows);

    this.world = new Container();
    this.app.stage.addChild(this.world);

    this.tiles = new TileLayer(tilesetFrames, map);
    this.world.addChild(this.tiles.container);

    // Trail puffs render above the tiles but below the ships and projectiles.
    this.trails = new EffectsLayer();
    this.world.addChild(this.trails.container);

    // Ships, then projectiles. Both are pooled sprite layers that grow to fit
    // however many players / shots the world currently holds.
    this.shipLayer = new Container();
    this.world.addChild(this.shipLayer);
    this.projectileLayer = new Container();
    this.world.addChild(this.projectileLayer);

    // Explosions render on top of everything.
    this.bursts = new EffectsLayer();
    this.world.addChild(this.bursts.container);

    // Nametags sit above the world art but follow the ships in world space.
    this.nametags = new NametagLayer();
    this.world.addChild(this.nametags.container);

    const onResize = () => this.tiles.resize(this.app.screen.width, this.app.screen.height);
    window.addEventListener("resize", onResize);
    onResize();
  }

  /** Draw one frame, blending between the last two sim ticks by `alpha`.
   *  `dtSeconds` is the real frame time, used to drive the cosmetic effects. */
  draw(world: World, alpha: number, dtSeconds: number): void {
    const sw = this.app.screen.width;
    const sh = this.app.screen.height;
    const local = world.localPlayer.kinematics;
    this.clockMs += dtSeconds * 1000;

    // Interpolated camera target = where the local player visually is this frame.
    const camX = lerp(local.prevX, local.x, alpha);
    const camY = lerp(local.prevY, local.y, alpha);

    // Move the world so the local player sits at screen center (rounded = crisp).
    this.world.x = Math.round(sw / 2 - camX);
    this.world.y = Math.round(sh / 2 - camY);

    this.tiles.update(camX, camY, sw, sh);

    this.drawPlayers(world, alpha);
    this.drawProjectiles(world, alpha);
    this.drawEffects(world, alpha, dtSeconds * 1000);
    this.nametags.update(world, alpha);
  }

  /** Draw every player's ship, growing the sprite pool to fit. Each sprite is
   *  placed at its interpolated pose and shows the frame for its facing. */
  private drawPlayers(world: World, alpha: number): void {
    const players: Player[] = [...world.players.values()];
    while (this.shipPool.length < players.length) {
      const s = new Sprite(this.shipFrames[0]);
      s.anchor.set(0.5);
      this.shipPool.push(s);
      this.shipLayer.addChild(s);
    }
    for (let i = 0; i < this.shipPool.length; i++) {
      const s = this.shipPool[i];
      const p = players[i];
      if (!p || !isAlive(p)) {
        // No player for this slot, or the ship is dead and waiting to respawn.
        s.visible = false;
        continue;
      }
      const k = p.kinematics;
      const directions = shipConfig(p.shipType).directions;
      s.visible = true;
      s.x = lerp(k.prevX, k.x, alpha);
      s.y = lerp(k.prevY, k.y, alpha);
      s.texture = this.shipFrames[directionFrame(k.rotation, directions)];
    }
  }

  /** Turn sim detonation / death events into explosions, drop trail puffs behind
   *  flying bombs, and advance both effect layers.
   *
   *  NOTE: we read `world.events` but do NOT clear it — main.ts owns draining so
   *  other consumers (the kill feed, later audio) see the same events first. */
  private drawEffects(world: World, alpha: number, dtMs: number): void {
    for (const e of world.events) {
      if (e.type === "bombExploded") {
        this.bursts.spawn(this.burstFrames, e.x, e.y, BURST_FRAME_MS);
      } else if (e.type === "shipDied") {
        // Ship explosion — the dedicated explode1 animation at the wreck.
        this.bursts.spawn(this.explodeFrames, e.x, e.y, EXPLODE_FRAME_MS);
      } else if (e.type === "shipHit" && !e.fatal) {
        // Bullet/bomb hit spark on the struck ship (skip if it was the killing
        // blow — the explosion covers it).
        this.bursts.spawn(this.hitFrames, e.x, e.y, HIT_FRAME_MS);
      }
    }

    // Emit trail puffs behind each live bomb, spaced out in real time so the
    // trail looks the same regardless of frame rate.
    for (const p of world.projectiles) {
      if (p.kind !== "bomb") continue;
      const last = this.lastTrailEmit.get(p.id);
      if (last !== undefined && this.clockMs - last < TRAIL_EMIT_MS) continue;
      this.lastTrailEmit.set(p.id, this.clockMs);
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
      this.projectileLayer.addChild(s);
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

/** Map a continuous rotation (0 = up, clockwise positive) to one of the ship's
 *  `n` frames. Frame 0 points up; frames advance clockwise. */
function directionFrame(rotation: number, n: number): number {
  const twoPi = Math.PI * 2;
  let r = rotation % twoPi;
  if (r < 0) r += twoPi;
  return Math.round((r / twoPi) * n) % n;
}
