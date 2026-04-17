# Shopify OAuth Onboarding — Research & Design

**Date:** 2026-04-16
**Status:** Draft / design proposal
**Scope:** Add a Shopify OAuth install flow to the open-source ACC connector so merchants who self-deploy can authorise the connector against their store with a single click, instead of hand-pasting tokens from Shopify admin → Develop apps.

---

## 1 Problem

Today the connector requires two manually-issued tokens in `.env`:

```
SHOPIFY_STORE_URL=https://my-store.myshopify.com
SHOPIFY_STOREFRONT_TOKEN=...
SHOPIFY_ADMIN_TOKEN=shpat_...
```

These come from the Shopify admin **Develop apps → Custom app** screen. That path works, but:

1. Every merchant has to click through ~15 UI steps to toggle each Admin and Storefront scope.
2. Token rotation is manual — if a token leaks, the merchant must revoke and re-paste.
3. There is no install audit trail: Shopify doesn't show the app in **Settings → Apps** the same way an OAuth-installed app does.
4. Scope drift is invisible — when ACC starts needing `read_customers` in a future release, the merchant must know to go back and toggle it.

OAuth fixes all four. The merchant clicks a link, approves the requested scopes on Shopify's own consent screen, and the connector receives an offline access token — the same way any third-party Shopify app works. Scope upgrades can be detected on startup and re-requested via a re-install URL.

We want to **add** OAuth while keeping the custom-app path as a fallback for users who don't want to run a Shopify Partners app.

---

## 2 Scope: two onboarding shapes, one codebase

ACC is self-host-first. That constraint pins the design: the connector cannot ship a shared `client_secret` in its repo, and it cannot assume a project-operated gateway exists. Two shapes survive that constraint and are what this document implements.

| | **Shape A** — Custom App (manual tokens) | **Shape B** — Custom-Distribution App (OAuth) |
|---|---|---|
| Where it's built | Shop admin → Develop apps | Partners portal → Apps → Create app |
| Partners account required | No | Yes (free, one-time ~2 min) |
| Public HTTPS callback required | No | **Yes** |
| Initial setup | Toggle 5 admin + 3 storefront scopes, copy 2 tokens into `.env` | Create app → paste `client_id`/`client_secret` into `.env` → click install link → approve on Shopify |
| First-install time | ~10 min | ~15 min |
| Scope upgrade | Re-toggle + re-paste token | Click re-install link, approve delta |
| Token rotation | Manual | Re-install rotates |
| Uninstall cleanup | None (stale token keeps working) | `app/uninstalled` webhook wipes token |
| Multi-store per merchant | One `.env` per store | One Partners App covers all their stores |

**Decision:** implement **Shape B** as the recommended path; keep **Shape A** as a fallback for local dev (no HTTPS) and for merchants who don't want a Partners account. Both paths share adapter code — only the credential-acquisition step differs.

The honest take on "is B simpler": **first-time setup is not dramatically simpler** (15 min vs 10 min). The real wins are long-term: scope upgrades, token rotation, and uninstall handling all become trivial instead of manual. Merchants running ACC once might prefer A; merchants running ACC long-term prefer B.

Distribution shapes we *don't* implement here — a public App Store listing (Shape C) and a fully-hosted onboarding gateway (Shape C') — are discussed in [Appendix A](#appendix-a--future-shapes-c-and-c-not-v1) as future upgrade paths that reuse the same adapter code.

---

## 3 OAuth flow (Shape B)

Shopify's OAuth follows the standard authorisation-code grant with HMAC-signed query parameters. Reference: `https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/authorization-code-grant`.

```
┌──────────┐    1. GET /auth/shopify/install?shop=X      ┌─────────┐
│ Merchant │ ───────────────────────────────────────────▶│   ACC   │
│ browser  │                                              └────┬────┘
└──────────┘                                                   │
     ▲                                                         │ 2. 302 → https://{shop}/admin/oauth/authorize
     │                                                         │       ?client_id=&scope=&redirect_uri=&state=&grant_options[]=
     │                                                         ▼
     │    3. consent screen on Shopify ◀───────────────── Shopify
     │
     │    4. 302 → /auth/shopify/callback?code=&shop=&state=&hmac=&timestamp=
     ▼
┌──────────┐    5. verify HMAC + state                   ┌─────────┐
│ Merchant │                                              │   ACC   │
│ browser  │                                              └────┬────┘
└──────────┘                                                   │ 6. POST https://{shop}/admin/oauth/access_token
                                                               │    { client_id, client_secret, code }
                                                               │
                                                               │ 7. { access_token, scope }
                                                               │
                                                               │ 8. persist (shop, access_token, scope)
                                                               │
                                                               │ 9. POST storefrontAccessTokenCreate
                                                               │    (Admin GraphQL)
                                                               │
                                                               │ 10. register app/uninstalled webhook
                                                               ▼
                                                       11. 302 /admin/shopify/installed
```

### Scopes we request

| Scope | Purpose in ACC |
|-------|----------------|
| `read_products` | Storefront catalog (via Admin-generated Storefront token) |
| `read_inventory` | Variant availability |
| `write_orders` | `orderCreate`, `orderMarkAsPaid` |
| `read_orders` | Idempotency check via order-tag query |
| `write_draft_orders` | (future) draft-order flow fallback |

Grant options: `per-user=false` (we want an **offline** token — a shop-scoped token that survives the installing user logging out).

### State / nonce

`state` is a random 32-byte hex string stored in a short-TTL cache (5 min, keyed by shop domain). On callback we compare and reject mismatches. Without it, CSRF could install the app on a victim's store.

### HMAC verification

Callback query is signed with the **app's client_secret**. Canonical form:
```
sort query params except `hmac`, join as k=v&k=v, HMAC-SHA256 with client_secret, hex digest
```
Compare to the `hmac` param using `timingSafeEqual`. Reject on mismatch.

### Shop-domain validation

`shop` param must match `/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i`. Anything else → 400. This closes the "attacker redirects callback to their own subdomain" class of bugs.

### Token exchange

`POST https://{shop}/admin/oauth/access_token` with form body:
```json
{ "client_id": "...", "client_secret": "...", "code": "..." }
```
Response:
```json
{ "access_token": "shpat_...", "scope": "read_products,write_orders,..." }
```

The returned `access_token` is the Admin API token. It has no expiry; it's invalidated only when the merchant uninstalls the app or rotates it manually.

### Storefront token provisioning

The OAuth grant doesn't give us a Storefront token directly. Once we have the Admin token, we call:

```graphql
mutation { storefrontAccessTokenCreate(input: { title: "ACC Connector" }) {
  storefrontAccessToken { accessToken }
  userErrors { field message }
}}
```

Persist that value. We can re-issue it any time by repeating the mutation.

### Webhook registration

On successful install, register at minimum:
- `app/uninstalled` → POST to `/webhooks/shopify/uninstalled`, so we can null out stored tokens.
- `shop/redact`, `customers/redact`, `customers/data_request` → required for Shape C (App Store) but harmless to register now.

---

## 4 Code surface

### 4.1 New module: `packages/connector/src/adapters/shopify/oauth/`

```
oauth/
  install.ts         build authorize URL, generate+store state
  callback.ts        verify HMAC + state, exchange code, persist token
  hmac.ts            canonical query string → HMAC-SHA256
  storefront.ts      call storefrontAccessTokenCreate
  webhooks.ts        register app/uninstalled + mandatory webhooks
  store.ts           Repository<ShopInstallation>
  types.ts           ShopInstallation, OAuthConfig
```

### 4.2 New env vars (`shopify.env`)

```
# ── OAuth mode (recommended) ──────────────────────────────────────────
# Create a Custom-Distribution app at partners.shopify.com → Apps → Create
# App URL:              https://<your-acc>/admin/shopify
# Allowed redirection:  https://<your-acc>/auth/shopify/callback
SHOPIFY_CLIENT_ID=
SHOPIFY_CLIENT_SECRET=
SHOPIFY_OAUTH_SCOPES=read_products,read_inventory,write_orders,read_orders
SHOPIFY_OAUTH_REDIRECT=https://acc.example.com/auth/shopify/callback

# ── Manual-token fallback (the current path) ──────────────────────────
# If SHOPIFY_CLIENT_ID is empty, the connector falls back to these:
SHOPIFY_STORE_URL=https://my-store.myshopify.com
SHOPIFY_STOREFRONT_TOKEN=
SHOPIFY_ADMIN_TOKEN=shpat_
```

### 4.3 New HTTP routes (registered in `portal.ts`)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/auth/shopify/install` | Start OAuth — expects `?shop=<domain>` |
| GET | `/auth/shopify/callback` | Complete OAuth — verifies HMAC, persists |
| POST | `/webhooks/shopify/app-uninstalled` | Null out tokens on uninstall |
| GET | `/admin/shopify` | Tiny status page — "Connected to `<shop>`, scopes: …" |

`/admin/shopify` is a single HTML page (no framework) gated by a bearer token derived from `config.adminBearer`. It shows connection state and a "Reinstall to upgrade scopes" button. No SPA dependency.

### 4.4 Config loader changes (`config/commerce.ts`)

`loadShopifyEnv` becomes two-phase:

```
if SHOPIFY_CLIENT_ID is set:
  return { mode: "oauth", clientId, clientSecret, scopes, redirect }
else:
  return { mode: "manual", storeUrl, storefrontToken, adminToken }   // today's path
```

`createAdaptersForConfig` (server.ts:56-85) already has a single place to branch; it now also looks up the installation from the store before handing config to the catalog/merchant adapters. For single-shop deployments we look up by shop domain (from `SHOPIFY_STORE_URL` if set, or by "the one installation in the table").

### 4.5 Storage

New Postgres table:

```sql
create table shopify_installations (
  shop_domain     text primary key,            -- foo.myshopify.com
  admin_token     text not null,               -- encrypted at rest (see §5)
  storefront_token text,
  scopes          text not null,
  installed_at    timestamptz not null default now(),
  uninstalled_at  timestamptz
);
```

Single row for v1 (we're still single-shop). The `primary key (shop_domain)` makes the extension to multi-shop a later migration, not a redesign.

### 4.6 CLI helper (optional)

`acc shopify auth` — prints `https://<self>/auth/shopify/install?shop=<shop>` so the merchant doesn't have to construct the URL by hand. Nice-to-have, not blocking.

---

## 5 Security

| Threat | Mitigation |
|--------|-----------|
| CSRF on install | `state` nonce, 5-min TTL, HMAC-bound to shop |
| Callback replay | `state` single-use; delete on first use |
| Open redirect | `shop` regex `*.myshopify.com`; reject otherwise |
| Forged callback | HMAC-SHA256 verification with `timingSafeEqual` |
| Token leak at rest | `admin_token` + `storefront_token` encrypted with AES-256-GCM using `ACC_ENCRYPTION_KEY` (32 bytes, from `openssl rand -hex 32`). Key never persisted. |
| Token leak in logs | `access_token` and `client_secret` added to the log-redaction allowlist |
| Uninstall cleanup | `app/uninstalled` webhook flips `uninstalled_at` and nulls tokens. Adapters refuse to start if the installation is marked uninstalled. |
| Scope escalation | On startup, compare `scopes` column to `SHOPIFY_OAUTH_SCOPES`. If code requires more than installation grants, show a re-install link in `/admin/shopify` and refuse to serve writes. |

`ACC_ENCRYPTION_KEY` is a new required var *only* when OAuth mode is active. Manual-token mode needs no encryption key (the token is already in env, which has its own threat model the operator chose).

---

## 6 Failure modes

1. **Shopify rejects the token exchange** (`invalid_request`) — most often wrong `redirect_uri`. Surface the raw error on the callback page with a copyable cURL reproduction.
2. **HMAC mismatch** — 400 with a generic message; log the canonicalised string at debug level for operator diagnosis.
3. **Storefront-token mutation fails** (rare — requires `unauthenticated_read_product_listings` on the app). Install still succeeds; we flag "storefront token unavailable" and the catalog adapter falls back to Admin API for reads. Slower but functional.
4. **Webhook registration fails** — non-fatal. Log a warning; install still completes. Merchant can click "Re-register webhooks" in `/admin/shopify`.
5. **Clock skew on `timestamp`** — if >60s skew, reject with 400 and a clear error. Most self-hosted boxes are NTP-synced, but Docker-on-laptop isn't.

---

## 7 Merchant-facing docs

Add `docs/SHOPIFY_SETUP.md`:

1. **If you just want to try ACC against your store:** Develop-apps flow (current). Two tokens, five minutes.
2. **If you want installable, revocable, scope-upgradeable access:** OAuth flow. ~15 min first time, zero-friction thereafter.
   - Create Partners account (free)
   - Create Custom-Distribution app
   - Set App URL + Allowed redirect URL
   - Copy client_id / client_secret into `.env`
   - Deploy ACC publicly (HTTPS required — Cloudflare Tunnel / ngrok works for testing)
   - Visit `https://<acc>/admin/shopify` → click **Install** → approve scopes on Shopify → done.

Include screenshots of each Partners-portal step. Shopify's own docs assume app-developer audience; ours needs to assume operator-who-just-wants-things-connected audience.

---

## 8 Out of scope (v1)

- **Shape C (Shopify App Store listing).** Requires privacy policy, billing API if we charge, App Store review. Worth doing once marketplace velocity justifies it — every merchant install becomes a signed skill submission, and a one-click App Store install is the cleanest top of that funnel.
- **Multi-shop per connector instance.** Schema supports it; routing logic doesn't. Out of scope until a hosted-ACC use case emerges.
- **Automatic scope upgrades.** For now we surface "needs reinstall" in the UI and let the merchant click. A silent upgrade needs Shopify's `token-exchange` flow, which is tied to App Bridge.
- **Shopify Billing API.** Not relevant — ACC is merchant-deployed, not charged via Shopify.

---

## 9 Implementation plan

Rough phasing, each phase independently shippable:

1. **Spec + types** (`oauth/types.ts`, config branch). No runtime change.
2. **HMAC + state util** (`oauth/hmac.ts`, `oauth/state.ts`) with tests — pure functions, easy to cover.
3. **Install + callback routes** wired to an in-memory store. End-to-end against a dev-store.
4. **Postgres persistence** + encryption. Gated behind `ACC_ENCRYPTION_KEY`.
5. **Storefront-token mutation + webhook registration.**
6. **Status page `/admin/shopify`** + scope-drift detection. Shows: current shop, granted scopes, last install time, a "Reinstall to upgrade scopes" CTA, and a "Rotate storefront token" button. Gated by bearer derived from `config.adminBearer`.
7. **Docs pass** — `SHOPIFY_SETUP.md` with step-by-step Partners-portal screenshots + an updated `env-examples/shopify.env` that embeds the Partners portal path as comments above every OAuth var (`Partners → Apps → Create app → Create app manually → Configuration → App URL / Allowed redirection URLs`).
8. **`acc shopify setup` interactive CLI** — a one-command onboarding assistant that: (a) prompts for the connector's public HTTPS URL, (b) prints the exact values to paste into Partners portal (`App URL = <url>/admin/shopify`, `Allowed redirection = <url>/auth/shopify/callback`), (c) opens the Partners portal in the browser (`open` / `xdg-open`), (d) prompts for the resulting `client_id` / `client_secret` and writes them into `.env`, (e) prints the install link the merchant should visit next. Dramatically shrinks the "I'm lost in the Partners portal" failure mode.
9. **Localhost developer ergonomics** — on boot, if `SELF_URL` is missing or resolves to `localhost`/`127.0.0.1` while Shape B vars are set, print a clear warning with two remediation paths: `ngrok http 3000` / Cloudflare Tunnel commands (copy-paste ready), or "fall back to Shape A by unsetting `SHOPIFY_CLIENT_ID`". Reject the misconfiguration rather than letting the OAuth flow fail opaquely in Shopify's authorize endpoint.
10. **WooCommerce counterpart** — same doc structure, but Woo has no OAuth. Instead we document the REST API key generation flow (current) and the Application Passwords alternative for WordPress >= 5.6.

Each phase is a single PR, each reviewable in <30 minutes. Phases 8 and 9 are the UX-polish pass that converts Shape B from "technically works" to "a non-Shopify-developer can complete it on the first try."

---

## 10 Open questions

1. **Do we require HTTPS for the callback?** Shopify does — the authorize endpoint rejects `http://` redirect URLs. This forces operators to have a cert before they can use OAuth. Mitigation: document Cloudflare Tunnel / ngrok for dev, and make the manual-token path still work locally.
2. **Where does the install link come from?** Either the operator constructs it themselves (`/auth/shopify/install?shop=foo.myshopify.com`) or we print it on boot. Leaning toward both — print on boot + a copyable link in `/admin/shopify`.
3. **Should `/auth/shopify/install` accept an anonymous request?** If yes, anyone who knows the ACC URL can start an install flow (they still can't complete it without owning the shop). If no, we need a bearer check. Leaning toward **yes** — matching Shopify's own behaviour for public apps and avoiding a chicken-and-egg bootstrap.
4. **Storefront token rotation cadence?** Shopify storefront tokens don't expire. Rotate on scope change or on operator request (`/admin/shopify → Rotate`).

---

## Appendix A — future shapes (C and C', not v1)

Documented here so the decision to defer them is explicit, and so future contributors can see what code in v1 was deliberately written to be reusable.

### Shape C — ACC publishes a public App Store app

We (the ACC project) register one public App in a project-owned Partners account. Merchants install with zero Partners signup; they still self-host the connector.

**Why it's deferred:**
- Requires Shopify App Store review (privacy policy, support email, marketing assets, GDPR webhook implementation — `customers/data_request`, `customers/redact`, `shop/redact`).
- We hold the `client_secret`. A leak is a project-wide incident, not a single-merchant incident.
- Shopify only allows one `redirect_uri` allowlist per App → every install's callback lands on *our* domain. We become a **handshake gateway** (not a runtime gateway — commerce traffic still goes direct).
- Needs a merchant-registration step on our side: merchant pre-registers their ACC instance URL, we issue a `forwarding_secret`, the callback forwards the freshly-issued `access_token` to their ACC via HMAC-signed POST.

**What v1 code already buys us:**
- `oauth/hmac.ts`, `oauth/state.ts`, `oauth/callback.ts` — unchanged. Only the "persist token locally" step forks into "persist locally (B) vs forward to registered ACC (C)".
- `shopify_installations` schema — unchanged, just lives on our side in C.
- Status page `/admin/shopify` — becomes the "installation dashboard" for merchants on our gateway.

### Shape C' — fully-hosted ACC (SaaS)

We host multi-tenant ACC on `xagenpay.com` (or similar). Merchants never deploy anything; they enter shop + wallet on a web form, click install, and get a slug-routed MCP endpoint (`xagenpay.com/mcp/{slug}`). Reinstall idempotency on `shop_domain` primary key preserves slug/DID/order history.

**Why it's deferred:**
- Orthogonal product. Strategy says self-host-first; C' is the opposite stance.
- Operational burden (uptime, SLA, encrypted token storage with KMS, incident response for token leakage, horizontal scaling) is non-trivial.
- Revenue model unclear — charging merchants collides with "open spec, open marketplace."

**What v1 code already buys us:**
- Adapters are already stateless and config-driven. Making them multi-tenant is a routing change (`getConfigForSlug(slug)` before calling adapters), not an adapter rewrite.
- The `shopify_installations` schema is already keyed on `shop_domain`, so "one row per tenant" works unchanged.
- UCP façade is already path-prefixable (`/ucp/v1/...` → `/ucp/v1/{slug}/...`).

### Graduation criteria

Revisit C when any of:
1. Marketplace has ≥50 signed merchant submissions and acquisition cost per merchant in Shape B becomes the bottleneck.
2. A partner (payment network, wallet, agent platform) requests a "one-click install" story for joint launch.
3. Shopify App Store adds meaningful discovery for AI/agent-commerce apps.

Revisit C' only if someone separately funds a hosted-commerce SKU with its own team.
