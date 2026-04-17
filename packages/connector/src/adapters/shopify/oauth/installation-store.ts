// ---------------------------------------------------------------------------
// Installation store — persists one ShopInstallation per shop domain.
//
// Phase 3 ships only the in-memory implementation. Phase 4 swaps to a
// SQLite/Postgres-backed impl by returning a different object from the
// factory; the interface doesn't change, so callers aren't rewritten.
// ---------------------------------------------------------------------------

import type { ShopInstallation } from "./types.js";

export interface InstallationStore {
  get(shop: string): Promise<ShopInstallation | null>;
  save(installation: ShopInstallation): Promise<void>;
  markUninstalled(shop: string, at: number): Promise<void>;
  list(): Promise<readonly ShopInstallation[]>;
}

export function createInMemoryInstallationStore(): InstallationStore {
  const rows = new Map<string, ShopInstallation>();

  return {
    async get(shop: string): Promise<ShopInstallation | null> {
      return rows.get(shop) ?? null;
    },

    async save(installation: ShopInstallation): Promise<void> {
      rows.set(installation.shopDomain, installation);
    },

    async markUninstalled(shop: string, at: number): Promise<void> {
      const existing = rows.get(shop);
      if (!existing) return;
      rows.set(shop, { ...existing, uninstalledAt: at });
    },

    async list(): Promise<readonly ShopInstallation[]> {
      return Array.from(rows.values());
    },
  };
}
