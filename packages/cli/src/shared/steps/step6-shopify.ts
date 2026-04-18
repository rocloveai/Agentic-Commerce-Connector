// ---------------------------------------------------------------------------
// Step 6 — Shopify connection via shared-app pair flow.
//
// Merchant doesn't need a Partners account or custom app. Flow:
//   1. CLI POSTs <relay>/pair/new → gets pair_code + install_url + poll_url
//   2. CLI prints install URL, tries to auto-open merchant's browser
//   3. Merchant authorizes in Shopify admin → relay handles OAuth callback →
//      relay stores (admin_token, refresh_token, expires_at, scopes) keyed
//      by pair_code
//   4. CLI polls <relay>/pair/poll every 2s for up to ~10min
//   5. On success: CLI writes the installation to the merchant's local
//      SQLite installation-store (encrypted with merchant's enc.key) and
//      drops ACC_INSTALL_RELAY_URL into .env so the connector can later
//      refresh tokens by calling back to the relay.
//
// The merchant's server never sees the shared app's client_secret — that
// lives only on the relay. Token refresh also happens via the relay.
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";
import { upsertEnv } from "../env-writer.js";
import { openBrowser } from "../open-browser.js";
import type { StepContext, StepOutcome } from "./context.js";

const DEFAULT_RELAY = "https://install.xagenpay.com";
const POLL_INTERVAL_MS = 2000;
const DEFAULT_MAX_WAIT_MS = 10 * 60 * 1000; // 10 min

interface PairNewResponse {
  readonly pair_code: string;
  readonly install_url: string;
  readonly poll_url: string;
  readonly expires_in: number;
}

interface PairPollReady {
  readonly status: "ready";
  readonly shop: string;
  readonly admin_token: string;
  readonly storefront_token: string | null;
  readonly scopes: readonly string[];
  readonly token_expires_at: number | null;
  readonly refresh_token: string | null;
}

interface PairPollPending {
  readonly status: "pending";
  readonly expires_in: number;
}

interface PairPollDone {
  readonly status: "unknown" | "expired";
}

export async function stepShopify(ctx: StepContext): Promise<StepOutcome> {
  const relayUrl =
    (ctx.flags.get("install-relay") ?? DEFAULT_RELAY).replace(/\/+$/, "");

  // Non-interactive seed path (tests, `ACC_INIT_CONFIG` env, scripted
  // rebuilds): skip the relay round-trip when tokens are already known.
  // Useful for reproducing an install on a fresh machine without going
  // through a browser, and keeps wizard tests offline-clean.
  if (ctx.seed?.shopifyAdminToken && ctx.seed?.shopifyStoreUrl) {
    await writeInstallation(ctx, {
      status: "ready",
      shop: normaliseShopDomain(ctx.seed.shopifyStoreUrl),
      admin_token: ctx.seed.shopifyAdminToken,
      storefront_token: ctx.seed.shopifyStorefrontToken ?? null,
      scopes: ["read_products"],
      token_expires_at: null,
      refresh_token: null,
    });
    upsertEnv(ctx.layout.envPath, {
      SHOPIFY_STORE_URL: `https://${normaliseShopDomain(ctx.seed.shopifyStoreUrl)}`,
      ACC_INSTALL_RELAY_URL: relayUrl,
      SHOPIFY_CLIENT_ID: "relay-hosted",
      SHOPIFY_CLIENT_SECRET: "",
      SHOPIFY_ADMIN_TOKEN: ctx.seed.shopifyAdminToken,
      SHOPIFY_STOREFRONT_TOKEN: ctx.seed.shopifyStorefrontToken ?? "",
    });
    return {
      applied: true,
      summary: `Shopify installation seeded for ${ctx.seed.shopifyStoreUrl}`,
    };
  }

  ctx.ui.section("Connect your Shopify store");

  // 1. Ask for the shop domain up front. This gives the user a beat
  //    between "payout confirmed" and "browser opens", lets us embed the
  //    shop into the install URL so the relay skips its own form, and
  //    surfaces typos immediately instead of 30 seconds later in the
  //    browser.
  const shopDomain = await askShopDomain(ctx);

  // 2. Request a pair code from the relay, embed shop in the install URL.
  const pair = await createPair(relayUrl);
  const installUrlWithShop = appendShop(pair.install_url, shopDomain);

  // 3. Show the URL first, then wait for the user to press Enter before
  //    spawning the browser. Gives them a beat to copy-paste the URL
  //    manually (e.g. if installing ACC on a server over SSH and wanting
  //    to authorize from a laptop browser), and makes the "what happens
  //    next" step obvious rather than the page flashing by unannounced.
  ctx.ui.highlightUrl(installUrlWithShop);
  await ctx.prompter.pressEnterToContinue(
    `  Press ${ctx.ui.s.bold("Enter")} to authorize in Shopify ${ctx.ui.s.dim("(or Ctrl+C to abort)")}`,
  );

  const opened = await openBrowser(installUrlWithShop).catch(() => false);
  if (!opened) {
    ctx.ui.line(
      `  ${ctx.ui.s.yellow("⚠")}  ${ctx.ui.s.dim("Browser didn't open automatically — copy the URL above manually.")}`,
    );
  }

  // 4. Poll until tokens are ready, with a live countdown spinner.
  const ready = await pollForTokens(ctx, pair.poll_url, {
    intervalMs: POLL_INTERVAL_MS,
    maxWaitMs: Math.min(DEFAULT_MAX_WAIT_MS, pair.expires_in * 1000),
  });

  // 4. Persist to local installation-store (encrypted).
  await writeInstallation(ctx, ready);

  // 5. Record the relay URL in .env so the runtime connector can refresh
  //    tokens without asking the merchant again.
  upsertEnv(ctx.layout.envPath, {
    SHOPIFY_STORE_URL: `https://${ready.shop}`,
    ACC_INSTALL_RELAY_URL: relayUrl,
    // In shared-relay mode the merchant doesn't hold the Partners app's
    // client_secret — the relay does. We set these as empty placeholders
    // so the connector's config loader picks OAuth-only mode (any non-
    // empty SHOPIFY_CLIENT_ID triggers it); the local /auth/shopify/*
    // routes are never hit because the relay owns the OAuth callback.
    SHOPIFY_CLIENT_ID: "relay-hosted",
    SHOPIFY_CLIENT_SECRET: "",
  });

  const scopeNote = `${ready.scopes.length} scopes`;
  const refreshNote =
    ready.refresh_token && ready.token_expires_at !== null
      ? "auto-refresh on"
      : "token long-lived";
  ctx.ui.ok("Shopify connected", `${ready.shop}  ${ctx.ui.s.dim(`(${scopeNote} · ${refreshNote})`)}`);

  return {
    applied: true,
    summary: `Shopify installation bound via ${relayUrl} for ${ready.shop}`,
  };
}

/* -------------------------------------------------------------------------- */
/*  Relay HTTP                                                                 */
/* -------------------------------------------------------------------------- */

async function createPair(relayUrl: string): Promise<PairNewResponse> {
  const res = await fetch(`${relayUrl}/pair/new`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `[Shopify pair] relay at ${relayUrl} returned ${res.status}: ${body.slice(0, 200)}`,
    );
  }
  return (await res.json()) as PairNewResponse;
}

async function pollForTokens(
  ctx: StepContext,
  pollUrl: string,
  opts: { readonly intervalMs: number; readonly maxWaitMs: number },
): Promise<PairPollReady> {
  const deadline = Date.now() + opts.maxWaitMs;
  const spinner = ctx.ui.spinner(`waiting for you to authorize… ${formatMmSs(opts.maxWaitMs)} remaining`);

  try {
    while (Date.now() < deadline) {
      const res = await fetch(pollUrl);
      const body = (await res.json().catch(() => ({}))) as
        | PairPollReady
        | PairPollPending
        | PairPollDone;

      if (res.status === 200 && body.status === "ready") {
        spinner.clear();
        return body;
      }
      if (res.status === 404 || body.status === "unknown" || body.status === "expired") {
        spinner.fail("install link expired before you authorized");
        throw new Error(
          "[Shopify pair] pair code expired. Re-run `acc init` to get a fresh URL.",
        );
      }
      // Refresh spinner text with updated countdown.
      spinner.update(`waiting for you to authorize… ${formatMmSs(deadline - Date.now())} remaining`);
      await new Promise((r) => setTimeout(r, opts.intervalMs));
    }
    spinner.fail("timed out waiting for Shopify install");
    throw new Error(
      "[Shopify pair] timed out. Re-run `acc init` if you need more time.",
    );
  } catch (err) {
    // Ensure spinner is cleared even on unexpected throws.
    spinner.clear();
    throw err;
  }
}

function formatMmSs(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/* -------------------------------------------------------------------------- */
/*  Local installation-store persistence                                       */
/* -------------------------------------------------------------------------- */

/**
 * Strips scheme + trailing slashes from a user-provided shop URL and
 * returns just the host, e.g. "xstore-abc.myshopify.com".
 */
function normaliseShopDomain(raw: string): string {
  return raw
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
}

const SHOP_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i;

/**
 * Prompt for the merchant's Shopify shop domain. Accepts plain
 * "my-shop.myshopify.com" or a full URL and normalises either way.
 * Re-asks on malformed input so we never build a bad install URL.
 */
async function askShopDomain(ctx: StepContext): Promise<string> {
  const raw = await ctx.prompter.ask(
    "Shopify store domain (e.g. my-shop.myshopify.com)",
    {
      validate: (v) => {
        const normalised = normaliseShopDomain(v);
        if (SHOP_RE.test(normalised)) return null;
        return "must end in .myshopify.com";
      },
    },
  );
  return normaliseShopDomain(raw);
}

/**
 * Append `&shop=<domain>` to the install URL so the relay's /install-start
 * route skips its HTML shop-prompt and redirects straight to Shopify's
 * OAuth authorize page. The merchant types the shop once, in their
 * terminal.
 */
function appendShop(installUrl: string, shopDomain: string): string {
  const sep = installUrl.includes("?") ? "&" : "?";
  return `${installUrl}${sep}shop=${encodeURIComponent(shopDomain)}`;
}

async function writeInstallation(
  ctx: StepContext,
  ready: PairPollReady,
): Promise<void> {
  const { createSqliteInstallationStore } = await import(
    "@acc/connector/shopify-oauth"
  );

  const encryptionKey = readFileSync(ctx.layout.encKeyFile, "utf-8").trim();
  if (!/^[0-9a-f]{64}$/i.test(encryptionKey)) {
    throw new Error(
      `[Shopify pair] cannot persist installation: ${ctx.layout.encKeyFile} is not a 64-hex AES-256 key. Re-run 'acc init' step 4.`,
    );
  }

  const store = await createSqliteInstallationStore({
    dbPath: ctx.layout.dbFile,
    encryptionKey,
  });

  const now = Date.now();
  await store.save({
    shopDomain: ready.shop,
    adminToken: ready.admin_token,
    storefrontToken: ready.storefront_token,
    scopes: ready.scopes,
    installedAt: now,
    uninstalledAt: null,
    tokenExpiresAt: ready.token_expires_at,
    refreshToken: ready.refresh_token,
  });

  store.close();
}
