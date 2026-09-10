// Separate from vite.config.ts on purpose: that file sets root to src/web/ui
// for the frontend build, which would break repo-wide test discovery.
import { join } from "node:path";
import { defineConfig } from "vitest/config";
import { scratch } from "./vitest.setup";

export default defineConfig({
  // Only failures are worth reading in a test run; a suite that logs its happy
  // path buries the one assertion that broke. `PIER_LOG=info npx vitest` back.
  // PIER_HOME points at a throwaway dir so nothing (inbox writes, db paths)
  // ever touches the real ~/.pier from a test.
  test: {
    include: ["src/**/*.test.ts"],
    globalSetup: ["./vitest.setup.ts"],
    env: {
      PIER_LOG: process.env.PIER_LOG ?? "silent",
      PIER_HOME: join(scratch, "home"),
      TMPDIR: scratch,
    },
  },
});
