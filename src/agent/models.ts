// Pure model-list curation, unit-testable without Pi. The raw registry
// returns every catalog entry per authed provider (legacy generations, dated
// aliases, -latest aliases); the picker wants the common working set.

import type { ModelRef } from "../core/types.js";

export interface CatalogModel extends ModelRef {
  reasoning: boolean;
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
