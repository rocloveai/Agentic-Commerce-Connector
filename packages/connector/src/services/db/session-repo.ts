import type {
  CheckoutSession,
  SessionStatus,
  ResolvedLineItem,
} from "../../types.js";

// ---------------------------------------------------------------------------
// In-memory session store (MVP — will migrate to PostgreSQL later)
// ---------------------------------------------------------------------------

const store = new Map<string, CheckoutSession>();

let sessionCounter = 0;

export function newSessionId(): string {
  sessionCounter += 1;
  const ts = Date.now().toString(36);
  const seq = sessionCounter.toString(36).padStart(3, "0");
  return `cs_${ts}${seq}`;
}

export async function createSession(
  session: CheckoutSession,
): Promise<CheckoutSession> {
  store.set(session.id, session);
  return session;
}

export async function getSession(
  sessionId: string,
): Promise<CheckoutSession | null> {
  return store.get(sessionId) ?? null;
}

export async function updateSession(
  sessionId: string,
  updates: Partial<
    Pick<
      CheckoutSession,
      | "status"
      | "token_amount"
      | "rate"
      | "rate_locked_at"
      | "rate_expires_at"
      | "payment_group_id"
      | "order_ref"
      | "tx_hash"
      | "platform_order_id"
      | "platform_order_name"
      | "completed_at"
    >
  >,
): Promise<CheckoutSession | null> {
  const existing = store.get(sessionId);
  if (!existing) return null;

  const updated: CheckoutSession = {
    ...existing,
    ...updates,
    updated_at: new Date().toISOString(),
  };
  store.set(sessionId, updated);
  return updated;
}

export async function listSessions(
  limit: number = 50,
): Promise<readonly CheckoutSession[]> {
  const all = [...store.values()];
  all.sort(
    (a, b) =>
      new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );
  return all.slice(0, limit);
}

export async function findSessionByOrderRef(
  orderRef: string,
): Promise<CheckoutSession | null> {
  for (const session of store.values()) {
    if (session.order_ref === orderRef) return session;
  }
  return null;
}
