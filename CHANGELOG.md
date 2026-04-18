

## [0.8.1] - 2026-04-18

Internal cleanup. No behaviour change; all 323 connector + 85 CLI tests
still green.

### Removed

Session-2 dead code from the embedded-iframe / Token-Exchange
experiment that got abandoned once the real root-cause (the
`expiring=1` parameter) was found:

- `packages/install-relay/src/routes/embed.ts`
- `packages/install-relay/src/routes/token-exchange.ts`
- `/embed` and `/auth/shopify/token-exchange` route registrations in
  `install-relay/src/server.ts`
- `packages/connector/src/adapters/shopify/oauth/id-token-verify.ts`
- `exchangeIdTokenForAccessToken` function in
  `connector/src/adapters/shopify/oauth/token-exchange.ts`
- Corresponding re-exports from `oauth/index.ts`

These modules were never called on a live install once the relay was
switched to classic OAuth + `expiring=1` in v0.7. Keeping them around
risked leading future readers down the wrong path.

## [0.8.0] - 2026-04-18

One-command VPS deploy. Merchants can now take a blank Ubuntu/Debian
server from zero to a TLS-fronted, systemd-managed ACC instance with
an interactive Shopify install — in a single shell command.

### Added
- **`install-server.sh` rewritten** as a full bootstrap script:
  ```bash
  curl -fsSL https://get.xagenpay.com/install-server | \
    ACC_PUBLIC_HOSTNAME=acc.mystore.com sudo bash
  ```
  End-to-end:
    1. Pre-flight: root check, hostname / DNS match, existing-install
       detection.
    2. Creates the `acc` system user + installs the binary via the CLI
       installer.
    3. Writes a hardened systemd unit (`PortalPort`, `NoNewPrivileges`,
       `ProtectSystem=strict`, `ReadWritePaths=~acc/.acc`).
    4. Configures a reverse proxy: detects existing nginx or Caddy,
       otherwise installs Caddy fresh. nginx path wires up certbot
       + Let's Encrypt; Caddy handles auto-TLS.
    5. Re-attaches stdin to `/dev/tty` so the interactive `acc init`
       wizard prompts work even under `curl | bash`. Seeds the public
       URL from `ACC_PUBLIC_HOSTNAME`; signer / payout / Shopify pair
       remain interactive.
    6. `systemctl enable --now acc` and smoke-test.
- **`get.xagenpay.com/install-server`** endpoint (served by the Pages
  workflow from `deploy/scripts/install-server.sh`).
- **`ACC_PUBLIC_HOSTNAME` env var is a soft pre-fill** for `acc init`
  step 3: when set, the wizard skips the public-URL prompt and uses
  `https://$ACC_PUBLIC_HOSTNAME` without activating seed mode (so
  signer / payout / Shopify still prompt normally). Used by the VPS
  bootstrap script; harmless otherwise.

### Changed
- **Landing page at `get.xagenpay.com`** now shows two install
  commands: the CLI-only `curl | install | sh` and the full VPS
  bootstrap with `ACC_PUBLIC_HOSTNAME`. Version pin example bumped
  to v0.7.5. Source link corrected to rocloveai/.

## [0.7.5] - 2026-04-18

### Fixed
- **"Start over" now actually starts over**: when the re-entrance menu's
  "start over" choice (or `--force`) is picked, `acc init` now also
  backs up the existing `signer.key` to `signer.key.bak.<timestamp>` so
  the signer step regenerates a fresh identity. Previously the signer
  was silently preserved — users who chose "start over" expecting a
  clean slate saw the Payout step skip past an interactive signer
  prompt. The encryption key is still preserved on reset (rotating it
  would render existing `shopify_installations` rows unreadable).

## [0.7.4] - 2026-04-18

Awareness-of-state UX: the user should always know what's about to happen
and whether the service is running.

### Added
- **Authorize gate before browser opens**: after the merchant types their
  Shopify store domain in the CLI, the install URL is printed in a box,
  then `acc init` pauses on a single-keypress prompt —
  "Press Enter to authorize in Shopify (or Ctrl+C to abort)". The
  browser only launches after the confirmation. Previously the browser
  popped up immediately after payout-address confirmation, giving users
  no beat to register the transition.
- **"ACC is running" banner in `acc start`**: after the connector
  finishes booting, a visually-separated block prints the port, public
  URL, UCP discovery URL, and skill.md URL, plus a Ctrl+C hint. On
  shutdown, a matching "shutting down" line prints. The existing
  connector log lines still appear above (warnings about
  DATABASE_URL / PORTAL_TOKEN etc.), but the banner makes "I am live
  now" visually unambiguous.
- **Separator line around `acc init` finale**: the "Setup complete"
  block is now wrapped in horizontal rules so the user can see where
  setup ends and their shell returns.
- **`Prompter.pressEnterToContinue`** helper — a new single-keypress
  raw-mode gate used by the authorize step. Non-TTY paths (tests,
  piped stdin) resolve immediately without blocking.

## [0.7.3] - 2026-04-18

Second-round UX fixes after live testing v0.7.2.

### Fixed
- **Arrow-select rendering**: selected choice no longer duplicates after
  Enter (previously the arrow-cursor line was echoed twice on commit).
  `clearList` simplified to walk-up-and-clear; menu teardown now uses
  `\x1b[J` to wipe everything below in a single op.

### Changed
- **Shop domain moved into CLI**: `acc init` now prompts
  `Shopify store domain (e.g. my-shop.myshopify.com)` in the terminal
  before opening the browser, and embeds `&shop=<domain>` in the
  install URL. The merchant types their shop once, in their terminal,
  and the browser goes straight to Shopify's OAuth authorize page —
  no intermediate HTML form on `install.xagenpay.com`.
- **Browser-open transition**: brief "Opening in your browser…" message
  + 800 ms pause between showing the URL box and spawning the browser,
  so the user has a beat to notice what's happening before their browser
  takes focus.

## [0.7.2] - 2026-04-18

Follow-up UX polish based on first real-user feedback.

### Added
- **Arrow-key choice selection** for every `askChoice` prompt in
  `acc init` — `↑` / `↓` move, `Enter` commits, number keys (`1`..`N`)
  jump directly, `Ctrl+C` aborts. Non-TTY input (tests, scripted
  pipes) still falls back to letter keys, so existing PromptIO mocks
  keep working.
- **Signer step now shows full wallet details after generate**:
  ```
  ✓  Signer wallet         generated
     address     0xB026B6B9F2C41ED82D3DeF31ACe31FDe18BCF28e
     key file    /home/acc/.acc/keys/signer.key  (mode 0600)
     ⚠  Back this file up off-server before going live.
  ```
  Previous behaviour printed only a truncated address — merchants had
  no visible handle to copy for backup.

### Changed
- `install.sh` post-install message: "8-step setup wizard" → "setup
  wizard (browser-based Shopify connect)" to match the current flow.

## [0.7.1] - 2026-04-18

UX polish for `acc init`. No behavioural changes; merchants see a much
friendlier wizard.

### Added
- **`shared/ui.ts`** — terminal UI primitives (colours, spinner, boxed URL,
  checkmark rows). No external deps; falls back to plain text when
  `NO_COLOR` is set or stdout isn't a TTY.
- **`--advanced` flag for `acc init`** — opt-in to the legacy full-fat
  prompt flow (customise selfUrl, signer options, etc.).
- **Dedicated payout-address step** (`step5b-payout.ts`). Three choices:
  same as signer (simple), paste a different address (recommended for
  production), or defer. No longer silently defaults to signer.

### Changed
- **`acc init` default path**: compressed from "8-step wizard" rendering
  to a checklist of background steps + a single interactive section for
  signer choice + payout choice + Shopify pair. Typical zero-advanced run
  looks like:
  ```
  ▲  Agentic Commerce Connector

  ✓  Runtime           Node 20.17.0
  ✓  Data directory    ~/.acc
  ✓  Public URL        http://localhost:10000  (change with --advanced)
  ✓  Encryption key    AES-256

  ┃  Signer wallet
  ? How do you want the signer set up?  ❯ auto-generate

  ┃  Payout address
  ? Payout address  ❯ same as signer / paste separate / configure later

  ┃  Connect your Shopify store
  ⠋ waiting for you to authorize…  14:37 remaining

  ✨  All set.
  ```
- **`SELF_URL` default**: now `http://localhost:10000` (was the footgun
  `https://acc.example.com`, which users often mistyped as their shop
  URL). Users still running a public instance can pass `--advanced` or
  edit `.env` directly.
- **Shopify pair-flow polling**: dot-polling replaced with an animated
  spinner + live mm:ss countdown until the install link expires. The
  install URL is shown in a boxed Cyan frame so it stands out.
- **Finale summary**: more celebratory, highlights a single next command
  (`acc start`) instead of burying it.

### Fixed
- Wizard's signer step no longer asks about payout as a sub-prompt; the
  two are genuinely separate concerns (see rationale in step5b).

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
