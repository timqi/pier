// Separate from vite.config.ts on purpose: that file sets root to src/web/ui
// for the frontend build, which would break repo-wide test discovery.
import { defineConfig } from "vitest/config";
import { scratch } from "./vitest.setup";

export default defineConfig({
  // Only failures are worth reading in a test run; a suite that logs its happy
  // path buries the one assertion that broke. `PIER_LOG=info npx vitest` back.
  // PIER_HOME is a throwaway dir per test file (vitest.home.ts) so nothing
  // (inbox writes, db paths) ever touches the real ~/.pier or another file's.
  test: {
    include: ["src/**/*.test.ts"],
    globalSetup: ["./vitest.setup.ts"],
    setupFiles: ["./vitest.home.ts"],
    env: {
      PIER_LOG: process.env.PIER_LOG ?? "silent",
      TMPDIR: scratch,
    },
  },
});
