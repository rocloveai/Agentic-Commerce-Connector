# 2026-04-15 — Marketplace Pivot & Monorepo Split Design

## Context

Post-split from Nexus, the Agentic Commerce Connector (ACC) is re-scoped as an
open-source, self-hostable **UCP/1.0 data-layer wrapper** for traditional
e-commerce systems, plus a planned **commerce marketplace** that aggregates
merchant listings and skill files for AI-agent consumption.

User agents cannot discover self-deployed connector instances directly.
Merchants produce a **signed skill file** per this project's specification;
the marketplace becomes the discovery/distribution layer for those skills
(one-time acquisition — marketplace is NOT in the runtime request path).

## Core Decisions (from brainstorming session)

| # | Question | Decision |
|---|---|---|
| 1 | Skill granularity | **Per-merchant skill** (one `skill-package` per self-deployed connector) |
| 2 | Skill format | **OpenAPI 3.1 + JSON Schema tool signatures** (most neutral across agent ecosystems) |
| 3 | Generator shape | **CLI + `/skill/export` endpoint** (shared generation code) |
| 4 | Marketplace model | **Dynamic service (Node/TS + Postgres)**, stores merchant profile + signed skill; **does not maintain a separate endpoint registry** — the endpoint lives inside each skill |
| 5 | Identity / auth | **EVM wallet-based open platform** — merchant = address, each publish EIP-712-signed; future KYB attestations layered on top as non-blocking badges |
| 6 | Publish model | **Push-only, offline signing** (`acc-skill sign && acc-skill publish`); no pull, no periodic refresh |
| 7 | Signature scope | Covers technical fields (manifest / OpenAPI / tools); **display fields** (`profile.json`) are editable on marketplace without re-signing |
| 8 | Open source vs commercial | **Two repos**: connector + CLI + `@acc/skill-spec` are **public** (MIT); marketplace service is **private** and depends on the public spec package via npm |

## Non-Runtime Data Flow

```
[Onboarding]   Merchant  ──CLI sign──▶  Marketplace (Push, EIP-712)
[Discovery]    User Agent ──fetch───▶  Marketplace  ──skill file──▶ User Agent (learns once)
[Runtime]      User Agent ──HTTP────▶  Merchant Connector  (direct; marketplace out-of-path)
```

## Component Map

### Public repo — `agentic-commerce-connector` (current, MIT)

```
packages/
  connector/       # Current src/ — UCP HTTP façade, adapters, payment providers
                   # + new: GET /skill/export
  skill-spec/      # @acc/skill-spec (npm published)
                   #   - types.ts, eip712.ts, canonical.ts, schemas/*.json
                   #   - SPEC.md (normative)
  cli/             # @acc/cli — acc-skill {init,sign,publish,verify}
docs/
  SKILL_SPEC.md    # Normative protocol spec (links to package SPEC.md)
  plans/           # Design docs (this file)
```

### Private repo — `acc-marketplace` (new, closed source)

```
apps/
  api/             # Fastify/Express + Postgres. Depends on @acc/skill-spec
  web/             # Next.js — search/detail/publish guide/attestation badges
infra/             # terraform, render, k8s
ops/               # anti-abuse, KYB integration, blacklist
```

Dependency direction: **private → public** only, via npm (`@acc/skill-spec`).

## Skill Package Schema (v1.0)

```
skill/<merchant-address>/
  manifest.json      # signed — spec_version, merchant_address, endpoint,
                     # ucp_version, capabilities, payment_handlers, version,
                     # content_hash (sha256 of openapi+tools JCS), published_at
  openapi.json       # signed — UCP endpoint OpenAPI 3.1
  tools.json         # signed — JSON Schema tool signatures array
  signature.json     # { signer, signature, signed_at }  (EIP-712)
  profile.json       # UNSIGNED — name, logo_url, description, tags, screenshots
```

Signature = EIP-712 over `{ manifest_canonical, content_hash }` where
`manifest_canonical` is the RFC 8785 JCS form of `manifest.json`.

## Marketplace Data Model (for private repo reference)

```sql
signed_skills (
  id, merchant_address, version, manifest, openapi, tools,
  content_hash, signature, signed_at, published_at, is_latest, is_revoked
);

merchant_profiles (
  merchant_address, display_name, description, logo_url, category,
  tags, screenshots, social_links, attestations, updated_at
);
```

## Public API Surface

Read (unauthenticated):
- `GET  /api/v1/skills` — search, filter, paginate
- `GET  /api/v1/skills/index.json` — full directory snapshot (agent discovery)
- `GET  /api/v1/skills/:address`
- `GET  /api/v1/skills/:address/versions`
- `GET  /api/v1/skills/:address/v/:version`

Write (EIP-712 signed, no accounts):
- `POST  /api/v1/skills/:address` — publish new signed version
- `PATCH /api/v1/profiles/:address` — edit display fields (signature over profile hash)
- `POST  /api/v1/skills/:address/revoke` — revoke version (signed revocation)

Authorization rule: recovered signer MUST equal the `:address` URL segment.
No cookies, no tokens, no account table.

## Versioning

- `@acc/skill-spec` — SemVer. Marketplace pins `^1.x`.
- Breaking manifest field changes require `2.0.0` + migration window.

## Out of Scope (This Design)

- Marketplace implementation (separate private repo)
- KYB attestation schema (future extension)
- Agent-side SDK for learning skills (may emerge later based on adoption)
- Link rot / endpoint health monitoring (deferred; can be added as a
  non-authoritative enrichment layer later)

## This Change — Monorepo Split Scope

This PR/branch only does the **physical split of the public repo** into a
monorepo. Concrete acceptance:

1. npm workspaces configured; `npm install` at root works.
2. Existing connector code lives in `packages/connector/` with
   `npm run -w packages/connector build` producing `build/`.
3. `packages/skill-spec/` exists with stub types, EIP-712 typedData,
   JCS helper, and JSON Schemas. Builds as a declaration-only package.
4. `packages/cli/` exists with command scaffolding (`init/sign/publish/verify`
   returning "not implemented" placeholders).
5. Dockerfile, docker-compose.yml, render.yaml updated to new paths.
6. Root README rewritten to reflect monorepo + marketplace vision.
7. `docs/SKILL_SPEC.md` placeholder points to `packages/skill-spec/SPEC.md`.
8. Existing tests still pass.

Implementation of `/skill/export`, full EIP-712 signing, and CLI wiring come
in subsequent PRs.
