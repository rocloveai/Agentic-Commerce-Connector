// ---------------------------------------------------------------------------
// OAuth `state` nonce store — CSRF protection for the install callback.
//
// Each install issues a single-use, shop-bound, TTL-bounded state nonce. On
// callback we consume it; mismatch / expired / unknown → reject.
//
// In-memory only for v1 (single-process connector). Phase 4 can supply a
// Postgres-backed StateStore with the same shape without touching callers.
// ---------------------------------------------------------------------------

import { randomBytes } from "node:crypto";
import type { StateStore } from "./types.js";

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface Entry {
  readonly shop: string;
  readonly expiresAt: number;
}

export interface InMemoryStateStoreOptions {
  readonly ttlMs?: number;
  /** Injectable clock for tests. Defaults to Date.now. */
  readonly now?: () => number;
  /** Injectable RNG for tests. Defaults to 32 random bytes → hex. */
  readonly randomHex?: () => string;
}

export function createInMemoryStateStore(
  opts: InMemoryStateStoreOptions = {},
): StateStore {
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
  const now = opts.now ?? Date.now;
  const randomHex = opts.randomHex ?? (() => randomBytes(32).toString("hex"));
  const entries = new Map<string, Entry>();

  function sweep(): void {
    const t = now();
    for (const [state, entry] of entries) {
      if (entry.expiresAt <= t) entries.delete(state);
    }
  }

  return {
    issue(shop: string): string {
      sweep();
      const state = randomHex();
      entries.set(state, { shop, expiresAt: now() + ttl });
      return state;
    },

    consume(state: string, shop: string): boolean {
      const entry = entries.get(state);
      // Always delete on first touch — regardless of outcome — so a failed
      // attempt can't be retried with the same state value.
      if (entry) entries.delete(state);
      if (!entry) return false;
      if (entry.expiresAt <= now()) return false;
      if (entry.shop !== shop) return false;
      return true;
    },

    size(): number {
      return entries.size;
    },
  };
}
