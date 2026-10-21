// The tab bar page apart from the workbench's config: another root, base and output, and none of its plugins.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL("tabs", import.meta.url)),
  base: "./",
  build: { outDir: "dist", emptyOutDir: true, target: "es2022" },
});
