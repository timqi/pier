// highlightCode's one judgement after the chunk loads: a root detached meanwhile is left alone.
import { expect, it, vi } from "vitest";

vi.mock("./hljs.js", () => ({
  default: {
    getLanguage: (lang: string) => (lang === "ts" ? {} : undefined),
    highlight: (code: string) => ({ value: `<b>${code}</b>` }),
  },
}));

const { highlightCode } = await import("./highlight.js");

const rootWith = () => {
  const code = { className: "language-ts", textContent: "let x", innerHTML: "let x" };
  const root = { isConnected: true, querySelectorAll: vi.fn(() => [code]) };
  return { code, root, run: () => highlightCode(root as unknown as HTMLElement) };
};

it("highlights an attached root's code blocks", async () => {
  const { code, run } = rootWith();
  await run();
  expect(code.innerHTML).toBe("<b>let x</b>");
});

it("leaves a root detached while the highlighter loaded", async () => {
  const { code, root, run } = rootWith();
  const done = run();
  root.isConnected = false;
  await done;
  expect(root.querySelectorAll).not.toHaveBeenCalled();
  expect(code.innerHTML).toBe("let x");
});
