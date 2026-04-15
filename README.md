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
 ┌────────────────────────────┐
 │  ACC Connector             │
 │  /ucp/v1/discovery         │
 │  /ucp/v1/search            │
 │  /ucp/v1/checkout-sessions │
 │  /ucp/v1/orders            │
 │  /skill/export  (new)      │
 └──────────┬─────────────────┘
  CatalogAdapter · MerchantAdapter · PaymentProvider
            │
 Shopify · WooCommerce · Nexus stablecoins · …
```

## Repo layout (npm workspaces)

```
packages/
  connector/     @acc/connector    UCP façade + adapters + /skill/export
  skill-spec/    @acc/skill-spec   Normative spec + EIP-712 + JCS + schemas
  cli/           @acc/cli          acc-skill {init,sign,publish,verify}
docs/
  SKILL_SPEC.md                    Normative protocol spec (link to package)
  plans/                           Design documents
```

The **marketplace** that hosts published skill packages lives in a **separate
private repo** (`acc-marketplace`) and depends on `@acc/skill-spec` via npm.
Anyone can build a compatible marketplace against the public spec.

## Quick Start (connector)

```bash
git clone https://github.com/example/agentic-commerce-connector.git
cd agentic-commerce-connector
npm install

cp packages/connector/env-examples/base.env .env
# Fill in PLATFORM=shopify | woocommerce and credentials.
# Generate a cart-token secret: openssl rand -hex 32

npm run build
npm start
```

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

- `packages/connector/` — working UCP façade, Shopify & WooCommerce adapters,
  Nexus payment provider.
- `packages/skill-spec/` — v0.1 stubs: types, EIP-712 typed data, JCS
  canonicalization, JSON Schemas. Spec doc at `packages/skill-spec/SPEC.md`.
- `packages/cli/` — command scaffolding. Implementations (init/sign/publish/
  verify) land in follow-up PRs.

## Documentation

- Design: [docs/plans/2026-04-15-marketplace-pivot-design.md](./docs/plans/2026-04-15-marketplace-pivot-design.md)
- Spec: [docs/SKILL_SPEC.md](./docs/SKILL_SPEC.md)
- UCP compliance notes: [docs/ucp-compliance.md](./docs/ucp-compliance.md)

## License

MIT.
