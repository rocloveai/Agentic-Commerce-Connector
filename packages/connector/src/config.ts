// ---------------------------------------------------------------------------
// Back-compat entry point. The real implementation lives in src/config/.
// Kept so existing imports `from "./config.js"` and `from "../config.js"`
// continue to resolve without touching every consumer.
// ---------------------------------------------------------------------------

export {
  loadConfig,
  type Config,
  type ShopifyConfig,
  type WooCommerceConfig,
  type BaseConfig,
  type PlatformType,
  type CommerceEnv,
  type ShopifyEnv,
  type WooCommerceEnv,
  type PaymentProviderType,
  type NexusPaymentEnv,
} from "./config/index.js";
