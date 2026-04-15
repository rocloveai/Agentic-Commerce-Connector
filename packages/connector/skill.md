---
name: agentic-commerce-connector
version: "0.2.0"
description: UCP/1.0-native commerce agent — bridges AI agents to Shopify / WooCommerce / ... with NUPS stablecoin payment
merchant_did: "did:nexus:20250407:nexus-demo-store-2"
protocol: UCP/1.0
payment_protocol: NUPS/1.5
category: commerce.universal
currencies: [XSGD]
chain_id: 20250407
interface: http
endpoints:
  - GET  /ucp/v1/discovery
  - POST /ucp/v1/search
  - GET  /ucp/v1/products/:handle
  - POST /ucp/v1/checkout-sessions
  - GET  /ucp/v1/checkout-sessions/:id
  - POST /ucp/v1/checkout-sessions/:id/complete
  - GET  /ucp/v1/orders/:id
legacy_endpoints:
  - GET  /api/v1/products           # deprecated (will be removed)
  - GET  /api/v1/products/:handle
  - POST /api/v1/checkout
  - GET  /api/v1/checkout/:sessionId
---

# Nexus Shopify Agent — HTTP API

Shopify commerce merchant agent powered by Nexus Protocol. Searches products from a Shopify store (SGD pricing), creates checkout sessions with XSGD stablecoin payment, and manages order fulfillment.

## Base URL

```
https://api.nexus.platon.network/shopify-agent
```

## API Endpoints

### Search Products

```
GET /api/v1/products?q={query}&first={count}&after={cursor}
```

Search products in the Shopify store. Returns product names, prices, variant IDs, and availability.

| Parameter | Type   | Required | Description |
|-----------|--------|----------|-------------|
| `q`       | string | Yes      | Search query (e.g. 'snowboard', 'gift card') |
| `first`   | number | No       | Number of results (1-50, default 10) |
| `after`   | string | No       | Pagination cursor from previous results |

**Response:**

```json
{
  "ok": true,
  "data": {
    "products": [
      {
        "title": "The Collection Snowboard: Hydrogen",
        "handle": "the-collection-snowboard-hydrogen",
        "description": "...",
        "priceRange": { "min": { "amount": "600.00", "currencyCode": "SGD" } },
        "variants": [
          {
            "id": "gid://shopify/ProductVariant/...",
            "title": "Default",
            "price": { "amount": "600.00", "currencyCode": "SGD" },
            "availableForSale": true
          }
        ]
      }
    ],
    "pageInfo": { "hasNextPage": false, "endCursor": "..." }
  }
}
```

---

### Get Product Detail

```
GET /api/v1/products/:handle
```

Get detailed product information by handle (URL slug).

| Parameter | Type   | Required | Description |
|-----------|--------|----------|-------------|
| `handle`  | string | Yes      | Product handle (e.g. 'the-collection-snowboard-hydrogen') |

**Response:**

```json
{
  "ok": true,
  "data": {
    "title": "The Collection Snowboard: Hydrogen",
    "handle": "the-collection-snowboard-hydrogen",
    "description": "...",
    "variants": [...]
  }
}
```

---

### Create Checkout

```
POST /api/v1/checkout
Content-Type: application/json
```

Create a checkout session for selected products. Converts fiat prices to XSGD and generates a payment link.

**Request body:**

```json
{
  "items": [
    { "variant_id": "gid://shopify/ProductVariant/...", "quantity": 1 }
  ],
  "buyer_email": "user@example.com",
  "payer_wallet": "0x...",
  "shipping_address": {
    "first_name": "John",
    "last_name": "Doe",
    "address1": "1 Raffles Place",
    "address2": "#20-01",
    "city": "Singapore",
    "country": "Singapore",
    "zip": "048616",
    "phone": "+6591234567"
  }
}
```

| Field              | Type   | Required | Description |
|--------------------|--------|----------|-------------|
| `items`            | array  | Yes      | Array of `{variant_id, quantity}` objects |
| `buyer_email`      | string | No       | Buyer's email for order notification |
| `payer_wallet`     | string | No       | Payer's EVM wallet address (0x...) |
| `shipping_address` | object | No       | Shipping address for physical products (see below) |

**`shipping_address` fields:**

| Field        | Type   | Required | Description |
|--------------|--------|----------|-------------|
| `first_name` | string | Yes      | Recipient first name |
| `last_name`  | string | Yes      | Recipient last name |
| `address1`   | string | Yes      | Street address line 1 |
| `address2`   | string | No       | Street address line 2 (unit, suite, etc.) |
| `city`       | string | Yes      | City |
| `province`   | string | No       | State or province |
| `country`    | string | Yes      | Country (e.g. 'Singapore', 'US') |
| `zip`        | string | Yes      | Postal/ZIP code |
| `phone`      | string | No       | Phone number |

**Response:**

```json
{
  "ok": true,
  "data": {
    "session": {
      "id": "cs_...",
      "line_items": [...],
      "subtotal": "600.00",
      "currency": "SGD",
      "token_amount": "600.00",
      "rate": "1.000000",
      "order_ref": "SHP-xxxxx",
      "status": "payment_pending"
    },
    "checkout_url": "https://nexus.platon.network/checkout/..."
  }
}
```

---

### Check Checkout Status

```
GET /api/v1/checkout/:sessionId
```

Check the status of a checkout session. Returns payment state and Shopify order info if completed.

| Parameter    | Type   | Required | Description |
|--------------|--------|----------|-------------|
| `sessionId`  | string | Yes      | The session ID (e.g. 'cs_...') |

**Response:**

```json
{
  "ok": true,
  "data": {
    "id": "cs_...",
    "status": "completed",
    "line_items": [...],
    "subtotal": "600.00",
    "token_amount": "600.00",
    "order_ref": "SHP-xxxxx",
    "shopify_order_name": "#1001",
    "tx_hash": "0x..."
  }
}
```

## Checkout Workflow

1. **Browse** — `GET /api/v1/products?q=snowboard` to find products.
2. **Select** — `GET /api/v1/products/:handle` for details. Note the `variant_id`.
3. **Checkout** — `POST /api/v1/checkout` with selected variant IDs and quantities. Returns a `checkout_url`.
4. **Pay** — Direct user to the `checkout_url`. Payment is handled by Nexus checkout page.
5. **Verify** — `GET /api/v1/checkout/:sessionId` to confirm payment and get the Shopify order number.

## Error Response

All errors follow a consistent format:

```json
{
  "ok": false,
  "error": "Error description"
}
```

## MCP (Alternative)

MCP protocol is also available at `POST /mcp` for MCP-compatible clients.
