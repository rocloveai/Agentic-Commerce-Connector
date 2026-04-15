import type {
  CommerceProduct,
  CommerceVariant,
  ProductSearchResult,
  StoreMeta,
} from "../../types/commerce.js";
import type { CatalogAdapter } from "../types.js";
import type { ShopifyPlatformConfig } from "./config.js";

// ---------------------------------------------------------------------------
// GraphQL fragments
// ---------------------------------------------------------------------------

const PRODUCT_FIELDS = `
  id
  title
  description
  handle
  vendor
  images(first: 3) {
    edges { node { url altText } }
  }
  variants(first: 10) {
    edges {
      node {
        id
        title
        sku
        quantityAvailable
        price { amount currencyCode }
        availableForSale
        selectedOptions { name value }
      }
    }
  }
  priceRange {
    minVariantPrice { amount currencyCode }
    maxVariantPrice { amount currencyCode }
  }
`;

const SEARCH_PRODUCTS_QUERY = `
query SearchProducts($query: String!, $first: Int!, $after: String) {
  search(query: $query, first: $first, after: $after, types: PRODUCT) {
    edges {
      node {
        ... on Product {
          ${PRODUCT_FIELDS}
        }
      }
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}`;

const GET_PRODUCT_QUERY = `
query GetProduct($handle: String!) {
  product(handle: $handle) {
    ${PRODUCT_FIELDS}
  }
}`;

const GET_VARIANT_PRICES_QUERY = `
query GetVariantPrices($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on ProductVariant {
      id
      title
      sku
      quantityAvailable
      price { amount currencyCode }
      availableForSale
      selectedOptions { name value }
    }
  }
}`;

const LIST_PRODUCTS_QUERY = `
query ListProducts($first: Int!, $after: String) {
  products(first: $first, after: $after) {
    edges {
      node {
        ${PRODUCT_FIELDS}
      }
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}`;

const SHOP_QUERY = `
query ShopInfo {
  shop {
    name
    primaryDomain { url }
    paymentSettings { currencyCode }
  }
}`;

// ---------------------------------------------------------------------------
// Raw GraphQL response types
// ---------------------------------------------------------------------------

interface GqlEdge<T> {
  readonly node: T;
}

interface RawProduct {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly handle: string;
  readonly vendor?: string | null;
  readonly images: {
    readonly edges: readonly GqlEdge<{
      readonly url: string;
      readonly altText: string | null;
    }>[];
  };
  readonly variants: { readonly edges: readonly GqlEdge<RawVariant>[] };
  readonly priceRange: {
    readonly minVariantPrice: {
      readonly amount: string;
      readonly currencyCode: string;
    };
    readonly maxVariantPrice: {
      readonly amount: string;
      readonly currencyCode: string;
    };
  };
}

interface RawVariant {
  readonly id: string;
  readonly title: string;
  readonly sku?: string | null;
  readonly quantityAvailable?: number | null;
  readonly price: { readonly amount: string; readonly currencyCode: string };
  readonly availableForSale: boolean;
  readonly selectedOptions: readonly {
    readonly name: string;
    readonly value: string;
  }[];
}

// ---------------------------------------------------------------------------
// Helpers — map Shopify raw data → normalized CommerceProduct/CommerceVariant
// ---------------------------------------------------------------------------

function mapProduct(raw: RawProduct): CommerceProduct {
  return {
    id: raw.id,
    title: raw.title,
    description: raw.description,
    handle: raw.handle,
    brand: raw.vendor ?? null,
    images: raw.images.edges.map((e) => ({
      url: e.node.url,
      altText: e.node.altText,
    })),
    variants: raw.variants.edges.map((e) => mapVariant(e.node)),
    priceRange: {
      min: raw.priceRange.minVariantPrice,
      max: raw.priceRange.maxVariantPrice,
    },
  };
}

function mapVariant(raw: RawVariant): CommerceVariant {
  return {
    id: raw.id,
    title: raw.title,
    price: raw.price,
    availableForSale: raw.availableForSale,
    selectedOptions: raw.selectedOptions,
    sku: raw.sku ?? null,
    inventoryQuantity: raw.quantityAvailable ?? null,
  };
}

// ---------------------------------------------------------------------------
// Shopify Catalog Adapter — implements CatalogAdapter
// ---------------------------------------------------------------------------

export function createShopifyCatalog(
  shopifyConfig: ShopifyPlatformConfig,
): CatalogAdapter {
  const endpoint = `${shopifyConfig.storeUrl}/api/${shopifyConfig.apiVersion}/graphql.json`;

  async function gql<T>(
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<T> {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Storefront-Access-Token": shopifyConfig.storefrontToken,
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Storefront API ${res.status}: ${text}`);
    }

    const json = (await res.json()) as {
      data?: T;
      errors?: readonly { message: string }[];
    };

    if (json.errors?.length) {
      throw new Error(
        `Storefront GraphQL: ${json.errors.map((e) => e.message).join("; ")}`,
      );
    }

    if (!json.data) {
      throw new Error("Storefront API returned no data");
    }

    return json.data;
  }

  async function searchProducts(
    query: string,
    first: number = 10,
    after: string | null = null,
  ): Promise<ProductSearchResult> {
    const data = await gql<{
      search: {
        edges: readonly GqlEdge<RawProduct>[];
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
    }>(SEARCH_PRODUCTS_QUERY, { query, first, after });

    return {
      products: data.search.edges.map((e) => mapProduct(e.node)),
      pageInfo: data.search.pageInfo,
    };
  }

  async function listProducts(
    first: number = 10,
    after: string | null = null,
  ): Promise<ProductSearchResult> {
    const data = await gql<{
      products: {
        edges: readonly GqlEdge<RawProduct>[];
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
    }>(LIST_PRODUCTS_QUERY, { first, after });

    return {
      products: data.products.edges.map((e) => mapProduct(e.node)),
      pageInfo: data.products.pageInfo,
    };
  }

  async function getProduct(handle: string): Promise<CommerceProduct | null> {
    const data = await gql<{ product: RawProduct | null }>(GET_PRODUCT_QUERY, {
      handle,
    });
    return data.product ? mapProduct(data.product) : null;
  }

  async function getVariantPrices(
    variantIds: readonly string[],
  ): Promise<readonly CommerceVariant[]> {
    if (variantIds.length === 0) return [];

    const data = await gql<{ nodes: readonly (RawVariant | null)[] }>(
      GET_VARIANT_PRICES_QUERY,
      { ids: variantIds },
    );

    return data.nodes
      .filter((n): n is RawVariant => n !== null)
      .map(mapVariant);
  }

  async function getStoreMeta(): Promise<StoreMeta> {
    const data = await gql<{
      shop: {
        name: string;
        primaryDomain: { url: string };
        paymentSettings: { currencyCode: string };
      };
    }>(SHOP_QUERY);

    return {
      name: data.shop.name,
      primaryDomainUrl: data.shop.primaryDomain.url,
      currencyCode: data.shop.paymentSettings.currencyCode,
    };
  }

  return {
    searchProducts,
    listProducts,
    getProduct,
    getVariantPrices,
    getStoreMeta,
  };
}
