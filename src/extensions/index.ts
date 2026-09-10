// The extensions Pier ships with. Bundled rather than dropped in
// <agentDir>/extensions because a copy on disk has an owner problem: an update
// either clobbers the user's edits or skips them forever.

import type { ExtensionFactory, InlineExtension } from "@earendil-works/pi-coding-agent";
import web from "./web/index.js";

interface BundledExtension {
  name: string;
  factory: ExtensionFactory;
}

export const BUNDLED: readonly BundledExtension[] = [
  { name: "web", factory: web },
];

/** The enabled ones as Pi inline extensions; unknown names are not ours. */
export const inlineExtensions = (enabled: readonly string[]): InlineExtension[] =>
  BUNDLED.filter((ext) => enabled.includes(ext.name))
    .map(({ name, factory }) => ({ name, factory }));
