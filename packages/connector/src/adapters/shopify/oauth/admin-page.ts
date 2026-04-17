// ---------------------------------------------------------------------------
// HTML renderer for /admin/shopify.
//
// Intentionally framework-free: one string template, inline CSS, no JS
// beyond small form submissions. Keeps the portal binary small and makes
// the page renderable on any connector without a build step.
// ---------------------------------------------------------------------------

import type { ShopInstallation, OAuthConfig } from "./types.js";
import { diffScopes, type ScopeDiff } from "./scope-diff.js";

export interface RenderAdminPageInput {
  readonly oauthConfig: OAuthConfig;
  /** Public URL of this connector, for building install/reinstall links. */
  readonly selfUrl: string;
  readonly installations: readonly ShopInstallation[];
  /** Passes through to embedded links so CTAs preserve the logged-in session. */
  readonly bearerToken: string;
  /** Clock for "installed X ago" rendering; ms since epoch. */
  readonly now: number;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatRelativeTime(ms: number, now: number): string {
  const deltaSec = Math.max(0, Math.floor((now - ms) / 1000));
  if (deltaSec < 60) return `${deltaSec}s ago`;
  if (deltaSec < 3600) return `${Math.floor(deltaSec / 60)}m ago`;
  if (deltaSec < 86400) return `${Math.floor(deltaSec / 3600)}h ago`;
  return `${Math.floor(deltaSec / 86400)}d ago`;
}

function reinstallUrl(selfUrl: string, shop: string): string {
  const base = selfUrl.replace(/\/+$/, "");
  return `${base}/auth/shopify/install?shop=${encodeURIComponent(shop)}`;
}

function renderScopeBadge(diff: ScopeDiff): string {
  if (diff.ok) {
    return `<span class="badge ok">scopes ok</span>`;
  }
  const missing = diff.missing.map(escapeHtml).join(", ");
  return `<span class="badge warn">needs ${diff.missing.length} more scope(s): ${missing}</span>`;
}

function renderStorefrontBadge(installation: ShopInstallation): string {
  return installation.storefrontToken
    ? `<span class="badge ok">storefront token ok</span>`
    : `<span class="badge warn">no storefront token</span>`;
}

function renderUninstalledBadge(installation: ShopInstallation): string {
  return installation.uninstalledAt
    ? `<span class="badge err">uninstalled</span>`
    : "";
}

function renderRow(
  installation: ShopInstallation,
  diff: ScopeDiff,
  selfUrl: string,
  bearer: string,
  now: number,
): string {
  const shop = escapeHtml(installation.shopDomain);
  const installedAgo = escapeHtml(formatRelativeTime(installation.installedAt, now));
  const scopesList = installation.scopes
    .map((s) => `<code>${escapeHtml(s)}</code>`)
    .join(" ");
  const reinstall = installation.uninstalledAt
    ? `<a class="btn primary" href="${escapeHtml(reinstallUrl(selfUrl, installation.shopDomain))}">Reinstall</a>`
    : diff.ok
      ? `<a class="btn muted" href="${escapeHtml(reinstallUrl(selfUrl, installation.shopDomain))}">Reinstall</a>`
      : `<a class="btn primary" href="${escapeHtml(reinstallUrl(selfUrl, installation.shopDomain))}">Reinstall to upgrade scopes</a>`;

  // The rotate form carries the bearer token along so the operator doesn't
  // get bounced back to a 401 on submit. We put it in a hidden field (sent
  // in form body) rather than a URL so it doesn't end up in access logs.
  const rotate = installation.uninstalledAt
    ? ""
    : `<form method="post" action="/admin/shopify/rotate-storefront" style="display:inline">
         <input type="hidden" name="shop" value="${shop}" />
         <input type="hidden" name="token" value="${escapeHtml(bearer)}" />
         <button class="btn" type="submit">Rotate storefront token</button>
       </form>`;

  return `<tr>
    <td><code>${shop}</code><br><small>${installedAgo}</small></td>
    <td>${renderUninstalledBadge(installation)} ${renderScopeBadge(diff)} ${renderStorefrontBadge(installation)}</td>
    <td>${scopesList}</td>
    <td>${reinstall} ${rotate}</td>
  </tr>`;
}

export function renderAdminShopifyPage(input: RenderAdminPageInput): string {
  const requested = input.oauthConfig.scopes;
  const rows = input.installations
    .map((inst) => renderRow(inst, diffScopes(requested, inst.scopes), input.selfUrl, input.bearerToken, input.now))
    .join("\n");

  const empty =
    input.installations.length === 0
      ? `<p>No installations yet. Visit <code>/auth/shopify/install?shop=&lt;your-shop&gt;.myshopify.com</code> to connect a store.</p>`
      : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>ACC \u2014 Shopify admin</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 960px; margin: 2rem auto; padding: 0 1rem; color: #111; }
  h1 { margin-bottom: .25rem; }
  table { border-collapse: collapse; width: 100%; margin-top: 1rem; }
  th, td { text-align: left; padding: .6rem .4rem; border-bottom: 1px solid #eee; vertical-align: top; }
  code { background: #f4f4f4; padding: 2px 6px; border-radius: 4px; font-size: .9em; }
  small { color: #666; }
  .badge { display: inline-block; font-size: .75em; padding: 2px 8px; border-radius: 999px; margin-right: 4px; }
  .badge.ok { background: #e6f4ea; color: #137333; }
  .badge.warn { background: #fff4e5; color: #b06000; }
  .badge.err { background: #fce8e6; color: #a50e0e; }
  .btn { display: inline-block; padding: .35rem .7rem; border-radius: 6px; border: 1px solid #ccc; background: #fff; color: #111; text-decoration: none; font-size: .85em; cursor: pointer; }
  .btn.primary { background: #1a73e8; color: #fff; border-color: #1a73e8; }
  .btn.muted { color: #666; border-color: #ddd; }
  form { margin: 0; }
</style>
</head>
<body>
  <h1>Shopify OAuth \u2014 admin</h1>
  <p><small>Requested scopes: ${requested.map((s) => `<code>${escapeHtml(s)}</code>`).join(" ")}</small></p>
  ${empty}
  ${
    input.installations.length > 0
      ? `<table>
           <thead><tr><th>Shop</th><th>Status</th><th>Granted scopes</th><th>Actions</th></tr></thead>
           <tbody>${rows}</tbody>
         </table>`
      : ""
  }
</body>
</html>`;
}
