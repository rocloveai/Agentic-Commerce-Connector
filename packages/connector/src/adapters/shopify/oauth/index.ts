// Re-exports for external consumers (install-relay and future CLI helpers)
// so they don't have to import deep paths. Keeps the public surface explicit.

export {
  exchangeCodeForToken,
  exchangeIdTokenForAccessToken,
  refreshAccessToken,
} from "./token-exchange.js";
export type {
  TokenExchangeResponse,
  TokenExchangeOptions,
} from "./token-exchange.js";

export { verifyIdToken } from "./id-token-verify.js";
export type { IdTokenClaims } from "./id-token-verify.js";

export { refreshViaRelay, RelayRefreshRejected } from "./relay-refresh.js";
export type { RelayRefreshOptions, RelayRefreshResult } from "./relay-refresh.js";

export { createStorefrontToken } from "./storefront.js";
export type { CreateStorefrontTokenOptions, CreateStorefrontTokenResult } from "./storefront.js";

export { assertShopDomain } from "./shop-domain.js";

export { verifyCallbackHmac } from "./hmac.js";

export type { ShopInstallation, OAuthConfig, StateStore } from "./types.js";

export {
  createInMemoryStateStore,
} from "./state.js";

export {
  createInMemoryInstallationStore,
} from "./installation-store.js";
export type { InstallationStore } from "./installation-store.js";

export {
  createSqliteInstallationStore,
} from "./installation-store-sqlite.js";
export type {
  SqliteInstallationStore,
  SqliteInstallationStoreOptions,
} from "./installation-store-sqlite.js";
