import { defineConfig } from "vite";

// We serve the existing `assets/` folder as static files instead of copying
// them into a `public/` dir. So `assets/shared/graphics/ship0.png` is reachable
// in the browser at the URL `/shared/graphics/ship0.png`, and the svs map at
// `/arenas/svs/map.json`. See src/assets.ts for the URL constants.
//
// `base` is the subpath the app is served from. GitHub Pages serves a project
// repo at `https://<user>.github.io/<repo>/`, so the production build must be
// rooted at `/extreme_games_client_auth/`; src/assets.ts prefixes every asset URL with
// import.meta.env.BASE_URL so they resolve under it. Dev stays at root `/` so the
// `/ws` proxy and `npm run dev` are unaffected.
export default defineConfig(({ command }) => ({
  base: command === "build" ? "/extreme_games_client_auth/" : "/",
  publicDir: "assets",
  server: {
    open: true,
    proxy: {
      "/ws": {
        target: "ws://localhost:3000",
        ws: true,
      },
    },
  },
}));
