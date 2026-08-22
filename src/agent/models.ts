// Pure model-list curation, unit-testable without Pi. The raw registry
// returns every catalog entry per authed provider (legacy generations, dated
// aliases, -latest aliases); the picker wants the common working set.

import type { ModelRef } from "../core/types.js";

export interface CatalogModel extends ModelRef {
  reasoning: boolean;
}

/** Operator-pinned models first, menu order, without inventing entries: a
 * pin that is not in the list (stale menu, logged-out provider) is skipped
 * rather than offered as a model that would only fail on selection. */
export function pinFirst(models: ModelRef[], pins: ModelRef[]): ModelRef[] {
  if (!pins.length) return models;
  const key = (m: ModelRef): string => `${m.provider}/${m.id}`;
  const listed = new Map(models.map((m) => [key(m), m]));
  const pinned = pins.map((p) => listed.get(key(p))).filter((m): m is ModelRef => !!m);
  const picked = new Set(pinned.map(key));
  return [...pinned, ...models.filter((m) => !picked.has(key(m)))];
}

export function curateModels(models: CatalogModel[]): ModelRef[] {
  const ids = new Set(models.map((m) => `${m.provider}/${m.id}`));
  return models
    .filter((m) => m.reasoning) // agent work wants reasoning-capable models
    .filter((m) => !m.id.endsWith("-latest")) // alias noise
    .filter((m) => {
      // Drop dated variants when the undated alias is also in the catalog.
      const undated = m.id.replace(/-\d{8}$/, "");
      return undated === m.id || !ids.has(`${m.provider}/${undated}`);
    })
    .map(({ provider, id }) => ({ provider, id }));
}
