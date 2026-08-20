import { createRequire } from "node:module";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

const { version } = createRequire(import.meta.url)("./package.json") as { version: string };

export default defineConfig({
  root: "src/web/ui",
  plugins: [tailwindcss()],
  define: { __PIER_VERSION__: JSON.stringify(version) },
  build: {
    outDir: "../public",
    emptyOutDir: true,
  },
  server: {
    proxy: { "/api": "http://localhost:3141" },
  },
});
