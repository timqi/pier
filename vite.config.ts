import { createRequire } from "node:module";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";

const { version } = createRequire(import.meta.url)("./package.json") as { version: string };

// Vite's chunk warning is one global number, so the lazy ghostty-web chunk
// (~640 kB, fetched only when a terminal opens) would set the bar for our own
// code too. Exempt it by name and hold everything else to a real budget.
const LAZY_VENDOR = /ghostty-web/;
const OWN_CHUNK_LIMIT_KB = 350;

const chunkBudget = (): Plugin => ({
  name: "pier:chunk-budget",
  generateBundle(_options, bundle) {
    for (const [file, chunk] of Object.entries(bundle)) {
      if (chunk.type !== "chunk" || LAZY_VENDOR.test(file)) continue;
      const kb = Buffer.byteLength(chunk.code) / 1024;
      if (kb > OWN_CHUNK_LIMIT_KB)
        this.warn(`${file} is ${kb.toFixed(1)} kB, over the ${OWN_CHUNK_LIMIT_KB} kB budget`);
    }
  },
});

export default defineConfig({
  root: "src/web/ui",
  plugins: [tailwindcss(), chunkBudget()],
  define: { __PIER_VERSION__: JSON.stringify(version) },
  build: {
    outDir: "../public",
    emptyOutDir: true,
    // Built-in warning muted above the lazy vendor chunk; chunkBudget() is the
    // gate that actually applies to our code.
    chunkSizeWarningLimit: 700,
  },
  server: {
    proxy: { "/api": "http://localhost:3141" },
  },
});
