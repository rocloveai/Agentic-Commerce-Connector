// ---------------------------------------------------------------------------
// POST /pair/new
//
// Called by `acc init` step6. Generates a pair code, registers a pending
// entry in the pair-store, and returns the install URL the merchant will
// open in a browser.
//
// The CLI is expected to then open the URL for the user and poll
// /pair/poll?pair=<code> until tokens are available or the TTL expires.
// ---------------------------------------------------------------------------
import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { RelayConfig } from "../config.js";
import type { PairStore } from "../pair-store.js";
import { readJson, sendJson } from "./_http.js";

export interface PairNewRequest {
  /** Optional; included in the install URL the CLI hands to the browser. */
  readonly hint?: string;
}

export interface PairNewResponse {
  readonly pair_code: string;
  readonly install_url: string;
  readonly poll_url: string;
  readonly expires_in: number;
}

export function newPairCode(): string {
  // 128 bits base32, prefix 'acp_' for grep-ability in logs.
  return "acp_" + randomBytes(16).toString("hex");
}

export async function handlePairNew(
  req: IncomingMessage,
  res: ServerResponse,
  config: RelayConfig,
  store: PairStore,
): Promise<void> {
  let body: PairNewRequest = {};
  try {
    body = await readJson<PairNewRequest>(req);
  } catch {
    // Body is optional; use defaults.
  }

  const pairCode = newPairCode();
  await store.createPending(pairCode, config.pairTtlSeconds, Date.now());

  const installUrl = new URL(`${config.selfUrl}/auth/shopify/install`);
  installUrl.searchParams.set("pair", pairCode);
  if (body.hint) installUrl.searchParams.set("hint", body.hint);

  const pollUrl = new URL(`${config.selfUrl}/pair/poll`);
  pollUrl.searchParams.set("pair", pairCode);

  const response: PairNewResponse = {
    pair_code: pairCode,
    install_url: installUrl.toString(),
    poll_url: pollUrl.toString(),
    expires_in: config.pairTtlSeconds,
  };
  sendJson(res, 200, response);
}
