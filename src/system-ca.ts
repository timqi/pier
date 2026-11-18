// Trust the OS certificate store, called first by both entry points (`cli.ts`,
// and `main.ts` that the systemd unit runs) so it precedes any TLS connection.

import * as tls from "node:tls";

type CaApi = {
  getCACertificates?: (type: "default" | "system") => string[];
  setDefaultCACertificates?: (certs: string[]) => void;
};

export function trustSystemCa(api: CaApi = tls, env: NodeJS.ProcessEnv = process.env): void {
  // Node < 22.19/24.5 lacks setDefaultCACertificates; Node's bundled roots then stay in force.
  if (typeof api.getCACertificates === "function" && typeof api.setDefaultCACertificates === "function") {
    // The same root comes back from the two stores with different line breaks.
    const certs = new Map<string, string>();
    for (const pem of [...api.getCACertificates("default"), ...api.getCACertificates("system")]) {
      const key = pem.replace(/\s+/g, "");
      if (!certs.has(key)) certs.set(key, pem);
    }
    api.setDefaultCACertificates([...certs.values()]);
  }
  // Child Node processes (agents' shells, npm) inherit the same trust. Known
  // limit: a child on Node < 22.15/23.8 (e.g. pinned by fnm) refuses to start on the flag.
  const options = env.NODE_OPTIONS ?? "";
  if (!options.split(/\s+/).includes("--use-system-ca")) {
    env.NODE_OPTIONS = options ? `${options} --use-system-ca` : "--use-system-ca";
  }
}
