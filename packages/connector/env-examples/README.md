# Environment Configuration

Environment variables are grouped by **concern** so you only need to read the sections relevant to your deployment.

## How to compose your `.env`

1. Copy `base.env` → this is the foundation every deployment needs.
2. Copy **one** commerce platform file — `shopify.env` **or** `woocommerce.env`.
3. Copy **one** payment provider file — `nexus.env` (only option today).
4. Concatenate them into a single `.env` at the repo root, or use them directly with `docker compose --env-file`.

The quickest way:

```bash
# Shopify + Nexus
cat env-examples/base.env env-examples/shopify.env env-examples/nexus.env > .env

# WooCommerce + Nexus
cat env-examples/base.env env-examples/woocommerce.env env-examples/nexus.env > .env

# Then edit .env with your real values
```

## Files in this directory

| File | Required? | What it covers |
|---|---|---|
| [`base.env`](base.env) | Always | Infra — port, DB, merchant DID, UCP cart-token secret |
| [`shopify.env`](shopify.env) | If `PLATFORM=shopify` | Shopify Storefront + Admin tokens |
| [`woocommerce.env`](woocommerce.env) | If `PLATFORM=woocommerce` | WooCommerce REST v3 credentials |
| [`nexus.env`](nexus.env) | If `PAYMENT_PROVIDER=nexus` | NUPS signer + payout address + RPC endpoints |

Each file documents **where to obtain every value** in comments above it.

## Security notes

- Never commit `.env` (it's in `.gitignore`).
- `UCP_CART_TOKEN_SECRET` must be at least 32 random chars — `openssl rand -hex 32`.
- `MERCHANT_SIGNER_PRIVATE_KEY` is a hot key used to sign NUPS quotes. **Do not reuse the payout wallet key**; generate a dedicated signer key.
- `WOO_BASE_URL` must be HTTPS — HTTP Basic auth over plaintext is rejected at startup.
- Shopify Admin token grants order-create permissions; keep it as tight as possible (Orders: write only).
