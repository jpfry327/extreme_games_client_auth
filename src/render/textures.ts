import { Assets, Rectangle, Texture } from "pixi.js";

/** Load an image and slice it into a grid of sub-textures (frames).
 *  Frame size is inferred from the image size and the grid dimensions. */
export async function loadSheet(
  url: string,
  cols: number,
  rows: number,
  count = cols * rows,
): Promise<Texture[]> {
  const base = (await Assets.load(url)) as Texture;
  // Pixel-art: keep edges crisp instead of blurring when scaled.
  base.source.scaleMode = "nearest";

  const fw = base.width / cols;
  const fh = base.height / rows;

  const frames: Texture[] = [];
  for (let i = 0; i < count; i++) {
    const cx = i % cols;
    const cy = Math.floor(i / cols);
    frames.push(
      new Texture({
        source: base.source,
        frame: new Rectangle(cx * fw, cy * fh, fw, fh),
      }),
    );
  }
  return frames;
}
