import { TILE_SIZE } from "../config";
import type { GameMap } from "./gamemap";

const EPS = 0.001;

/** Does an axis-aligned box (center cx,cy, half-extent h) overlap any solid tile? */
function boxHitsSolid(map: GameMap, cx: number, cy: number, h: number): boolean {
  const minTx = Math.floor((cx - h) / TILE_SIZE);
  const maxTx = Math.floor((cx + h) / TILE_SIZE);
  const minTy = Math.floor((cy - h) / TILE_SIZE);
  const maxTy = Math.floor((cy + h) / TILE_SIZE);
  for (let ty = minTy; ty <= maxTy; ty++) {
    for (let tx = minTx; tx <= maxTx; tx++) {
      if (map.isSolidTile(tx, ty)) return true;
    }
  }
  return false;
}

export interface MoveResult {
  x: number;
  y: number;
  vx: number;
  vy: number;
  hitX: boolean;
  hitY: boolean;
}

/**
 * Move a box through the tile map one tick, resolving wall collisions one axis
 * at a time (move X, fix X; move Y, fix Y). On a hit, the box is snapped flush
 * against the wall and that axis's velocity is reflected and scaled by
 * `bounce` (0 = dead stop, 1 = perfect bounce).
 */
export function moveAndCollide(
  map: GameMap,
  x: number,
  y: number,
  vx: number,
  vy: number,
  half: number,
  bounce: number,
): MoveResult {
  let hitX = false;
  let hitY = false;

  // --- X axis ---
  let nx = x + vx;
  if (boxHitsSolid(map, nx, y, half)) {
    if (vx > 0) {
      const wallTx = Math.floor((nx + half) / TILE_SIZE);
      nx = wallTx * TILE_SIZE - half - EPS;
    } else if (vx < 0) {
      const wallTx = Math.floor((nx - half) / TILE_SIZE);
      nx = (wallTx + 1) * TILE_SIZE + half + EPS;
    }
    vx = -vx * bounce;
    hitX = true;
  }

  // --- Y axis (using the already-resolved X) ---
  let ny = y + vy;
  if (boxHitsSolid(map, nx, ny, half)) {
    if (vy > 0) {
      const wallTy = Math.floor((ny + half) / TILE_SIZE);
      ny = wallTy * TILE_SIZE - half - EPS;
    } else if (vy < 0) {
      const wallTy = Math.floor((ny - half) / TILE_SIZE);
      ny = (wallTy + 1) * TILE_SIZE + half + EPS;
    }
    vy = -vy * bounce;
    hitY = true;
  }

  return { x: nx, y: ny, vx, vy, hitX, hitY };
}
