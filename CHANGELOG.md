# Changelog

## [0.7.0] - 2026-04-18

One-click shared-app onboarding: merchants authorise our shared Shopify
Partners app via a central relay at `install.xagenpay.com`, skipping the
need to create their own Partners account and/or Custom App.

### Added

- **`@acc/install-relay` package** — new monorepo workspace. Small
  HTTP service that hosts a single Shopify Partners app's OAuth
  callback on behalf of all merchants who run ACC. Runs on its own
  subdomain (`install.xagenpay.com`) with an isolated systemd user
  and SQLite-backed pairing store. Endpoints:
  - `POST /pair/new` — CLI creates a pair code, gets an `install_url` the
    merchant opens in a browser.
  - `GET /auth/shopify/install?pair=…` — shop-domain form → redirects to
    Shopify's OAuth authorize.
  - `GET /auth/shopify/callback` — verifies HMAC + state, exchanges `code`
    for an expiring offline token (with `expiring=1`), stores tokens
    keyed by pair code.
  - `GET /pair/poll?pair=…` — CLI polls, gets tokens once, pair row is
    consumed (single-use).
  - `POST /pair/refresh` — merchant ACC instances refresh expiring tokens
    via the relay without holding the shared app's `client_secret`.
- **`exchangeIdTokenForAccessToken`** (`@acc/connector/shopify-oauth`) —
  Shopify Token Exchange grant for embedded-mode installs; kept as a
  future code path even though v0.7 defaults to headless OAuth.
- **`verifyIdToken`** — HMAC-SHA256 verification of App Bridge session
  JWTs.
- **`refreshViaRelay`** helper — HTTP POST to the shared relay's
  `/pair/refresh` endpoint, translates 401 → `RelayRefreshRejected`
  sentinel so callers can prompt the merchant to reinstall.
- **Auto-refresh loop** in `ucp-binding.ts` — every UCP request checks
  the active installation's `tokenExpiresAt`; if <5 min remaining, calls
  the relay, atomically persists rotated tokens, and continues with the
  fresh admin token. Cache key extended to
  `(shop, installedAt, tokenFingerprint)` so refresh rebuilds adapters.
- **Schema v2** for `shopify_installations` (SQLite + Postgres) — new
  columns `token_expires_at INTEGER` + `refresh_token TEXT`, both
  nullable for backward compatibility with legacy non-expiring tokens.
  Idempotent `ALTER TABLE IF NOT EXISTS` migration on store open.

### Changed

- **`exchangeCodeForToken`** now sends
  `application/x-www-form-urlencoded` with **`expiring=1`**. This is
  Shopify's December-2025 policy for new Partners apps — without the
  flag, Shopify returns a deprecated non-expiring token that the Admin
  API rejects with 403 ("Non-expiring access tokens are no longer
  accepted"). With the flag, the response carries `expires_in` (≈3600)
  + `refresh_token` (rotates) and the token works for every Admin API
  call.
- **`refreshAccessToken`** also uses urlencoded body (symmetry).
- **CLI `step6-shopify`** — replaced Custom-App token prompts with the
  shared-app pair flow. Prints the install URL, attempts to open the
  merchant's browser, polls the relay for up to 10 minutes, then writes
  the returned installation directly into the local encrypted
  installation-store. Non-interactive seed path retained for scripted
  reproduction.
- **CLI `step7-sqlite`** — schema DDL updated to v2 with idempotent
  column-add migration.
- **Connector `server.ts`** — `startHttpModeOAuthOnly()` now passes
  `relayUrl` (from `ACC_INSTALL_RELAY_URL` env, default
  `https://install.xagenpay.com`) into the UCP resolver for auto-refresh.
- **Install site** — new subdomain `install.xagenpay.com` with Caddy
  Let's Encrypt certificate, systemd unit, isolated data directory.

### Fixed

- **bun:sqlite parameter binding** — `openSqlite` abstraction now
  normalises bare-key parameter objects (`{shop_domain: …}`) to the
  `@name` prefix that bun:sqlite requires. Prevents silent NULL binds
  that caused `NOT NULL constraint failed` on compiled binaries while
  tests (Node + better-sqlite3) passed cleanly.
- **UCP_CART_TOKEN_SECRET fallback** — when the env var is absent, the
  connector now derives a stable 64-hex secret from
  `ACC_ENCRYPTION_KEY` via HMAC-SHA256 with a fixed label. `acc init`
  no longer has to prompt the merchant for yet another secret.

### Security

- Merchant instances do **not** hold the shared app's `client_secret`;
  only the central relay does. Token refresh happens via the relay.
- Installation-store encrypts admin/storefront/refresh tokens at rest
  with AES-256-GCM under a per-installation key generated at
  `acc init` time.
- Pair codes are 128-bit random, single-use, 15-minute TTL.

## [0.2.0] - 2026-04-15

Major rewrite to UCP/1.0 native.

### Added
- **UCP/1.0 façade** (`/ucp/v1/*`) — Discovery, Search, Product lookup, Checkout Sessions (create, retrieve, complete), Order retrieval. Validated against UCP spec pinned at `2026-04-08`. See [docs/ucp-compliance.md](docs/ucp-compliance.md).
- **WooCommerce adapter** — `adapters/woocommerce/*` implements `CatalogAdapter` + `MerchantAdapter` against WC REST v3. HTTPS-only Basic auth, retry with jitter on 429/5xx, variant ID encoding `woo:{parent}[:{variation}]`, and dual idempotency (meta_query primary + recent-order scan fallback).
- **Nexus PaymentProvider** — `payment/nexus/*` factory implementing the `PaymentProvider` interface. Surfaces itself to UCP discovery via `describe()`.
- **HMAC cart tokens** — `ucp/cart-token.ts`; stateless, constant-time verify, configurable TTL (default 15 min).
- **Shopify field enrichment** — `sku`, `brand` (vendor), `inventory_quantity` (quantityAvailable) now populated on both product list and variant lookup.
- **Contract tests** — UCP schema validation across both Shopify and Woo adapters (`ucp-contract.test.ts`).
- 35+ new tests; full suite now at 163 passing.

### Changed
- `skill.md` bumped to `protocol: UCP/1.0`, `payment_protocol: NUPS/1.5`, category `commerce.universal`.
- Internal types (`CommerceProduct` / `CommerceVariant`) extended with optional `brand`, `sku`, `inventoryQuantity`.
- Default config currency switched to `XSGD` (Nexus primary stablecoin).

### Deprecated
- `/api/v1/*` legacy REST routes. Still functional for backwards compatibility; planned removal in `1.0.0`.

### Fixed
- Duplicate `PaymentQuote` import in `src/types.ts`.
- Stale `nexus_payment_id` reference in `services/webhook-handler.ts` (now `payment_id`).

## [0.1.0] - initial

- Shopify Storefront + Admin adapter
- Checkout session service + NUPS quote builder
- NUPS HTTP REST routes (`/api/v1/*`)
- MCP tools: search_products, get_product, create_checkout, check_checkout_status
- Docker + docker-compose deployment
