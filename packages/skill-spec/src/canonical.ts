import { createHash } from "node:crypto";
import type { Sha256Hex } from "./types.js";

export function canonicalize(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => [k, sortKeys(v)] as const);
    return Object.fromEntries(entries);
  }
  return value;
}

export function contentHash(openapi: unknown, tools: unknown): Sha256Hex {
  const hash = createHash("sha256");
  hash.update(canonicalize({ openapi, tools }));
  return `sha256:${hash.digest("hex")}`;
}
