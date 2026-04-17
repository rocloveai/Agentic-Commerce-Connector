// ---------------------------------------------------------------------------
// Pure scope-drift computation.
//
// When ACC ships a new release that needs a scope the merchant didn't grant
// on last install, we surface the delta on /admin/shopify and refuse writes
// rather than silently 403ing at runtime (see design doc §5 row 7).
// ---------------------------------------------------------------------------

export interface ScopeDiff {
  readonly granted: readonly string[];
  readonly requested: readonly string[];
  /** Scopes the code wants that the installation didn't grant. */
  readonly missing: readonly string[];
  /** Scopes the installation has but the code doesn't ask for (informational). */
  readonly extra: readonly string[];
  readonly ok: boolean;
}

function normalise(s: string): string {
  return s.trim().toLowerCase();
}

function uniqNonEmpty(list: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of list) {
    const n = normalise(s);
    if (n.length === 0 || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

export function diffScopes(
  requested: readonly string[],
  granted: readonly string[],
): ScopeDiff {
  const req = uniqNonEmpty(requested);
  const grant = uniqNonEmpty(granted);
  const grantSet = new Set(grant);
  const reqSet = new Set(req);
  const missing = req.filter((s) => !grantSet.has(s));
  const extra = grant.filter((s) => !reqSet.has(s));
  return {
    granted: grant,
    requested: req,
    missing,
    extra,
    ok: missing.length === 0,
  };
}
