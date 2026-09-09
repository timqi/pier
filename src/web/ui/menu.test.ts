// The two moves a list answers to, in one place: the anchored menus and the
// palette must not drift on which keys walk them.
import { expect, it } from "vitest";
import { listStep } from "./menu.js";

const key = (init: Partial<KeyboardEvent>): KeyboardEvent => init as KeyboardEvent;

it("walks on the arrows and on bare ⌃N/⌃J/⌃P/⌃K", () => {
  expect(listStep(key({ key: "ArrowDown" }))).toBe(1);
  expect(listStep(key({ key: "ArrowUp" }))).toBe(-1);
  expect(listStep(key({ key: "n", ctrlKey: true }))).toBe(1);
  expect(listStep(key({ key: "J", ctrlKey: true }))).toBe(1);
  expect(listStep(key({ key: "p", ctrlKey: true }))).toBe(-1);
  expect(listStep(key({ key: "k", ctrlKey: true }))).toBe(-1);
});

it("leaves alone a letter nobody held Ctrl for, and every chord the browser owns", () => {
  expect(listStep(key({ key: "n" }))).toBeUndefined();
  expect(listStep(key({ key: "n", ctrlKey: true, shiftKey: true }))).toBeUndefined(); // incognito window
  expect(listStep(key({ key: "n", metaKey: true }))).toBeUndefined(); // ⌘N is a new window
  expect(listStep(key({ key: "k", ctrlKey: true, altKey: true }))).toBeUndefined();
  expect(listStep(key({ key: "Enter" }))).toBeUndefined();
  expect(listStep(key({}))).toBeUndefined(); // synthetic event with no key
});
