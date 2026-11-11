// A session's system prompt read back from its transcript: Pi records the
// prompt as structured system messages (the first whole, later ones patching
// sections), and replaying them is what the model has. Structurally typed like
// events.ts, so it is testable without Pi.

import type { SystemPrompt, SystemPromptBlock } from "../core/types.js";
import { textOf, type PiMessage } from "./events.js";
import { ROLE_GUARD, SURFACE_END } from "./roles.js";

export type PiSystemMessage = PiMessage & { sections?: Record<string, string | null> };

/** An older transcript's Pier files, injected as context files before the role moved into the preamble. */
const PIER_FILES: Record<string, string> = {
  "<pier>/AGENTS.md": "Pier surface",
  "<pier>/dispatcher.md": "Role · dispatcher",
  "<pier>/lead.md": "Role · lead",
  "<pier>/worker.md": "Role · worker",
};

/** Each contract's H1 (roles.ts); a lead's phase is the one section it carries. */
function roleLabel(contract: string): string {
  const title = contract.split("\n", 1)[0] ?? "";
  if (title.startsWith("# You are the main session")) return "Role · dispatcher";
  if (title.startsWith("# You are a worker")) return "Role · worker";
  if (!title.startsWith("# You are a feature lead")) return "Role";
  return /^## Design$/m.test(contract) ? "Role · lead · design" : /^## Build$/m.test(contract) ? "Role · lead · build" : "Role · lead";
}

/** Cut by structure: the baseline ends on the surface's last sentence, the
 *  role contract is the last `# You are` heading, the user's SYSTEM.md between.
 *  A SYSTEM.md may head a section `# You are` too: a contract has a title
 *  `roleLabel` knows or carries the guard. */
function preamble(section: string): SystemPromptBlock[] {
  const end = section.indexOf(SURFACE_END);
  if (end < 0) return [{ label: "Preamble", text: section }];
  const baseline = section.slice(0, end + SURFACE_END.length);
  const rest = section.slice(baseline.length).replace(/^\n+/, "");
  const last = [...rest.matchAll(/^# You are /gm)].at(-1)?.index;
  const role = last !== undefined && (roleLabel(rest.slice(last)) !== "Role" || rest.includes(ROLE_GUARD, last)) ? last : undefined;
  const own = (role === undefined ? rest : rest.slice(0, role)).replace(/\n+$/, "");
  return [
    { label: "Pier baseline", text: baseline },
    ...(own ? [{ label: "SYSTEM.md", text: own }] : []),
    ...(role === undefined ? [] : [{ label: roleLabel(rest.slice(role)), text: rest.slice(role) }]),
  ];
}

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
    label: PIER_FILES[path] ?? (path.startsWith("<pier>/") ? "Role" : path.split("/").pop() ?? path),
    path,
    text,
  }));
}

export function replaySystemPrompt(messages: readonly PiSystemMessage[]): SystemPrompt | null {
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
      blocks.push(...preamble(section));
    } else if (name === "project_context") {
      blocks.push(...contextFiles(unwrap(name, section)));
    } else {
      blocks.push({ label: LABELS[name] ?? name, text: unwrap(name, section) });
    }
  }
  const text = [...content, ...sections.values()].filter((part) => part.length > 0).join("\n\n");
  return { text, tokens: Math.ceil(text.length / 4), blocks };
}
