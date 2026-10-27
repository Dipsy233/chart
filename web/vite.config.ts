import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * The editor is a dev tool, not part of the library. It imports `../../src`
 * directly so there is no build step between a change to the engine and the UI
 * that shows it — which is the whole point of building the editor next to the
 * engine.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    open: false,
    // The rules API (scripts/api.ts) owns the packs on disk; the editor talks to
    // it when it is running, and falls back to localStorage when it is not.
    //
    // When the API is not running the proxy would answer 500 and the browser
    // would log a failed request on every page load. Answer 200 with
    // `{ ok: false }` instead: the client already treats that as "no API", and
    // the console stays quiet in the common case.
    proxy: {
      "/api": {
        target: "http://127.0.0.1:5175",
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on("error", (_error, _request, response) => {
            const res = response as { headersSent?: boolean; writeHead?: Function; end?: Function };
            if (typeof res.writeHead !== "function" || typeof res.end !== "function" || res.headersSent) return;
            res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ ok: false, error: "the rules API is not running" }));
          });
        },
      },
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
