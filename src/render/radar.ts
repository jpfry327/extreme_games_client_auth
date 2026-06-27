import { Container, Graphics, Sprite, Texture } from "pixi.js";
import { MAP_TILES, RADAR, TILE_SIZE, WORLD_SIZE } from "../config";
import type { GameMap } from "../sim/gamemap";
import { isAlive } from "../sim/player";
import type { World } from "../sim/world";

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/**
 * The lower-right minimap, ported from Subspace.
 *
 * This is a screen-space overlay — it lives on the Pixi *stage*, not inside the
 * camera-moved world container, so it stays pinned to the corner while the world
 * scrolls underneath. The whole map's walls are rasterized once into a
 * `MAP_TILES`-square bitmap (1 texel = 1 tile); each frame we just scale and
 * offset that one sprite to frame either a player-centered window (zoomed) or
 * the whole arena (full), and stamp player blips on top. A rectangular mask
 * clips both to the radar square.
 *
 * Like the main screen, the radar can only show entities the client actually
 * received, so ships culled by the AOI (net/aoi.ts) don't appear here either.
 */
export class RadarLayer {
  /** Screen-space root; positioned bottom-right in `resize`. */
  readonly container = new Container();

  private readonly terrain: Sprite;
  private readonly blips = new Graphics();
  private readonly bg = new Graphics();
  private readonly clip = new Graphics();

  private sizePx = 0;
  private fullMap = false;

  constructor(map: GameMap) {
    this.terrain = new Sprite(buildTerrainTexture(map));

    // Draw order: backdrop, then terrain + blips (both clipped to the square),
    // then the border on top so it frames everything.
    const content = new Container();
    content.addChild(this.terrain, this.blips);
    content.mask = this.clip;

    this.container.addChild(this.bg, this.clip, content);
    this.container.eventMode = "none"; // purely cosmetic; never eat input
  }

  /** Flip between the zoomed window and the full-arena view. */
  toggle(): void {
    this.fullMap = !this.fullMap;
  }

  /** Recompute the square's size and pin it to the bottom-right corner. */
  resize(screenW: number, screenH: number): void {
    this.sizePx = Math.round(
      clamp(Math.min(screenW, screenH) * RADAR.sizeFrac, RADAR.minSizePx, RADAR.maxSizePx),
    );
    this.container.x = Math.round(screenW - this.sizePx - RADAR.marginPx);
    this.container.y = Math.round(screenH - this.sizePx - RADAR.marginPx);

    const s = this.sizePx;
    this.bg
      .clear()
      .rect(0, 0, s, s)
      .fill({ color: RADAR.bgColor, alpha: RADAR.bgAlpha })
      .rect(0.5, 0.5, s - 1, s - 1)
      .stroke({ color: RADAR.borderColor, width: 1 });
    // The mask is a plain filled square the size of the radar.
    this.clip.clear().rect(0, 0, s, s).fill(0xffffff);
  }

  /**
   * Reframe the terrain and redraw blips for the current camera. `camX/camY` is
   * the local player's interpolated world position (the radar centers on it when
   * zoomed); `alpha` interpolates every blip the same way the renderer does.
   */
  update(world: World, camX: number, camY: number, alpha: number): void {
    if (this.sizePx === 0) return;

    // World px shown across the radar's width, and the top-left world corner it
    // starts from. Full mode shows the whole arena; zoomed shows a centered
    // window the original MapZoomFactor wide, clamped to the map edges.
    const spanPx = this.fullMap ? WORLD_SIZE : WORLD_SIZE / RADAR.zoomFactor;
    const scale = this.sizePx / spanPx;
    const maxOrigin = WORLD_SIZE - spanPx;
    const originX = maxOrigin <= 0 ? maxOrigin / 2 : clamp(camX - spanPx / 2, 0, maxOrigin);
    const originY = maxOrigin <= 0 ? maxOrigin / 2 : clamp(camY - spanPx / 2, 0, maxOrigin);

    // The terrain texture is MAP_TILES px wide and 1 texel = TILE_SIZE world px,
    // so a world-px scale of `scale` becomes a texel scale of `scale * TILE_SIZE`.
    this.terrain.scale.set(scale * TILE_SIZE);
    this.terrain.x = -originX * scale;
    this.terrain.y = -originY * scale;

    const localId = world.localPlayerId;
    const me = world.players.get(localId);
    const myTeam = me?.team;
    const blink = (performance.now() % RADAR.selfBlinkMs) < RADAR.selfBlinkMs / 2;
    const half = RADAR.blipSizePx / 2;

    this.blips.clear();
    for (const p of world.players.values()) {
      if (!isAlive(p)) continue;
      // M5: hide stealthed enemies here unless the local player has X-radar.
      // Stealth/cloak/X-radar are deferred, so this is inert today (always false).
      if (p.status.stealth && p.id !== localId && p.team !== myTeam) continue;

      const isSelf = p.id === localId;
      if (isSelf && !blink) continue; // self blinks so it's easy to pick out

      const k = p.kinematics;
      const wx = lerp(k.prevX, k.x, alpha);
      const wy = lerp(k.prevY, k.y, alpha);
      const rx = (wx - originX) * scale;
      const ry = (wy - originY) * scale;
      if (rx < 0 || ry < 0 || rx > this.sizePx || ry > this.sizePx) continue;

      const color = isSelf
        ? RADAR.selfColor
        : p.team === myTeam
          ? RADAR.teammateColor
          : RADAR.enemyColor;
      this.blips.rect(rx - half, ry - half, RADAR.blipSizePx, RADAR.blipSizePx).fill(color);
    }
  }
}

/**
 * Rasterize the map's walls into a `MAP_TILES`-square texture, one texel per
 * tile (solid = wall color, empty = transparent). Built once at startup — the
 * map never changes — so the per-frame radar draw is just a scale + offset.
 */
function buildTerrainTexture(map: GameMap): Texture {
  const canvas = document.createElement("canvas");
  canvas.width = MAP_TILES;
  canvas.height = MAP_TILES;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(MAP_TILES, MAP_TILES);
  const data = img.data;

  const r = (RADAR.wallColor >> 16) & 0xff;
  const g = (RADAR.wallColor >> 8) & 0xff;
  const b = RADAR.wallColor & 0xff;

  for (let ty = 0; ty < MAP_TILES; ty++) {
    for (let tx = 0; tx < MAP_TILES; tx++) {
      if (map.tileAt(tx, ty) === 0) continue; // leave empty space transparent
      const o = (ty * MAP_TILES + tx) * 4;
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
      data[o + 3] = 0xff;
    }
  }
  ctx.putImageData(img, 0, 0);

  const tex = Texture.from(canvas);
  tex.source.scaleMode = "nearest"; // crisp tiles when scaled, no blur
  return tex;
}
