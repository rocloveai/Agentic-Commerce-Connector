// ---------------------------------------------------------------------------
// Platform-agnostic commerce types
//
// All e-commerce adapters normalize their data into these shapes.
// Names are deliberately NOT platform-specific (no "Shopify", "Woo", etc.).
// ---------------------------------------------------------------------------

export interface CommerceImage {
  readonly url: string;
  readonly altText: string | null;
}

export interface CommerceVariant {
  readonly id: string;
  readonly title: string;
  readonly price: { readonly amount: string; readonly currencyCode: string };
  readonly availableForSale: boolean;
  readonly selectedOptions: readonly {
    readonly name: string;
    readonly value: string;
  }[];
  readonly sku?: string | null;
  readonly inventoryQuantity?: number | null;
}

export interface CommerceProduct {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly handle: string;
  readonly images: readonly CommerceImage[];
  readonly variants: readonly CommerceVariant[];
  readonly priceRange: {
    readonly min: { readonly amount: string; readonly currencyCode: string };
    readonly max: { readonly amount: string; readonly currencyCode: string };
  };
  readonly brand?: string | null;
}

export interface ProductSearchResult {
  readonly products: readonly CommerceProduct[];
  readonly pageInfo: {
    readonly hasNextPage: boolean;
    readonly endCursor: string | null;
  };
}

export interface StoreMeta {
  readonly name: string;
  readonly primaryDomainUrl: string;
  readonly currencyCode: string;
}
