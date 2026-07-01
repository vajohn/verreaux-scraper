// ---------------------------------------------------------------------------
// adapters/index.ts — Adapter registry.
//
// Routes URLs to their SourceAdapter implementation.
// AsuraScans, ManhuaPlus, Arenascan, Drake, Hivetoons, Manhwanex, and Qimanhwa
// adapters are registered.
// ---------------------------------------------------------------------------

import type { SourceAdapter } from "../core/types.js";
import { AsuraScansAdapter } from "./asurascans.js";
import { manhuaPlusAdapter } from "./manhuaplus.js";
import { arenascanAdapter } from "./arenascan.js";
import { drakeAdapter } from "./drake.js";
import { hivetoonsAdapter } from "./hivetoons.js";
import { manhwanexAdapter } from "./manhwanex.js";
import { qimanhwaAdapter } from "./qimanhwa.js";

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface AdapterRegistry {
  /**
   * Return the adapter responsible for the given URL, or null if no
   * registered adapter claims the host.
   */
  matchUrl(url: string): SourceAdapter | null;

  /**
   * Return an adapter by its stable id.
   * Throws if the id is unknown.
   */
  byId(id: SourceAdapter["id"]): SourceAdapter;

  /**
   * Return all registered adapters.
   */
  all(): readonly SourceAdapter[];
}

// ---------------------------------------------------------------------------
// Registry implementation
// ---------------------------------------------------------------------------

class AdapterRegistryImpl implements AdapterRegistry {
  private readonly adapters: SourceAdapter[];

  constructor(adapters: SourceAdapter[]) {
    this.adapters = adapters;
  }

  matchUrl(url: string): SourceAdapter | null {
    let host: string;
    try {
      host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    } catch {
      return null;
    }

    for (const adapter of this.adapters) {
      if (adapter.matchHost(host)) return adapter;
    }
    return null;
  }

  byId(id: SourceAdapter["id"]): SourceAdapter {
    const found = this.adapters.find((a) => a.id === id);
    if (!found) {
      throw new Error(
        `Adapter "${id}" is not registered. ` +
        `Available: ${this.adapters.map((a) => a.id).join(", ")}`,
      );
    }
    return found;
  }

  all(): readonly SourceAdapter[] {
    return this.adapters;
  }
}

// ---------------------------------------------------------------------------
// Singleton adapter instances
// ---------------------------------------------------------------------------

const asuraScansAdapter = new AsuraScansAdapter();

// ---------------------------------------------------------------------------
// Exported singleton registry
// ---------------------------------------------------------------------------

export const adapterRegistry: AdapterRegistry = new AdapterRegistryImpl([
  asuraScansAdapter,
  manhuaPlusAdapter,
  arenascanAdapter,
  drakeAdapter,
  hivetoonsAdapter,
  manhwanexAdapter,
  qimanhwaAdapter,
]);

// Re-export adapter classes for consumers.
export { AsuraScansAdapter } from "./asurascans.js";
export type { AdapterContext, SourceAdapter } from "../core/types.js";
