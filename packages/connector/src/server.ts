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
  registerUcpDepsResolver,
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
import { createOauthUcpResolver } from "./adapters/shopify/oauth/ucp-binding.js";
import type { OAuthConfig } from "./adapters/shopify/oauth/types.js";
import type { ProductCache } from "./adapters/shopify/product-cache.js";
import {
  createWooCommerceAdapters,
  validateWooConfig,
} from "./adapters/woocommerce/index.js";
import type { CommerceProduct, StoreMeta, WebhookPayload } from "./types.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { CartTokenConfig } from "./ucp/cart-token.js";
import { createHmac } from "node:crypto";

// ---------------------------------------------------------------------------
// Cart-token secret loader with fallback derivation.
//
// `acc init` doesn't prompt the merchant for UCP_CART_TOKEN_SECRET because
// a merchant self-deploying ACC has no reason to pick one manually. This
// helper derives a stable 64-hex-char secret from ACC_ENCRYPTION_KEY using
// HMAC with a fixed domain-separation label, so existing installations and
// fresh `acc init` installs Just Work without adding a new env var.
//
// A manually-set UCP_CART_TOKEN_SECRET still wins (operators pinning their
// own value for cross-instance token verification, key rotation schedules,
// etc.). This fallback is specifically for the single-instance wizard path.
// ---------------------------------------------------------------------------
function loadCartTokenConfigWithFallback(
  env: Record<string, string | undefined>,
  encryptionKey: string,
): CartTokenConfig {
  const envSecret = env.UCP_CART_TOKEN_SECRET;
  if (envSecret && envSecret.length >= 32) {
    return loadCartTokenConfig(env);
  }
  if (!encryptionKey || encryptionKey.length < 32) {
    throw new Error(
      "[UCP] Cannot derive cart-token secret: ACC_ENCRYPTION_KEY is missing or too short. Either set UCP_CART_TOKEN_SECRET (openssl rand -hex 32) or re-run `acc init` to generate an encryption key.",
    );
  }
  const derived = createHmac("sha256", encryptionKey)
    .update("acc:ucp-cart-token:v1")
    .digest("hex");
  const ttlRaw = env.UCP_TOKEN_TTL_SECONDS;
  const ttlSeconds = ttlRaw ? parseInt(ttlRaw, 10) : undefined;
  if (ttlSeconds !== undefined && (isNaN(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 86400)) {
    throw new Error("[UCP] UCP_TOKEN_TTL_SECONDS must be between 60 and 86400");
  }
  return { secret: derived, ttlSeconds };
}

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
// Public entry — callers (CLI `acc start`, direct `node build/server.js`)
// invoke this with env already populated. No top-level side effects.
// ---------------------------------------------------------------------------

export interface StartServerOptions {
  /** Transport mode. Defaults to env TRANSPORT or "stdio". */
  readonly transport?: "stdio" | "http";
}

export async function startServer(opts: StartServerOptions = {}): Promise<void> {
  const config = loadConfig();
  const transportMode = opts.transport ?? process.env.TRANSPORT ?? "stdio";

  const isOAuthOnly = config.platform === "shopify" && config.mode === "oauth";

  const ORDER_PREFIX_MAP: Record<string, string> = {
    shopify: "SHP",
    woocommerce: "WOO",
  };
  setOrderPrefix(ORDER_PREFIX_MAP[config.platform] ?? "ORD");

  if (config.databaseUrl) {
    initPool(config.databaseUrl);
  } else {
    console.error("Warning: DATABASE_URL not set. Using in-memory storage only.");
  }

  const adapters: Adapters = isOAuthOnly
    ? ({
        catalog: null as unknown as CatalogAdapter,
        merchant: null as MerchantAdapter | null,
        productCache: createProductCache(),
      } as Adapters)
    : createAdaptersForConfig(config);
  const { catalog, merchant, productCache } = adapters;

  if (!isOAuthOnly) {
    startReconciler({
      nexusCoreUrl: config.nexusCoreUrl,
      merchantDid: config.merchantDid,
    });
  }

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

  let storeMetaCache: StoreMeta | null = null;
  async function getStoreMeta(): Promise<StoreMeta> {
    if (storeMetaCache) return storeMetaCache;
    storeMetaCache = await catalog.getStoreMeta();
    setTimeout(
      () => {
        storeMetaCache = null;
      },
      30 * 60 * 1000,
    );
    return storeMetaCache;
  }

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
    const result = query
      ? await catalog.searchProducts(query, first, after ?? null)
      : await catalog.listProducts(first, after ?? null);

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
    const cached = productCache.get(handle);
    if (cached) {
      return { text: formatProduct(cached), data: cached };
    }

    const product = await catalog.getProduct(handle);
    if (!product) {
      return { text: `Product "${handle}" not found.`, data: null };
    }

    productCache.set(handle, product);
    return { text: formatProduct(product), data: product };
  }

  function createMcpServer(): McpServer {
    const srv = new McpServer({ name: "commerce-agent", version: "0.1.0" });

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
          return { content: [{ type: "text" as const, text: result.text }] };
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: "text" as const, text: `Error: ${message}` }],
            isError: true,
          };
        }
      },
    );

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
          return { content: [{ type: "text" as const, text: result.text }] };
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: "text" as const, text: `Error: ${message}` }],
            isError: true,
          };
        }
      },
    );

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

  async function startStdioMode(): Promise<void> {
    startPortal(config);
    const server = createMcpServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(
      `Commerce Agent MCP Server started (stdio, platform=${config.platform})`,
    );
  }

  async function startHttpModeOAuthOnly(): Promise<void> {
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

    // UCP: resolve adapter pair lazily from whichever installation is active.
    // Before any merchant installs, UCP returns 409 with the install URL; after
    // install the resolver caches per (shopDomain, installedAt).
    //
    // `acc init` doesn't prompt for UCP_CART_TOKEN_SECRET, so OAuth-only mode
    // falls back to deriving a stable 64-hex-char secret from
    // ACC_ENCRYPTION_KEY (already generated by init, 32 random bytes). HMAC
    // with a fixed label keeps the derivation deterministic across restarts
    // but domain-separated from any other use of the encryption key. Manual
    // UCP_CART_TOKEN_SECRET still wins if operator set it explicitly.
    const cartTokenConfig = loadCartTokenConfigWithFallback(
      process.env,
      config.accEncryptionKey,
    );
    const nexusPaymentConfig = loadNexusPaymentConfig(process.env);
    const paymentProvider = createNexusPaymentProvider(
      nexusPaymentConfig,
      config.merchantDid,
    );
    const paymentHandlers: UcpPaymentHandlerT[] = [paymentProvider.describe()];
    const ucpEndpoint = `${selfUrl.replace(/\/+$/, "")}/ucp/v1`;
    const installUrl = oauthConfig.redirectUri.replace("/callback", "/install");
    const ucpResolver = createOauthUcpResolver({
      config,
      installationStore: storage.store,
      apiVersion: oauthConfig.apiVersion,
      ucpEndpoint,
      cartTokenConfig,
      paymentHandlers,
      // Shared-app install relay used to refresh expiring admin tokens. When
      // ACC is installed via `install.xagenpay.com`, the merchant server
      // doesn't hold client_secret — the relay does, and refreshes on our
      // behalf. Set `ACC_INSTALL_RELAY_URL` in env to override; empty string
      // or unset disables auto-refresh (legacy non-expiring or Custom-App
      // mode where the operator plugs in their own refresh mechanism).
      relayUrl:
        (process.env.ACC_INSTALL_RELAY_URL ?? "https://install.xagenpay.com")
          .trim() || null,
    });
    registerUcpDepsResolver(async () => {
      const result = await ucpResolver();
      if (result.kind === "no-installation") {
        return {
          kind: "no-installation",
          installHint: `${installUrl}?shop=<your-shop>.myshopify.com`,
        };
      }
      return { kind: "ready", deps: result.deps, shopDomain: result.shopDomain };
    });

    startPortal(config);
    console.error(
      `Commerce Agent started (HTTP, OAuth-only, port ${config.portalPort})`,
    );
    console.error(`  Storage:  ${storage.describe}`);
    console.error(`  Install:  ${installUrl}?shop=<your-shop>.myshopify.com`);
    console.error(
      `  Status:   http://localhost:${config.portalPort}/admin/shopify/installed`,
    );
    console.error(`  UCP:      ${ucpEndpoint}/discovery  (409 until install completes)`);
  }

  async function startHttpMode(): Promise<void> {
    if (isOAuthOnly) {
      await startHttpModeOAuthOnly();
      return;
    }

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

    const cartTokenConfig = loadCartTokenConfigWithFallback(
      process.env,
      config.accEncryptionKey,
    );
    const selfUrl = config.selfUrl || `http://localhost:${config.portalPort}`;

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

    registerWithNexusCore().catch(() => {});
  }

  process.on("SIGTERM", () => {
    stopReconciler();
    closePool().catch(() => {});
  });

  if (transportMode === "http") {
    await startHttpMode();
  } else {
    await startStdioMode();
  }
}

// ---------------------------------------------------------------------------
// Direct-execution entry point. Used by `node build/server.js` and by the
// compiled binary when invoked without `acc start`. The CLI `acc start` calls
// startServer() directly so there is no subprocess boundary.
// ---------------------------------------------------------------------------

const invokedDirectly =
  typeof process !== "undefined" &&
  process.argv[1] &&
  /server\.(js|ts)$/.test(process.argv[1]);

if (invokedDirectly) {
  startServer().catch((err) => {
    console.error("Failed to start Commerce Agent:", err);
    process.exit(1);
  });
}
