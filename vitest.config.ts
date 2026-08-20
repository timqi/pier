// Separate from vite.config.ts on purpose: that file sets root to src/web/ui
// for the frontend build, which would break repo-wide test discovery.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["src/**/*.test.ts"] },
});
