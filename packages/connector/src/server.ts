#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { loadConfig } from "./config.js";
import type { Config } from "./config.js";
import { initPool, closePool } from "./services/db/pool.js";
import {
  startPortal,
  registerMcpHandler,
  registerRestHandlers,
  registerWebhookHandler,
  registerUcpDeps,
  registerShopifyOAuthRouter,
  registerShopifyWebhookRouter,
} from "./portal.js";
import { loadCartTokenConfig } from "./ucp/cart-token.js";
import type { UcpPaymentHandlerT } from "./ucp/types.js";
import {
  createNexusPaymentProvider,
  loadNexusPaymentConfig,
} from "./payment/nexus/index.js";
import {
  verifyWebhookSignature,
  handleWebhookEvent,
} from "./services/webhook-handler.js";
import { startReconciler, stopReconciler } from "./services/reconciler.js";
import {
  createCheckoutSession,
  getCheckoutStatus,
} from "./services/checkout-session.js";
import { setOrderPrefix } from "./services/order-store.js";
import type { CatalogAdapter, MerchantAdapter } from "./adapters/types.js";
import {
  createShopifyAdapters,
  createProductCache,
  validateShopifyConfig,
} from "./adapters/shopify/index.js";
import { createInMemoryStateStore } from "./adapters/shopify/oauth/state.js";
import { selectInstallationStore } from "./adapters/shopify/oauth/installation-store-factory.js";
import { createShopifyOAuthRouter } from "./adapters/shopify/oauth/routes.js";
import { createShopifyWebhookRouter } from "./adapters/shopify/oauth/webhook-handler.js";
import type { OAuthConfig } from "./adapters/shopify/oauth/types.js";
import type { ProductCache } from "./adapters/shopify/product-cache.js";
import {
  createWooCommerceAdapters,
  validateWooConfig,
} from "./adapters/woocommerce/index.js";
import type { CommerceProduct, StoreMeta, WebhookPayload } from "./types.js";
import type { IncomingMessage, ServerResponse } from "node:http";

// ---------------------------------------------------------------------------
// Adapter factory — creates the right adapters based on config.platform
// ---------------------------------------------------------------------------

interface Adapters {
  readonly catalog: CatalogAdapter;
  readonly merchant: MerchantAdapter | null;
  readonly productCache: ProductCache;
}

function createAdaptersForConfig(config: Config): Adapters {
  switch (config.platform) {
    case "shopify": {
      // OAuth-mode credentials are minted at install time and persisted
      // separately (see docs/plans/2026-04-16-shopify-oauth-design.md). Until
      // Phase 3 of that rollout plumbs the DB-backed installation into the
      // adapter factory, refuse to start so the operator gets a clear signal.
      if (config.mode === "oauth") {
        throw new Error(
          "[Adapters/Shopify] OAuth mode is configured (SHOPIFY_CLIENT_ID is set) but the adapter layer has not been wired to read installations from storage yet. This is Phase 3 of the Shopify OAuth rollout. To use the connector today, unset SHOPIFY_CLIENT_ID and provide SHOPIFY_STOREFRONT_TOKEN + SHOPIFY_ADMIN_TOKEN (manual mode).",
        );
      }
      const shopifyConfig = validateShopifyConfig({
        SHOPIFY_STORE_URL: config.shopifyStoreUrl,
        SHOPIFY_STOREFRONT_TOKEN: config.shopifyStorefrontToken,
        SHOPIFY_ADMIN_TOKEN: config.shopifyAdminToken,
        SHOPIFY_API_VERSION: config.shopifyApiVersion,
      });

      const { catalog, merchant } = createShopifyAdapters(shopifyConfig);
      return { catalog, merchant, productCache: createProductCache() };
    }
    case "woocommerce": {
      const wooConfig = validateWooConfig({
        WOO_BASE_URL: config.wooBaseUrl,
        WOO_CONSUMER_KEY: config.wooConsumerKey,
        WOO_CONSUMER_SECRET: config.wooConsumerSecret,
        WOO_API_VERSION: process.env.WOO_API_VERSION,
        WOO_REQUEST_TIMEOUT_MS: process.env.WOO_REQUEST_TIMEOUT_MS,
        WOO_MAX_RETRIES: process.env.WOO_MAX_RETRIES,
      });
      const { catalog, merchant } = createWooCommerceAdapters(wooConfig);
      return { catalog, merchant, productCache: createProductCache() };
    }
    default:
      throw new Error(
        `Adapter not yet implemented for platform: ${(config as { platform: string }).platform}`,
      );
  }
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

const config = loadConfig();
const transportMode = process.env.TRANSPORT ?? "stdio";

// Shopify OAuth mode defers adapter construction until an installation exists
// (see docs/plans/2026-04-16-shopify-oauth-design.md). In this state we boot
// a minimal portal that can accept the install flow, and short-circuit every
// adapter-dependent subsystem.
const isOAuthOnly = config.platform === "shopify" && config.mode === "oauth";

// Set order prefix based on platform
const ORDER_PREFIX_MAP: Record<string, string> = {
  shopify: "SHP",
  woocommerce: "WOO",
};
setOrderPrefix(ORDER_PREFIX_MAP[config.platform] ?? "ORD");

// Initialize DB pool if DATABASE_URL is set
if (config.databaseUrl) {
  initPool(config.databaseUrl);
} else {
  console.error("Warning: DATABASE_URL not set. Using in-memory storage only.");
}

// Create adapters via factory — in OAuth-only mode we skip this: no credentials
// exist yet. Downstream handlers that touch `catalog` / `merchant` are never
// registered in this mode, so the null values never get read at runtime.
// Phase 5 of the OAuth rollout replaces this shim with a real lookup against
// the installation store.
const adapters = isOAuthOnly
  ? ({
      catalog: null as unknown as CatalogAdapter,
      merchant: null as MerchantAdapter | null,
      productCache: createProductCache(),
    } as Adapters)
  : createAdaptersForConfig(config);
const { catalog, merchant, productCache } = adapters;

// Reconciler — no work to do until an adapter exists.
if (!isOAuthOnly) {
  startReconciler({
    nexusCoreUrl: config.nexusCoreUrl,
    merchantDid: config.merchantDid,
  });
}

// Register webhook handler
registerWebhookHandler(async (_config, rawBody, sig, ts) => {
  const result = verifyWebhookSignature(
    _config.webhookSecret,
    rawBody,
    sig,
    ts,
  );
  if (!result.valid) {
    console.error(`[Webhook] Rejected: ${result.reason}`);
    throw new Error(`Unauthorized: ${result.reason}`);
  }

  const payload = JSON.parse(rawBody) as WebhookPayload;
  return handleWebhookEvent(payload, {
    nexusCoreUrl: _config.nexusCoreUrl,
    merchantDid: _config.merchantDid,
    merchant: merchant ?? undefined,
  });
});

// Store metadata cache (single value, long TTL)
let storeMetaCache: StoreMeta | null = null;

async function getStoreMeta(): Promise<StoreMeta> {
  if (storeMetaCache) return storeMetaCache;
  storeMetaCache = await catalog.getStoreMeta();
  // Refresh after 30 minutes
  setTimeout(
    () => {
      storeMetaCache = null;
    },
    30 * 60 * 1000,
  );
  return storeMetaCache;
}

// ── Tool Implementations ─────────────────────────────────────────────────────

function formatProduct(p: CommerceProduct): string {
  const price =
    p.priceRange.min.amount === p.priceRange.max.amount
      ? `${p.priceRange.min.amount} ${p.priceRange.min.currencyCode}`
      : `${p.priceRange.min.amount}–${p.priceRange.max.amount} ${p.priceRange.min.currencyCode}`;

  const variants = p.variants
    .map(
      (v) =>
        `  - ${v.title}: ${v.price.amount} ${v.price.currencyCode}${v.availableForSale ? "" : " (sold out)"}` +
        `\n    ID: ${v.id}`,
    )
    .join("\n");

  return (
    `**${p.title}** (${price})\n` +
    `Handle: ${p.handle}\n` +
    `${p.description.slice(0, 200)}${p.description.length > 200 ? "..." : ""}\n` +
    `Variants:\n${variants}`
  );
}

async function handleSearchProducts({
  query,
  first,
  after,
}: {
  query: string;
  first: number;
  after?: string | null;
}): Promise<{ text: string; data: unknown }> {
  // Use listProducts when no search query is provided (browse all)
  const result = query
    ? await catalog.searchProducts(query, first, after ?? null)
    : await catalog.listProducts(first, after ?? null);

  // Cache products by handle
  for (const p of result.products) {
    productCache.set(p.handle, p);
  }

  if (result.products.length === 0) {
    return {
      text: query
        ? `No products found for "${query}".`
        : "No products available in the store.",
      data: result,
    };
  }

  const lines = result.products.map((p, i) => `${i + 1}. ${formatProduct(p)}`);
  const pageNote = result.pageInfo.hasNextPage
    ? `\n\n_More results available. Use after: "${result.pageInfo.endCursor}" to load next page._`
    : "";

  return {
    text: `Found ${result.products.length} products:\n\n${lines.join("\n\n")}${pageNote}`,
    data: result,
  };
}

async function handleGetProduct({
  handle,
}: {
  handle: string;
}): Promise<{ text: string; data: unknown }> {
  // Check cache first
  const cached = productCache.get(handle);
  if (cached) {
    return {
      text: formatProduct(cached),
      data: cached,
    };
  }

  const product = await catalog.getProduct(handle);
  if (!product) {
    return {
      text: `Product "${handle}" not found.`,
      data: null,
    };
  }

  productCache.set(handle, product);

  return {
    text: formatProduct(product),
    data: product,
  };
}

// ── McpServer factory ────────────────────────────────────────────────────────

function createMcpServer(): McpServer {
  const srv = new McpServer({
    name: "commerce-agent",
    version: "0.1.0",
  });

  // ── Tool: search_products ──────────────────────────────────────────────────

  srv.tool(
    "search_products",
    "Search products in the store. Returns product names, prices, variant IDs, and availability.",
    {
      query: z
        .string()
        .default("")
        .describe(
          "Search query (e.g. 'snowboard', 'gift card'). Leave empty to browse all products.",
        ),
      first: z
        .number()
        .int()
        .min(1)
        .max(50)
        .default(10)
        .describe("Number of results to return (1-50, default 10)"),
      after: z
        .string()
        .optional()
        .describe("Pagination cursor from previous search results"),
    },
    async ({ query, first, after }) => {
      try {
        const result = await handleSearchProducts({ query, first, after });
        return {
          content: [{ type: "text" as const, text: result.text }],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          isError: true,
        };
      }
    },
  );

  // ── Tool: get_product ──────────────────────────────────────────────────────

  srv.tool(
    "get_product",
    "Get detailed product information by handle. Returns all variants with prices and availability.",
    {
      handle: z
        .string()
        .describe(
          "Product handle (URL slug, e.g. 'the-collection-snowboard-hydrogen')",
        ),
    },
    async ({ handle }) => {
      try {
        const result = await handleGetProduct({ handle });
        return {
          content: [{ type: "text" as const, text: result.text }],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          isError: true,
        };
      }
    },
  );

  // ── Tool: create_checkout ────────────────────────────────────────────────

  srv.tool(
    "create_checkout",
    "Create a checkout session for selected products. Converts fiat prices to stablecoin, signs a quote, and returns a checkout URL for payment.",
    {
      items: z
        .array(
          z.object({
            variant_id: z
              .string()
              .describe("Product variant ID from the platform"),
            quantity: z
              .number()
              .int()
              .min(1)
              .max(99)
              .describe("Quantity to purchase"),
          }),
        )
        .min(1)
        .describe("Array of items to checkout"),
      buyer_email: z
        .string()
        .email()
        .optional()
        .describe("Buyer's email for order notifications"),
      payer_wallet: z
        .string()
        .regex(/^0x[a-fA-F0-9]{40}$/)
        .optional()
        .describe(
          "Payer's EVM wallet address (0x...). Optional — if omitted, any wallet can pay.",
        ),
      shipping_address: z
        .object({
          first_name: z.string().describe("Recipient first name"),
          last_name: z.string().describe("Recipient last name"),
          address1: z.string().describe("Street address line 1"),
          address2: z.string().optional().describe("Street address line 2"),
          city: z.string().describe("City"),
          province: z.string().optional().describe("State/province"),
          country: z.string().describe("Country (e.g. 'Singapore', 'US')"),
          zip: z.string().describe("Postal/ZIP code"),
          phone: z.string().optional().describe("Phone number"),
        })
        .optional()
        .describe(
          "Shipping address for physical products. Required for items that need delivery.",
        ),
    },
    async ({ items, buyer_email, payer_wallet, shipping_address }) => {
      try {
        const result = await createCheckoutSession(
          {
            items,
            buyerEmail: buyer_email,
            payerWallet: payer_wallet,
            shippingAddress: shipping_address,
          },
          catalog,
          config,
          merchant,
        );
        const s = result.session;
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Checkout session created!\n\n` +
                `Session: ${s.id}\n` +
                `Items: ${s.line_items.map((li) => `${li.title} x${li.quantity}`).join(", ")}\n` +
                `Subtotal: ${s.subtotal} ${s.currency}\n` +
                `Token Amount: ${s.token_amount} ${config.paymentCurrency} (rate: ${s.rate})\n` +
                `Order Ref: ${s.order_ref}\n` +
                (s.platform_order_name
                  ? `Platform Order: ${s.platform_order_name} (pending payment)\n`
                  : "") +
                `\n**Payment Link:** ${result.checkout_url}\n\n` +
                `Direct the user to this URL to complete payment.`,
            },
          ],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          isError: true,
        };
      }
    },
  );

  // ── Tool: check_checkout_status ────────────────────────────────────────────

  srv.tool(
    "check_checkout_status",
    "Check the status of a checkout session. Returns payment state and order info if completed.",
    {
      session_id: z.string().describe("The session ID (e.g. 'cs_...')"),
    },
    async ({ session_id }) => {
      try {
        const session = await getCheckoutStatus(session_id);
        if (!session) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Session "${session_id}" not found.`,
              },
            ],
            isError: true,
          };
        }

        const lines = [
          `Session: ${session.id}`,
          `Status: ${session.status}`,
          `Items: ${session.line_items.map((li) => `${li.title} x${li.quantity}`).join(", ")}`,
          `Subtotal: ${session.subtotal} ${session.currency}`,
          `Token: ${session.token_amount ?? "pending"} ${config.paymentCurrency}`,
          `Order Ref: ${session.order_ref ?? "n/a"}`,
        ];

        if (session.platform_order_name) {
          lines.push(`Platform Order: ${session.platform_order_name}`);
        }
        if (session.tx_hash) {
          lines.push(`Tx Hash: ${session.tx_hash}`);
        }
        if (session.completed_at) {
          lines.push(`Completed: ${session.completed_at}`);
        }

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          isError: true,
        };
      }
    },
  );

  // ── Resource: store-info ────────────────────────────────────────────────────

  srv.resource(
    "store-info",
    "commerce://store-info",
    { description: "Store metadata (name, currency, domain)" },
    async (uri) => {
      const meta = await getStoreMeta();
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(meta, null, 2),
          },
        ],
      };
    },
  );

  return srv;
}

// ── Start server ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (transportMode === "http") {
    await startHttpMode();
  } else {
    await startStdioMode();
  }
}

async function startStdioMode(): Promise<void> {
  startPortal(config);
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `Commerce Agent MCP Server started (stdio, platform=${config.platform})`,
  );
}

// ── Self-registration with nexus-core ────────────────────────────────────────

async function registerWithNexusCore(): Promise<void> {
  try {
    const { privateKeyToAccount } = await import("viem/accounts");
    const { keccak256, toHex } = await import("viem");

    const account = privateKeyToAccount(
      config.signerPrivateKey as `0x${string}`,
    );

    const body = {
      merchant_did: config.merchantDid,
      name: "Commerce Agent",
      description:
        "Commerce agent — search products, create checkout sessions, verify payments",
      category: "commerce",
      signer_address: account.address,
      payment_address: config.paymentAddress,
      skill_md_url: `${config.selfUrl}/skill.md`,
      health_url: `${config.selfUrl}/health`,
      webhook_url: `${config.selfUrl}/webhook`,
      webhook_secret: config.webhookSecret,
    };

    const bodyStr = JSON.stringify(body);
    const path = "/api/market/register";
    const method = "POST";

    // EIP-712 NexusRequest signing (same domain/types as nexus-core request-auth)
    const bodyHash = keccak256(toHex(bodyStr));
    const timestamp = BigInt(Math.floor(Date.now() / 1000));
    const nonceBytes = new Uint8Array(32);
    crypto.getRandomValues(nonceBytes);
    const nonce = ("0x" +
      Array.from(nonceBytes)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("")) as `0x${string}`;

    const signature = await account.signTypedData({
      domain: {
        name: "NexusPay",
        version: "1",
        chainId: 20250407,
        verifyingContract:
          "0x0000000000000000000000000000000000000000" as `0x${string}`,
      },
      types: {
        NexusRequest: [
          { name: "method", type: "string" },
          { name: "path", type: "string" },
          { name: "body_hash", type: "bytes32" },
          { name: "timestamp", type: "uint256" },
          { name: "nonce", type: "bytes32" },
        ],
      },
      primaryType: "NexusRequest",
      message: { method, path, body_hash: bodyHash, timestamp, nonce },
    });

    const res = await fetch(`${config.nexusCoreUrl}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        "x-nexus-signature": signature,
        "x-nexus-signer": account.address,
        "x-nexus-timestamp": timestamp.toString(),
        "x-nexus-nonce": nonce,
      },
      body: bodyStr,
    });

    const text = await res.text();
    console.error(`[Register] ${res.status}: ${text.slice(0, 200)}`);
  } catch (err) {
    console.error("[Register] Failed (non-fatal):", err);
  }
}

function buildOAuthConfigFromEnv(): OAuthConfig {
  if (config.platform !== "shopify" || config.mode !== "oauth") {
    throw new Error(
      "[Server] buildOAuthConfigFromEnv called outside Shopify OAuth mode.",
    );
  }
  const selfUrl = config.selfUrl || `http://localhost:${config.portalPort}`;
  const derivedRedirect =
    config.shopifyOAuthRedirect ||
    `${selfUrl.replace(/\/+$/, "")}/auth/shopify/callback`;
  return {
    clientId: config.shopifyClientId,
    clientSecret: config.shopifyClientSecret,
    scopes: config.shopifyOAuthScopes,
    redirectUri: derivedRedirect,
    apiVersion: config.shopifyApiVersion,
  };
}

async function startHttpModeOAuthOnly(): Promise<void> {
  // Minimal boot: only the OAuth install/callback/status routes + /health +
  // dashboard. No UCP, no MCP, no REST — those all need an adapter that
  // Phase 5 will plumb through the installation store.
  const oauthConfig = buildOAuthConfigFromEnv();
  const selfUrl = config.selfUrl || `http://localhost:${config.portalPort}`;
  const stateStore = createInMemoryStateStore();
  const storage = await selectInstallationStore({
    encryptionKey: config.accEncryptionKey,
    databaseUrl: config.databaseUrl,
    dataDir: process.env.ACC_DATA_DIR ?? "./acc-data",
  });
  const router = createShopifyOAuthRouter({
    oauthConfig,
    stateStore,
    installationStore: storage.store,
    selfUrl,
    adminBearer: config.portalToken,
  });
  registerShopifyOAuthRouter(router);
  if (!config.portalToken) {
    console.error(
      "[Server] PORTAL_TOKEN is not set — /admin/shopify will return 503 until you set it.",
    );
  }

  const webhookRouter = createShopifyWebhookRouter({
    oauthConfig,
    installationStore: storage.store,
  });
  registerShopifyWebhookRouter(webhookRouter);

  startPortal(config);
  console.error(
    `Commerce Agent started (HTTP, OAuth-only, port ${config.portalPort})`,
  );
  console.error(`  Storage:  ${storage.describe}`);
  console.error(
    `  Install:  ${oauthConfig.redirectUri.replace("/callback", "/install")}?shop=<your-shop>.myshopify.com`,
  );
  console.error(
    `  Status:   http://localhost:${config.portalPort}/admin/shopify/installed`,
  );
  console.error(
    "  (UCP / MCP / REST are disabled until Phase 5 wires adapters to the installation store.)",
  );
}

async function startHttpMode(): Promise<void> {
  if (isOAuthOnly) {
    await startHttpModeOAuthOnly();
    return;
  }

  // Register REST API handlers (primary interface)
  registerRestHandlers({
    searchProducts: handleSearchProducts,
    getProduct: handleGetProduct,
    createCheckout: async (args) => {
      const result = await createCheckoutSession(
        {
          items: [...args.items],
          buyerEmail: args.buyer_email,
          payerWallet: args.payer_wallet,
          shippingAddress: args.shipping_address,
        },
        catalog,
        config,
        merchant,
      );
      return { session: result.session, checkout_url: result.checkout_url };
    },
    getCheckoutStatus,
  });

  // Register MCP handler (alternative interface)
  registerMcpHandler(
    async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      const server = createMcpServer();
      await server.connect(transport);
      await transport.handleRequest(req, res);
      await server.close();
      return true;
    },
  );

  // Register UCP/1.0 façade
  const cartTokenConfig = loadCartTokenConfig(process.env);
  const selfUrl = config.selfUrl || `http://localhost:${config.portalPort}`;

  // Payment provider (NUPS/1.5 Nexus) — surfaces itself to UCP discovery
  const nexusPaymentConfig = loadNexusPaymentConfig(process.env);
  const paymentProvider = createNexusPaymentProvider(
    nexusPaymentConfig,
    config.merchantDid,
  );
  const paymentHandlers: UcpPaymentHandlerT[] = [paymentProvider.describe()];
  registerUcpDeps({
    config,
    catalog,
    merchant,
    cartTokenConfig,
    paymentHandlers,
    ucpEndpoint: `${selfUrl}/ucp/v1`,
  });

  startPortal(config);
  console.error(
    `Commerce Agent started (HTTP, platform=${config.platform}, port ${config.portalPort})`,
  );
  console.error(`  UCP:   http://localhost:${config.portalPort}/ucp/v1/`);
  console.error(
    `  API:   http://localhost:${config.portalPort}/api/v1/ (legacy)`,
  );
  console.error(`  MCP:   http://localhost:${config.portalPort}/mcp`);
  console.error(`  Skill: http://localhost:${config.portalPort}/skill.md`);

  // Fire-and-forget self-registration with nexus-core
  registerWithNexusCore().catch(() => {});
}

process.on("SIGTERM", () => {
  stopReconciler();
  closePool().catch(() => {});
});

main().catch((err) => {
  console.error("Failed to start Commerce Agent:", err);
  process.exit(1);
});
