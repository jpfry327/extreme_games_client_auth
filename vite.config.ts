import { defineConfig } from "vite";

// We serve the existing `assets/` folder as static files instead of copying
// them into a `public/` dir. So `assets/shared/graphics/ship0.png` is reachable
// in the browser at the URL `/shared/graphics/ship0.png`, and the svs map at
// `/arenas/svs/map.json`. See src/assets.ts for the URL constants.
export default defineConfig({
  publicDir: "assets",
  server: {
    open: true,
  },
});
