import type { AdapterRegistry } from "../adapters/index.js";

export interface AdapterInfo {
  id: string;
  name: string;
  host: string;
  searchable: boolean;
}

export function listAdapters(registry: AdapterRegistry): AdapterInfo[] {
  return registry.all().map((a) => ({
    id: a.id,
    name: a.displayName,
    host: a.liveDomain?.() ?? a.domainAliases()[0] ?? a.id,
    searchable: typeof a.search === "function",
  }));
}
