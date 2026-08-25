// Two tools — web_search and web_fetch — served by the provider's own hosted
// web stack, so an agent reaches the public web with no extra key, service or
// dependency. Registered as an inline extension by agent/pi.ts when the
// Console has it switched on.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { webFetch, webSearch } from "./tools.js";

export default function web(pi: ExtensionAPI): void {
  pi.registerTool(webSearch);
  pi.registerTool(webFetch);
}
