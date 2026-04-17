// ---------------------------------------------------------------------------
// Shopify shop-domain validator.
//
// The `?shop=` param on install / callback is operator-controlled; if we
// trust it blindly we enable open-redirect and CSRF-to-attacker-shop flows.
// Rule: must look like `<handle>.myshopify.com`, where handle is lowercase
// alphanumeric/hyphen and does not start with a hyphen.
//
// Design note: intentionally strict. Shopify allows nothing else on the
// install URL. If a merchant has a custom domain, they still go through
// `*.myshopify.com` for OAuth — the custom domain is an aliased storefront.
// ---------------------------------------------------------------------------

const SHOP_DOMAIN_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

export function isValidShopDomain(input: unknown): input is string {
  if (typeof input !== "string") return false;
  if (input.length === 0 || input.length > 256) return false;
  // Reject anything with whitespace, path chars, or scheme.
  if (/[\s/?#:@]/.test(input)) return false;
  return SHOP_DOMAIN_RE.test(input.toLowerCase());
}

/**
 * Normalises to lowercase and returns the shop domain, throwing on invalid
 * input. Use this at the edge (route handlers) so downstream code can assume
 * the value is safe.
 */
export function assertShopDomain(input: unknown): string {
  if (!isValidShopDomain(input)) {
    throw new Error(
      `[Shopify/OAuth] Invalid shop domain. Expected "<handle>.myshopify.com", got: ${JSON.stringify(input)}`,
    );
  }
  return input.toLowerCase();
}
