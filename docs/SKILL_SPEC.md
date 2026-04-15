# ACC Skill Specification

The normative specification for the ACC skill package lives in
[`packages/skill-spec/SPEC.md`](../packages/skill-spec/SPEC.md) and is
versioned alongside the `@acc/skill-spec` npm package that provides the
reference implementation of its canonicalization and EIP-712 signing.

Current version: **`acc-skill/1.0`** (draft, 2026-04-15).

## Summary

Every merchant who self-deploys the ACC connector produces a **skill package**
consisting of:

- `manifest.json` — signed manifest (merchant address, endpoint, capabilities,
  content hash of OpenAPI + tools)
- `openapi.json` — OpenAPI 3.1 description of the merchant's UCP endpoint
- `tools.json` — JSON Schema tool signatures for agent binding
- `signature.json` — EIP-712 signature over the manifest
- `profile.json` — optional, unsigned display metadata for marketplace listing

The merchant's wallet address signs the package; the marketplace verifies the
signature and lists the package. User agents download the package **once**,
learn the OpenAPI + tools, and then talk directly to the merchant connector.

## Why it's in `packages/skill-spec/`

Keeping the spec co-located with its reference implementation guarantees the
doc and the verifier can never drift apart. Any third-party marketplace can
import `@acc/skill-spec` to verify signatures without reimplementing the
protocol.

See [`packages/skill-spec/SPEC.md`](../packages/skill-spec/SPEC.md) for the
full normative text.
