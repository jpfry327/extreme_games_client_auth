/**
 * URLs for the static assets. These resolve against the `assets/` folder, which
 * Vite serves at the site root (see vite.config.ts `publicDir`).
 *
 * Sprite-sheet layouts (rows/cols) come from assets/arenas/svs/resources.json.
 */
export const ASSETS = {
  // Warbird: a 10x4 grid of 36x36 frames = 40 rotation directions.
  ship: { url: "/shared/graphics/ship0.png", cols: 10, rows: 4, frames: 40 },

  // Bullets: a 4x10 sheet of 5x5 frames. Rows are colors (row 0 red, row 1
  // gold, row 2 blue, ...); the 4 columns are animation frames. We load the
  // whole sheet so we can pick a color row.
  bullets: { url: "/shared/graphics/bullets.png", cols: 4, rows: 10, frames: 40 },

  // Bombs: a 10x13 grid of 16x16 frames. Rows are colors (row 0 red, row 1
  // gold, row 2 blue, ...); the 10 columns are animation frames.
  bombs: { url: "/shared/graphics/bombs.png", cols: 10, rows: 13, frames: 130 },

  // Exhaust: 19 frames in a 19x2 sheet (we use the top row).
  exhaust: { url: "/shared/graphics/exhaust.png", cols: 19, rows: 2, frames: 19 },

  // Bomb trail puffs: a 10x5 grid of 16x16 frames. Rows are colors (row 0 red,
  // row 1 gold, row 2 blue, ...); the 10 columns are the puff fading out. We
  // emit one puff behind each flying bomb, playing its color row left->right.
  trail: { url: "/shared/graphics/trail.png", cols: 10, rows: 5, frames: 50 },

  // EMP burst: a 5x2 grid of 80x80 frames = one 10-frame explosion animation,
  // played when a bomb detonates.
  empburst: { url: "/shared/graphics/empburst.png", cols: 5, rows: 2, frames: 10 },

  // Tileset: 19x10 grid of 16x16 tiles. Converted from tileset.bmp -> .png.
  tileset: { url: "/arenas/svs/tileset.png", cols: 19, rows: 10 },

  // The svs map: a sparse object of { flatIndex: tileValue }.
  map: { url: "/arenas/svs/map.json" },
} as const;
