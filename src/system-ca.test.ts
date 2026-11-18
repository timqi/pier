import { describe, expect, it } from "vitest";
import { trustSystemCa } from "./system-ca.js";

describe("trustSystemCa", () => {
  it("installs default and system roots once each, and passes the flag on", () => {
    let installed: string[] = [];
    const env: NodeJS.ProcessEnv = { NODE_OPTIONS: "--max-old-space-size=4096" };
    trustSystemCa(
      {
        getCACertificates: (type) => (type === "default" ? ["a", "b\nb"] : ["bb\n", "c"]),
        setDefaultCACertificates: (certs) => void (installed = certs),
      },
      env,
    );
    expect(installed).toEqual(["a", "b\nb", "c"]);
    expect(env.NODE_OPTIONS).toBe("--max-old-space-size=4096 --use-system-ca");
  });

  it("skips the store without the API and never repeats the flag", () => {
    const env: NodeJS.ProcessEnv = {};
    trustSystemCa({}, env);
    trustSystemCa({}, env);
    expect(env.NODE_OPTIONS).toBe("--use-system-ca");
  });
});
