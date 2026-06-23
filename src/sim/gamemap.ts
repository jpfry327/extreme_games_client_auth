import { TILE_SIZE } from "../config";

/**
 * The tile map, as plain data the simulation can query for collision.
 *
 * Tiles are stored in a flat Uint8Array of length width*height, row-major
 * (index = y * width + x). A value of 0 means empty space; any non-zero value
 * is a solid wall (and also the tileset frame to draw, value-1 = frame index).
 *
 * In the svs map every placed tile is value 1..98, which are all solid walls in
 * Subspace — so "solid" is simply "value !== 0". (There are no special tiles
 * like safe zones in this particular map.)
 */
export class GameMap {
  constructor(
    public readonly width: number,
    public readonly height: number,
    public readonly tiles: Uint8Array,
  ) {}

  /** Tile value at tile coords, or 0 if out of bounds. */
  tileAt(tx: number, ty: number): number {
    if (tx < 0 || ty < 0 || tx >= this.width || ty >= this.height) return 0;
    return this.tiles[ty * this.width + tx];
  }

  /** Is the tile at these tile coords solid? Out-of-bounds counts as solid. */
  isSolidTile(tx: number, ty: number): boolean {
    if (tx < 0 || ty < 0 || tx >= this.width || ty >= this.height) return true;
    return this.tiles[ty * this.width + tx] !== 0;
  }

  /** Is the world-pixel point inside a solid tile? */
  isSolidAt(px: number, py: number): boolean {
    return this.isSolidTile(
      Math.floor(px / TILE_SIZE),
      Math.floor(py / TILE_SIZE),
    );
  }
}
