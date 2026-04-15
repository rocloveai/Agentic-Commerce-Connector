// ---------------------------------------------------------------------------
// Shared Woo REST fetch helper: retries, redacted logging, timeout.
// ---------------------------------------------------------------------------

import {
  buildAuthHeader,
  buildEndpoint,
  type WooCommercePlatformConfig,
} from "./config.js";

export interface WooRequest {
  readonly method: "GET" | "POST" | "PUT" | "DELETE";
  readonly path: string;
  readonly query?: Record<string, string | number | undefined>;
  readonly body?: unknown;
}

export class WooApiError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string, message: string) {
    super(message);
    this.status = status;
    this.body = body;
    this.name = "WooApiError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function buildQueryString(
  query: Record<string, string | number | undefined> | undefined,
): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== "") params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

function redactUrl(url: string): string {
  return url.replace(/consumer_(key|secret)=[^&]+/g, "consumer_$1=REDACTED");
}

export async function wooFetch<T>(
  cfg: WooCommercePlatformConfig,
  req: WooRequest,
): Promise<T> {
  const url = buildEndpoint(cfg, req.path) + buildQueryString(req.query);
  const headers: Record<string, string> = {
    Authorization: buildAuthHeader(cfg),
    Accept: "application/json",
  };
  if (req.body !== undefined) headers["Content-Type"] = "application/json";

  let lastErr: Error | null = null;
  for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      cfg.requestTimeoutMs,
    );
    try {
      const res = await fetch(url, {
        method: req.method,
        headers,
        body: req.body === undefined ? undefined : JSON.stringify(req.body),
        signal: controller.signal,
      });
      clearTimeout(timer);

      const text = await res.text();
      if (res.status === 429 || res.status >= 500) {
        // Retry with exponential backoff + jitter
        if (attempt < cfg.maxRetries) {
          const delay = 200 * Math.pow(2, attempt) + Math.random() * 200;
          console.error(
            `[Woo] ${req.method} ${redactUrl(url)} → ${res.status}, retry in ${Math.round(delay)}ms`,
          );
          await sleep(delay);
          continue;
        }
      }
      if (!res.ok) {
        throw new WooApiError(
          res.status,
          text,
          `Woo API ${req.method} ${req.path} failed (${res.status})`,
        );
      }
      return (text ? JSON.parse(text) : {}) as T;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err instanceof Error ? err : new Error(String(err));
      if (err instanceof WooApiError) throw err;
      if (attempt < cfg.maxRetries) {
        const delay = 200 * Math.pow(2, attempt) + Math.random() * 200;
        console.error(
          `[Woo] ${req.method} ${redactUrl(url)} → network error, retry in ${Math.round(delay)}ms: ${lastErr.message}`,
        );
        await sleep(delay);
        continue;
      }
      throw lastErr;
    }
  }
  throw lastErr ?? new Error("Woo request failed");
}
