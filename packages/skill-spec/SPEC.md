# ACC Skill Package Specification (acc-skill/1.0)

**Status:** draft · **Date:** 2026-04-15

Normative specification for the skill package that merchants publish for AI
user-agents to consume. Implementations MUST conform to this document to
interoperate with the ACC marketplace (or any third-party compatible
marketplace).

## 1. Terminology

- **Merchant** — an operator who runs a self-deployed ACC connector.
- **Skill package** — the set of files in this spec that describes a merchant's
  agent-facing surface.
- **User agent** — any software that consumes a skill package to interact with
  a merchant's connector.
- **Marketplace** — a directory service that stores, verifies, and lists
  signed skill packages. Marketplace is NOT in the runtime request path.

## 2. Package Layout

```
skill/<merchant-address>/
├── manifest.json       MUST — signed
├── openapi.json        MUST — signed (by reference via content_hash)
├── tools.json          MUST — signed (by reference via content_hash)
├── signature.json      MUST — the signature itself
└── profile.json        MAY  — unsigned, editable on marketplace
```

## 3. manifest.json

```jsonc
{
  "spec_version": "acc-skill/1.0",          // MUST match this spec
  "merchant_address": "0xabc...def",        // MUST — EVM address, checksum
  "platform": "woocommerce",                // MUST — adapter identifier
  "ucp_version": "2026-04-08",              // MUST — UCP spec date
  "endpoint": "https://store.example.com/ucp/v1",
  "payment_handlers": ["nexus-usdc"],
  "capabilities": ["discovery", "search", "checkout", "orders"],
  "content_hash": "sha256:...",             // of { openapi, tools } canonicalized
  "published_at": "2026-04-15T10:00:00Z",
  "version": "1.0.0"                        // SemVer
}
```

## 4. Canonicalization

Canonical JSON form follows RFC 8785 (JCS) principles: keys sorted
lexicographically, no whitespace, undefined values dropped. The reference
implementation is [`@acc/skill-spec`](./src/canonical.ts).

`content_hash` = `"sha256:" + hex(sha256(canonicalize({ openapi, tools })))`.

## 5. Signature (EIP-712)

Domain:

```
{ name: "AgenticCommerceConnector.Skill", version: "1", chainId: <int> }
```

Primary type `Skill` with the fields listed in `SKILL_EIP712_TYPES`
(see [`eip712.ts`](./src/eip712.ts)). Signer MUST equal
`manifest.merchant_address`. Marketplace MUST reject a publish whose recovered
signer differs from the URL path address.

## 6. profile.json (unsigned)

Editable display metadata. Fields: `display_name` (required), `description`,
`logo_url`, `category`, `tags`, `screenshots`, `social_links`.
Marketplace operators MAY moderate these fields.

## 7. Versioning

- `spec_version` is frozen at `acc-skill/1.0` for all 1.x manifests.
- `@acc/skill-spec` npm package follows SemVer; consumers SHOULD pin
  `^1.x`.
- Breaking additions to the signed manifest schema require a new
  `spec_version` (`acc-skill/2.0`) and a compatibility window.

## 8. Out of Scope

- Marketplace API surface (see private `acc-marketplace` repo).
- Endpoint-health monitoring, attestations, KYB badges — may be layered on
  top without modifying this spec.
