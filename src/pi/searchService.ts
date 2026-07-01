import type { AdapterRegistry } from "../adapters/index.js";
import type { AdapterContext, SeriesSearchResult } from "../core/types.js";

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

export interface SearchOutcome {
  results: SeriesSearchResult[];
  errors: Array<{ adapterId: string; error: string }>;
}

export async function runSearch(
  registry: AdapterRegistry,
  ctx: AdapterContext,
  query: string,
  sourceIds?: readonly string[],
): Promise<SearchOutcome> {
  const searchable = registry.all().filter((a) => typeof a.search === "function");
  const selected = sourceIds && sourceIds.length
    ? searchable.filter((a) => sourceIds.includes(a.id))
    : searchable;
  const settled = await Promise.allSettled(
    selected.map(async (a) => {
      const raw = await a.search!(ctx, query);
      return raw.filter((r) => {
        try { return a.matchHost(new URL(r.seriesUrl).hostname.toLowerCase().replace(/^www\./, "")); }
        catch { return false; }
      });
    }),
  );
  const results: SeriesSearchResult[] = [];
  const errors: SearchOutcome["errors"] = [];
  settled.forEach((s, i) => {
    if (s.status === "fulfilled") results.push(...s.value);
    else errors.push({ adapterId: selected[i]!.id, error: String((s.reason as Error)?.message ?? s.reason) });
  });
  return { results, errors };
}
