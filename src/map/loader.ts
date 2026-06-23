import { ASSETS } from "../assets";
import { MAP_TILES } from "../config";
import { GameMap } from "../sim/gamemap";

/**
 * Load the svs map.json and turn it into a GameMap. This lives outside src/sim/
 * because fetch() is browser-specific; a server would read the file instead and
 * hand the resulting GameMap to the (pure) simulation.
 *
 * map.json is a sparse object: { "<flatIndex>": tileValue } where
 * flatIndex = y * width + x, and any missing index is empty space (0).
 */
export async function loadMap(): Promise<GameMap> {
  const res = await fetch(ASSETS.map.url);
  if (!res.ok) throw new Error(`Failed to load map: ${res.status}`);
  const sparse = (await res.json()) as Record<string, number>;

  const width = MAP_TILES;
  const height = MAP_TILES;
  const tiles = new Uint8Array(width * height); // defaults to 0 = empty

  for (const key in sparse) {
    const idx = +key;
    if (idx >= 0 && idx < tiles.length) tiles[idx] = sparse[key];
  }

  return new GameMap(width, height, tiles);
}
