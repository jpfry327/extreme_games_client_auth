import { Container, Sprite, Texture } from "pixi.js";
import { TILE_SIZE } from "../config";
import type { GameMap } from "../sim/gamemap";

/**
 * Renders the tile map with viewport culling. The svs map is 1024x1024 = ~1M
 * tiles, far too many to draw as sprites. Instead we keep a fixed pool of
 * sprites just big enough to cover the screen, and each frame we re-point each
 * pooled sprite at whichever world tile currently sits under it. Because every
 * tile shares one tileset texture, Pixi batches them into very few draw calls.
 */
export class TileLayer {
  readonly container = new Container();
  private pool: Sprite[] = [];
  private cols = 0;
  private rows = 0;

  constructor(
    private readonly frames: Texture[], // tileset frames; value-1 indexes here
    private readonly map: GameMap,
  ) {}

  /** Rebuild the sprite pool to cover a screen of the given size. */
  resize(screenW: number, screenH: number): void {
    this.cols = Math.ceil(screenW / TILE_SIZE) + 2;
    this.rows = Math.ceil(screenH / TILE_SIZE) + 2;

    this.container.removeChildren();
    this.pool = [];
    for (let i = 0; i < this.cols * this.rows; i++) {
      const s = new Sprite(this.frames[0]);
      s.visible = false;
      this.pool.push(s);
      this.container.addChild(s);
    }
  }

  /** Point each pooled sprite at the right world tile for the current camera. */
  update(camX: number, camY: number, screenW: number, screenH: number): void {
    const tx0 = Math.floor((camX - screenW / 2) / TILE_SIZE) - 1;
    const ty0 = Math.floor((camY - screenH / 2) / TILE_SIZE) - 1;

    for (let j = 0; j < this.rows; j++) {
      for (let i = 0; i < this.cols; i++) {
        const sprite = this.pool[j * this.cols + i];
        const tx = tx0 + i;
        const ty = ty0 + j;
        const value = this.map.tileAt(tx, ty);

        if (value === 0) {
          sprite.visible = false;
          continue;
        }
        sprite.visible = true;
        sprite.texture = this.frames[value - 1] ?? this.frames[0];
        sprite.x = tx * TILE_SIZE;
        sprite.y = ty * TILE_SIZE;
      }
    }
  }
}
