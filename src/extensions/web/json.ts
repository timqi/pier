// Reading JSON nobody validated: every module here walks a provider payload
// whose shape is a promise, not a guarantee.

export type JsonObject = Record<string, unknown>;

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
