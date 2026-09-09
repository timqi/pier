// The extensions Pier ships with. Bundled rather than dropped in
// <agentDir>/extensions because a copy on disk has an owner problem: an update
// either clobbers the user's edits or skips them forever.

import type { ExtensionFactory, InlineExtension } from "@earendil-works/pi-coding-agent";
import type { CatalogEntry } from "../core/types.js";
import web from "./web/index.js";

interface BundledExtension {
  name: string;
  /** One line, shown beside the switch that turns it on. */
  summary: string;
  /** Per tool, because "which providers" has no single answer for a whole
   *  extension. Kept true by extensions.test.ts against Pi's loader. */
  tools: { name: string; needs: string }[];
  factory: ExtensionFactory;
}

export const BUNDLED: readonly BundledExtension[] = [
  {
    name: "web",
    summary:
      "The public web through the provider's own hosted web tools — no extra " +
      "key, no second service, no new dependency.",
    tools: [
      { name: "web_search", needs: "an authenticated Anthropic or OpenAI model" },
      { name: "web_fetch", needs: "an authenticated Anthropic model — OpenAI hosts no fetch tool" },
    ],
    factory: web,
  },
];

/** The catalog a surface may show: no Pi types, nothing it cannot render.
 *  Half of one list; src/tools.ts has the other. */
export const bundledInfo = (enabled: readonly string[]): CatalogEntry[] =>
  BUNDLED.map(({ name, summary, tools }) => ({
    source: "bundled",
    kind: "extension",
    name,
    summary,
    adds: tools,
    enabled: enabled.includes(name),
  }));

/** The enabled ones as Pi inline extensions; unknown names are not ours. */
export const inlineExtensions = (enabled: readonly string[]): InlineExtension[] =>
  BUNDLED.filter((ext) => enabled.includes(ext.name))
    .map(({ name, factory }) => ({ name, factory }));
