# Agentic Commerce Connector (ACC)

> Open-source **UCP/1.0 data-layer wrapper** for traditional e-commerce, plus
> a publishable **skill toolchain** that lets AI agents discover and transact
> with any merchant who self-deploys this connector.

[![UCP Version](https://img.shields.io/badge/UCP-2026--04--08-brightgreen)](https://ucp.dev/specification/overview)
[![License](https://img.shields.io/badge/license-MIT-blue)]()

## What this is

A merchant installs ACC in front of their existing storefront (Shopify /
WooCommerce / …). ACC exposes a standardized **UCP/1.0** surface that AI
agents understand, and emits a **signed skill package** that a merchant can
publish so user agents can discover and consume the endpoint.

```
 AI User Agent ──learns once──▶ Skill package (signed, from marketplace)
       │
       ▼  direct HTTP, UCP/1.0
 ┌────────────────────────────────┐
 │  ACC Connector                 │
 │  /ucp/v1/discovery             │
 │  /ucp/v1/search                │
 │  /ucp/v1/checkout-sessions     │
 │  /ucp/v1/orders                │
 │  /auth/shopify/{install,callback}
 │  /admin/shopify                │
 │  /.well-known/acc-skill.md     │
 └──────────┬─────────────────────┘
  CatalogAdapter · MerchantAdapter · PaymentProvider
            │
 Shopify · WooCommerce · Nexus stablecoins · …
```

## Repo layout (npm workspaces)

```
packages/
  connector/     @acc/connector    UCP façade + Shopify OAuth + adapters
  skill-spec/    @acc/skill-spec   Normative spec + EIP-712 + JCS + schemas
  cli/           @acc/cli          'acc' — init wizard, shopify, wallet,
                                   publish, skill (legacy 'acc-skill' alias)
docs/
  MERCHANT_ONBOARDING.md           Step-by-step merchant setup guide
  CLI.md                           Full command reference for 'acc'
  SKILL_SPEC.md                    Normative protocol spec
  plans/                           Design + execution plans
```

The **marketplace** that hosts published skill packages lives in a **separate
private repo** (`acc-marketplace`) and depends on `@acc/skill-spec` via npm.
Anyone can build a compatible marketplace against the public spec.

## Quick Start

### One-liner install (macOS + Linux)

```bash
curl -fsSL https://get.xagenpay.com/install | sh
```

This drops the `acc` binary into `~/.acc/bin` and adds it to your PATH. No
Node, no `npm install`, no clone. Supports:

- `darwin-arm64` (Apple Silicon M1/M2/M3/M4)
- `darwin-x64` (Intel Mac)
- `linux-x64`
- `linux-arm64`

Once installed:

```bash
# 8-step interactive wizard — creates ~/.acc with config.json, .env,
# encryption key, signer wallet, Shopify creds, SQLite schema, skill.md.
acc init

# Boot the connector (foreground; Ctrl-C to stop).
acc start

# In another terminal — prints install URL + QR, polls until install done.
acc shopify connect --shop=<your-store>.myshopify.com

# Edit the generated skill template, then publish to the marketplace.
$EDITOR ~/.acc/skill/acc-skill.md
acc publish

# Verify + diagnose anytime.
acc doctor
acc upgrade
```

Pin a specific version: `curl -fsSL https://get.xagenpay.com/install | ACC_VERSION=v0.4.0 sh`

### Install from source (contributors)

```bash
git clone https://github.com/SELFVIBECODING/agentic-commerce-connector.git
cd agentic-commerce-connector
npm install && npm run build
npx acc init
npx acc start
```

Full walkthrough: [docs/MERCHANT_ONBOARDING.md](./docs/MERCHANT_ONBOARDING.md).
All CLI commands: [docs/CLI.md](./docs/CLI.md).

### Docker

```bash
docker compose up -d
```

## Why this shape

- **Self-host first.** Merchants own their data; ACC is just a translator.
- **Wallet-based identity.** Skill packages are EIP-712 signed by the
  merchant's wallet. No account system, no central gatekeeper for the
  protocol layer.
- **Open platform.** The spec (`@acc/skill-spec`) is MIT. Anyone can build
  a marketplace, client SDK, or compatible merchant tool against it.
- **Marketplace is off-path.** Once a user agent has learned a skill, it talks
  directly to the merchant connector. No proxy, no marketplace dependency at
  runtime.

## Status

- `packages/connector/` — UCP façade, Shopify adapter with full OAuth install
  flow (HMAC + state + token exchange + storefront token mint + webhook
  register), WooCommerce adapter, Nexus payment provider, AES-256-GCM
  at-rest token encryption, SQLite + Postgres installation stores.
- `packages/skill-spec/` — v0.1 types, EIP-712 typed data, JCS canonicalisation,
  JSON Schemas. Spec doc at `packages/skill-spec/SPEC.md`.
- `packages/cli/` — `acc` binary shipped: init (8-step wizard), start, doctor,
  upgrade, shopify connect, wallet (show/new/import), publish (zero-arg),
  skill init, version, help. Cross-compiled with Bun (`bun build --compile`);
  `bun:sqlite` is statically linked so no native addons ship. Deferred:
  `acc stop/status`, `acc skill edit`, `acc shopify status/disconnect`.

## Documentation

- Merchant onboarding: [docs/MERCHANT_ONBOARDING.md](./docs/MERCHANT_ONBOARDING.md)
- CLI reference: [docs/CLI.md](./docs/CLI.md)
- Skill spec: [docs/SKILL_SPEC.md](./docs/SKILL_SPEC.md)
- UCP compliance notes: [docs/ucp-compliance.md](./docs/ucp-compliance.md)
- Install site deploy (`get.xagenpay.com`): [docs/DEPLOY_INSTALL_SITE.md](./docs/DEPLOY_INSTALL_SITE.md)
- Design + execution plans: [docs/plans/](./docs/plans/)

## License

MIT.
