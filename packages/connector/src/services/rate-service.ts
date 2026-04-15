import type { Config } from "../config.js";

export interface RateConversion {
  readonly rate: string;
  readonly stablecoinAmount: string;
  readonly lockedAt: string;
  readonly expiresAt: string;
}

/**
 * Supported fiat → stablecoin mappings.
 * SGD → XSGD (1:1), USD → USDC (1:1).
 */
const SUPPORTED_CURRENCIES: ReadonlySet<string> = new Set(["SGD", "USD"]);

/**
 * Convert a fiat amount to its stablecoin equivalent.
 *
 * MVP: fixed rate (config.fixedRate, default 1.00).
 * Supports SGD → XSGD and USD → USDC.
 */
export function convertToStablecoin(
  fiatAmount: string,
  fiatCurrency: string,
  config: Config,
): RateConversion {
  if (!SUPPORTED_CURRENCIES.has(fiatCurrency)) {
    throw new Error(
      `Unsupported currency "${fiatCurrency}". Supported: ${[...SUPPORTED_CURRENCIES].join(", ")}`,
    );
  }

  const amount = parseFloat(fiatAmount);
  if (isNaN(amount) || amount <= 0) {
    throw new Error(`Invalid fiat amount: "${fiatAmount}"`);
  }

  const rate = config.fixedRate;
  const stablecoinAmount = (amount * rate).toFixed(2);

  const now = new Date();
  const expiresAt = new Date(
    now.getTime() + config.rateLockMinutes * 60 * 1000,
  );

  return {
    rate: rate.toFixed(6),
    stablecoinAmount,
    lockedAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
}
