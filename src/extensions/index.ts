// The extensions Pier ships with — the list, and nothing else.
//
// An extension is Pi-shaped by construction (it takes an ExtensionAPI), so
// this area is the second one allowed to import the Pi SDK. Nothing outside
// agent/ imports it: the Console sees names and summaries, which agent/ hands
// over as plain data through the ConfigStore seam.
//
// Bundled rather than dropped in <agentDir>/extensions because a copy on disk
// has an owner problem — an update either clobbers the user's edits or skips
// them forever. These ship inside the package, load as inline factories, and
// stand down when a copy on disk already registers the same tools.

import type { ExtensionFactory, InlineExtension } from "@earendil-works/pi-coding-agent";
import type { BundledExtensionInfo } from "../core/types.js";
import web from "./web/index.js";

interface BundledExtension {
  name: string;
  /** One line, shown beside the switch that turns it on. */
  summary: string;
  /** The tools it adds and what each one needs to work. Declared, because
   *  "which providers does this support" is the question asked in front of the
   *  switch, and the honest answer is per tool: web_search runs on either
   *  hosted search, web_fetch only exists on Anthropic. Kept true by
   *  extensions.test.ts, which compares these names with what Pi's loader
   *  actually registered. */
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

/** The catalog a surface may show: no Pi types, nothing it cannot render. */
export const bundledInfo = (enabled: readonly string[]): BundledExtensionInfo[] =>
  BUNDLED.map(({ name, summary, tools }) => ({
    name,
    summary,
    tools,
    enabled: enabled.includes(name),
  }));

/** The enabled ones as Pi inline extensions; unknown names are not ours. */
export const inlineExtensions = (enabled: readonly string[]): InlineExtension[] =>
  BUNDLED.filter((ext) => enabled.includes(ext.name))
    .map(({ name, factory }) => ({ name, factory }));
