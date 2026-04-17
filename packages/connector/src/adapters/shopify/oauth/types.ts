// ---------------------------------------------------------------------------
// Shared types for the Shopify OAuth install flow.
//
// Owned by this module so that downstream persistence + route code does not
// need to know how the flow is wired (pure types, no runtime).
// ---------------------------------------------------------------------------

/**
 * A completed OAuth installation, as persisted by the connector after a
 * successful callback. Token fields are plaintext in-process; they are
 * encrypted on the way to storage (see token-cipher.ts in Phase 4).
 */
export interface ShopInstallation {
  readonly shopDomain: string;
  readonly adminToken: string;
  readonly storefrontToken: string | null;
  readonly scopes: readonly string[];
  readonly installedAt: number;
  readonly uninstalledAt: number | null;
}

/**
 * Immutable OAuth app configuration derived from env + selfUrl. Built once at
 * boot by server.ts; every route handler takes this as an argument rather
 * than re-reading env.
 */
export interface OAuthConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly scopes: readonly string[];
  readonly redirectUri: string;
  readonly apiVersion: string;
}

/**
 * Store for transient `state` nonces issued at install time and consumed on
 * the OAuth callback. Single-use per state value; TTL-bounded. The in-memory
 * implementation is fine for single-process deployments; Phase 4 may swap in
 * a Postgres-backed store without changing the shape of this interface.
 */
export interface StateStore {
  /** Returns a fresh 32-byte hex state bound to the given shop domain. */
  issue(shop: string): string;

  /**
   * Returns true iff the state exists, matches the shop, and is within its
   * TTL. Consumes the state on success AND on failure so replay attempts hit
   * a miss on the second try.
   */
  consume(state: string, shop: string): boolean;

  /** Test hook: number of live entries (includes expired-but-not-swept). */
  size(): number;
}
