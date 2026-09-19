/** Load/save mag_telegram_sessions. The webhook is stateless per invocation
 * (no in-memory conversation state survives between requests), so every
 * handler must load its scope's session row, act on it, and save it back --
 * see docs/TELEGRAM_WEBHOOK_MIGRATION.md. Takes an already-constructed admin
 * (service-role) Supabase client, so this module has no Deno-specific
 * imports and is unit-testable under Node. */

export type SessionScope = "CUSTOMER_ORDER" | "AFFILIATE_ADMIN" | "ADMIN";

export interface TelegramSession {
  telegramUserId: number;
  sessionScope: SessionScope;
  chatId: number;
  currentFlow: string | null;
  currentStep: string | null;
  context: Record<string, unknown>;
  orderId: string | null;
  lastUpdateId: number | null;
}

const SCOPE_TTL_HOURS: Record<SessionScope, number> = { CUSTOMER_ORDER: 24, AFFILIATE_ADMIN: 1, ADMIN: 1 };

function fromRow(row: Record<string, unknown> | null): TelegramSession | null {
  if (!row) return null;
  return {
    telegramUserId: row.telegram_user_id as number,
    sessionScope: row.session_scope as SessionScope,
    chatId: row.chat_id as number,
    currentFlow: (row.current_flow as string | null) ?? null,
    currentStep: (row.current_step as string | null) ?? null,
    context: (row.context as Record<string, unknown>) ?? {},
    orderId: (row.order_id as string | null) ?? null,
    lastUpdateId: (row.last_update_id as number | null) ?? null,
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any -- admin is a supabase-js client; see order-intake.ts for the same rationale. */
export async function loadSession(admin: any, telegramUserId: number, scope: SessionScope): Promise<TelegramSession | null> {
  const { data, error } = await admin
    .from("mag_telegram_sessions")
    .select("*")
    .eq("telegram_user_id", telegramUserId)
    .eq("session_scope", scope)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  if (error) throw error;
  return fromRow(data);
}

export async function saveSession(admin: any, session: Omit<TelegramSession, "context"> & { context?: Record<string, unknown> }): Promise<void> {
  const ttlHours = SCOPE_TTL_HOURS[session.sessionScope];
  const { error } = await admin.from("mag_telegram_sessions").upsert({
    telegram_user_id: session.telegramUserId,
    session_scope: session.sessionScope,
    chat_id: session.chatId,
    current_flow: session.currentFlow,
    current_step: session.currentStep,
    context: session.context ?? {},
    order_id: session.orderId,
    last_update_id: session.lastUpdateId,
    expires_at: new Date(Date.now() + ttlHours * 60 * 60 * 1000).toISOString(),
  }, { onConflict: "telegram_user_id,session_scope" });
  if (error) throw error;
}

export async function clearSession(admin: any, telegramUserId: number, scope: SessionScope): Promise<void> {
  const { error } = await admin
    .from("mag_telegram_sessions")
    .delete()
    .eq("telegram_user_id", telegramUserId)
    .eq("session_scope", scope);
  if (error) throw error;
}

/** Read-only check for whether a Telegram idempotency key has already been
 * fully processed. Call this BEFORE doing any side effects, and only
 * markProcessed AFTER they succeed -- claiming up front and only then
 * running the handler would mean any genuine failure partway through
 * permanently swallows a Telegram retry (it would see "already claimed"
 * and skip the work that never actually completed). The stored key is
 * namespaced by kind (idempotency_key is one shared primary key column) so
 * an update_id and an unrelated callback_query.id can never collide even
 * if they happened to be the same literal string. */
export async function isAlreadyProcessed(admin: any, key: string, kind: "UPDATE" | "CALLBACK"): Promise<boolean> {
  const { data, error } = await admin.from("mag_telegram_processed_updates").select("idempotency_key").eq("idempotency_key", `${kind}:${key}`).maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

/** Record a key as processed after its side effects have succeeded. A
 * duplicate insert (a concurrent delivery that finished first) is not an
 * error -- ignoreDuplicates makes this call idempotent regardless of race
 * outcome. */
export async function markProcessed(admin: any, key: string, kind: "UPDATE" | "CALLBACK", telegramUserId: number | null, action: string | null): Promise<void> {
  const { error } = await admin.from("mag_telegram_processed_updates").upsert({
    idempotency_key: `${kind}:${key}`, kind, telegram_user_id: telegramUserId, action,
  }, { onConflict: "idempotency_key", ignoreDuplicates: true });
  if (error) throw error;
}
/* eslint-enable @typescript-eslint/no-explicit-any */
