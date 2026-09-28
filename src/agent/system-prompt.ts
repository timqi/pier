// A session's system prompt read back from its transcript: Pi records the
// prompt as structured system messages (the first whole, later ones patching
// sections), and replaying them is what the model has. Structurally typed like
// events.ts, so it is testable without Pi.

import type { SystemPrompt, SystemPromptBlock } from "../core/types.js";
import { textOf, type PiMessage } from "./events.js";

export type PiSystemMessage = PiMessage & { sections?: Record<string, string | null> };

/** Pier's own context files (agent/pi.ts) are the role prompts but one. */
const PIER_INSTRUCTIONS = "<pier>/AGENTS.md";

const LABELS: Record<string, string> = {
  addendum: "APPEND_SYSTEM.md",
  skills: "Skills",
  cwd: "Working directory",
};

const unwrap = (name: string, text: string): string => {
  const open = `<${name}>\n`;
  const close = `\n</${name}>`;
  return text.startsWith(open) && text.endsWith(close) ? text.slice(open.length, -close.length) : text;
};

/** Pi joins context files as `<project_instructions path="…">` blocks under one heading. */
function contextFiles(section: string): SystemPromptBlock[] {
  const files = [...section.matchAll(/<project_instructions path="([^"]*)">\n([\s\S]*?)\n<\/project_instructions>(?=\n\n<project_instructions path="|$)/g)];
  if (files.length === 0) return [{ label: "project_context", text: section }];
  return files.map(([, path = "", text = ""]) => ({
    label: path === PIER_INSTRUCTIONS ? "Pier instructions" : path.startsWith("<pier>/") ? "Role prompt" : path.split("/").pop() ?? path,
    path,
    text,
  }));
}

/** `baselines` are the preambles Pier opens with, one per role; what follows
 *  the one found is the user's SYSTEM.md. */
export function replaySystemPrompt(messages: readonly PiSystemMessage[], baselines: readonly string[]): SystemPrompt | null {
  const system = messages.filter((m) => m.role === "system");
  if (system.length === 0) return null;
  const content: string[] = [];
  const sections = new Map<string, string>();
  for (const message of system) {
    const text = textOf(message.content);
    if (text) content.push(text);
    for (const [name, value] of Object.entries(message.sections ?? {})) {
      if (value === null) sections.delete(name);
      else sections.set(name, value);
    }
  }
  const blocks: SystemPromptBlock[] = content.map((text) => ({ label: "System message", text }));
  for (const [name, section] of sections) {
    if (name === "preamble") {
      const baseline = baselines.find((b) => section.startsWith(b));
      if (baseline === undefined) {
        blocks.push({ label: "Preamble", text: section });
        continue;
      }
      const own = section.slice(baseline.length).replace(/^\n\n/, "");
      blocks.push({ label: "Pier baseline", text: baseline }, ...(own ? [{ label: "SYSTEM.md", text: own }] : []));
    } else if (name === "project_context") {
      blocks.push(...contextFiles(unwrap(name, section)));
    } else {
      blocks.push({ label: LABELS[name] ?? name, text: unwrap(name, section) });
    }
  }
  const text = [...content, ...sections.values()].filter((part) => part.length > 0).join("\n\n");
  return { text, tokens: Math.ceil(text.length / 4), blocks };
}
