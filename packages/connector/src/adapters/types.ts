// ---------------------------------------------------------------------------
// Adapter interfaces — the contract every e-commerce platform must implement.
// ---------------------------------------------------------------------------

import type {
  CommerceProduct,
  CommerceVariant,
  ProductSearchResult,
  StoreMeta,
} from "../types/commerce.js";
import type { CheckoutSession } from "../types.js";

// ---------------------------------------------------------------------------
// CatalogAdapter — read-only product catalog operations
// Replaces the Shopify StorefrontClient interface.
// ---------------------------------------------------------------------------

export interface CatalogAdapter {
  readonly searchProducts: (
    query: string,
    first?: number,
    after?: string | null,
  ) => Promise<ProductSearchResult>;

  readonly listProducts: (
    first?: number,
    after?: string | null,
  ) => Promise<ProductSearchResult>;

  readonly getProduct: (handle: string) => Promise<CommerceProduct | null>;

  readonly getVariantPrices: (
    variantIds: readonly string[],
  ) => Promise<readonly CommerceVariant[]>;

  readonly getStoreMeta: () => Promise<StoreMeta>;
}

// ---------------------------------------------------------------------------
// MerchantAdapter — order management (create, update, cancel)
// Replaces the Shopify AdminClient interface.
// ---------------------------------------------------------------------------

export interface OrderCreateResult {
  readonly platformOrderId: string;
  readonly platformOrderName: string;
}

export interface OrderCreateOpts {
  readonly financialStatus?: "PENDING" | "PAID";
}

export interface MerchantAdapter {
  readonly createOrder: (
    session: CheckoutSession,
    opts?: OrderCreateOpts,
  ) => Promise<OrderCreateResult>;

  readonly markOrderPaid: (
    platformOrderId: string,
    txHash: string,
  ) => Promise<void>;

  readonly cancelOrder: (
    platformOrderId: string,
    reason?: string,
  ) => Promise<void>;

  readonly hasExistingOrder: (sessionId: string) => Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Adapter factory — returned by each platform's createXxxAdapters() function
// ---------------------------------------------------------------------------

export interface AdapterPair {
  readonly catalog: CatalogAdapter;
  readonly merchant: MerchantAdapter | null;
}
