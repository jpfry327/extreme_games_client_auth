import { Application, Container, Sprite, Texture } from "pixi.js";
import { ASSETS } from "../assets";
import { SHIP } from "../config";
import type { GameMap } from "../sim/gamemap";
import type { World } from "../sim/world";
import { loadSheet } from "./textures";
import { TileLayer } from "./tiles";

/** Linear interpolation helper. */
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

// Blue color row, first animation frame. Sheets are laid out [row = color],
// so index = row * cols + col. Row 2 is blue in both sheets.
const BLUE_BULLET_FRAME = 2 * ASSETS.bullets.cols; // row 2, col 0 = 8
const BLUE_BOMB_FRAME = 2 * ASSETS.bombs.cols; // row 2, col 0 = 20

export class Renderer {
  readonly app = new Application();

  private world!: Container; // camera-moved container holding everything
  private tiles!: TileLayer;
  private shipSprite!: Sprite;
  private shipFrames!: Texture[];
  private bulletFrames!: Texture[];
  private bombFrames!: Texture[];
  private projectilePool: Sprite[] = [];

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
    const tilesetFrames = await loadSheet(ASSETS.tileset.url, ASSETS.tileset.cols, ASSETS.tileset.rows);

    this.world = new Container();
    this.app.stage.addChild(this.world);

    this.tiles = new TileLayer(tilesetFrames, map);
    this.world.addChild(this.tiles.container);

    this.shipSprite = new Sprite(this.shipFrames[0]);
    this.shipSprite.anchor.set(0.5);
    this.world.addChild(this.shipSprite);

    const onResize = () => this.tiles.resize(this.app.screen.width, this.app.screen.height);
    window.addEventListener("resize", onResize);
    onResize();
  }

  /** Draw one frame, blending between the last two sim ticks by `alpha`. */
  draw(world: World, alpha: number): void {
    const sw = this.app.screen.width;
    const sh = this.app.screen.height;
    const ship = world.ship;

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
  }

  private drawProjectiles(world: World, alpha: number): void {
    const projectiles = world.projectiles;
    // Grow the pool if needed.
    while (this.projectilePool.length < projectiles.length) {
      const s = new Sprite(this.bulletFrames[0]);
      s.anchor.set(0.5);
      this.projectilePool.push(s);
      this.world.addChild(s);
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
