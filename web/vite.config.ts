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
  server: { port: 5174, open: false },
  build: { outDir: "dist", emptyOutDir: true },
});
