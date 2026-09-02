import { readdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { brotliCompressSync, gzipSync } from "node:zlib";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";

const { version } = createRequire(import.meta.url)("./package.json") as { version: string };

// Vite's chunk warning is one global number, so the lazy ghostty-web chunk
// (~640 kB, fetched only when a terminal opens) would set the bar for our own
// code too. Exempt it by name and hold everything else to a real budget.
const LAZY_VENDOR = /ghostty-web/;
// The boot chunk is ~160 kB now that the Console views and the highlighter
// load on first use; a limit that only the old single bundle could reach was
// a gate nothing would trip for years.
const OWN_CHUNK_LIMIT_KB = 200;

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

// The bundle is immutable once built, so its compressed form is too: write
// the `.br`/`.gz` siblings here and serveStatic hands them out per
// Accept-Encoding (`precompressed`, src/web/server.ts). Streaming the same
// 325 kB through an encoder on every request would spend CPU per client to
// arrive at the identical bytes — and at a worse ratio, since a request-time
// encoder cannot afford brotli's maximum quality. The icons and any font stay
// out: they are compressed already and would only grow.
const COMPRESSIBLE = /\.(?:js|css|html|svg|json|webmanifest)$/;
// Under a packet the encodings buy nothing and only add files to stat; the
// empty vite shim chunk is the case in point.
const MIN_BYTES = 1024;

const precompress = (): Plugin => {
  let outDir = "";
  return {
    name: "pier:precompress",
    apply: "build",
    configResolved(config) {
      // `outDir` stays as written in the config, i.e. relative to `root`.
      outDir = resolve(config.root, config.build.outDir);
    },
    // closeBundle, not generateBundle: publicDir (sw.js, the manifest, the
    // icons) is copied after the chunks are written, and it is served from the
    // same root by the same handler.
    async closeBundle() {
      for (const entry of await readdir(outDir, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile() || !COMPRESSIBLE.test(entry.name)) continue;
        const file = join(entry.parentPath, entry.name);
        const bytes = await readFile(file);
        if (bytes.length < MIN_BYTES) continue;
        await Promise.all([
          writeFile(`${file}.br`, brotliCompressSync(bytes)),
          writeFile(`${file}.gz`, gzipSync(bytes, { level: 9 })),
        ]);
      }
    },
  };
};

export default defineConfig({
  root: "src/web/ui",
  plugins: [tailwindcss(), chunkBudget(), precompress()],
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
