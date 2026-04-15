import type { CommerceProduct } from "../../types/commerce.js";

interface CacheEntry {
  readonly product: CommerceProduct;
  readonly expiresAt: number;
}

export interface ProductCache {
  readonly get: (handle: string) => CommerceProduct | null;
  readonly set: (handle: string, product: CommerceProduct) => void;
  readonly clear: () => void;
  readonly size: () => number;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes

export function createProductCache(
  ttlMs: number = DEFAULT_TTL_MS,
): ProductCache {
  const store = new Map<string, CacheEntry>();

  function evictExpired(): void {
    const now = Date.now();
    for (const [key, entry] of store) {
      if (entry.expiresAt <= now) {
        store.delete(key);
      }
    }
  }

  function get(handle: string): CommerceProduct | null {
    const entry = store.get(handle);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      store.delete(handle);
      return null;
    }
    return entry.product;
  }

  function set(handle: string, product: CommerceProduct): void {
    // Lazy eviction: clean up on every 100th write
    if (store.size > 0 && store.size % 100 === 0) {
      evictExpired();
    }
    store.set(handle, {
      product,
      expiresAt: Date.now() + ttlMs,
    });
  }

  function clear(): void {
    store.clear();
  }

  function size(): number {
    evictExpired();
    return store.size;
  }

  return { get, set, clear, size };
}
