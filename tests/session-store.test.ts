import assert from "node:assert/strict";
import test from "node:test";
import { clearSession, isAlreadyProcessed, loadSession, markProcessed, saveSession } from "../supabase/functions/_shared/session-store.js";

interface Row { [key: string]: unknown }

/** Fake admin covering exactly the chain shapes session-store.ts calls:
 * .from(t).select().eq().eq().gt().maybeSingle(), .from(t).upsert(row, opts),
 * .from(t).delete().eq().eq(), .from(t).insert(row). */
function fakeAdmin() {
  const sessions: Row[] = [];
  const processed = new Set<string>();

  return {
    sessions,
    from(table: string) {
      if (table === "mag_telegram_sessions") {
        return {
          select: () => ({
            eq: (col1: string, val1: unknown) => ({
              eq: (col2: string, val2: unknown) => ({
                gt: (col3: string, val3: string) => ({
                  maybeSingle: async () => {
                    const row = sessions.find((r) => r[col1] === val1 && r[col2] === val2 && (r[col3] as string) > val3) ?? null;
                    return { data: row, error: null };
                  },
                }),
              }),
            }),
          }),
          upsert: async (row: Row, opts: { onConflict: string }) => {
            const keys = opts.onConflict.split(",");
            const existing = sessions.find((r) => keys.every((k) => r[k] === row[k]));
            if (existing) Object.assign(existing, row); else sessions.push({ ...row });
            return { error: null };
          },
          delete: () => ({
            eq: (col1: string, val1: unknown) => ({
              eq: (col2: string, val2: unknown) => {
                const idx = sessions.findIndex((r) => r[col1] === val1 && r[col2] === val2);
                if (idx >= 0) sessions.splice(idx, 1);
                return { error: null };
              },
            }),
          }),
        };
      }
      if (table === "mag_telegram_processed_updates") {
        return {
          select: () => ({
            eq: (_col: string, val: unknown) => ({
              maybeSingle: async () => ({ data: processed.has(val as string) ? { idempotency_key: val } : null, error: null }),
            }),
          }),
          upsert: async (row: Row) => {
            processed.add(row.idempotency_key as string);
            return { error: null };
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
}

test("saveSession then loadSession round-trips for the same telegram_user_id + scope", async () => {
  const admin = fakeAdmin();
  await saveSession(admin, { telegramUserId: 1, sessionScope: "CUSTOMER_ORDER", chatId: 1, currentFlow: "ORDER", currentStep: "SELECT_SERVICE", context: { serviceCode: "PR500" }, orderId: null, lastUpdateId: 10 });
  const loaded = await loadSession(admin, 1, "CUSTOMER_ORDER");
  assert.equal(loaded?.currentFlow, "ORDER");
  assert.equal(loaded?.currentStep, "SELECT_SERVICE");
  assert.deepEqual(loaded?.context, { serviceCode: "PR500" });
});

test("CUSTOMER_ORDER and AFFILIATE_ADMIN sessions for the same user do not collide", async () => {
  const admin = fakeAdmin();
  await saveSession(admin, { telegramUserId: 1, sessionScope: "CUSTOMER_ORDER", chatId: 1, currentFlow: "ORDER", currentStep: "INTAKE", context: {}, orderId: null, lastUpdateId: 1 });
  await saveSession(admin, { telegramUserId: 1, sessionScope: "AFFILIATE_ADMIN", chatId: 1, currentFlow: "ADMIN_PROMO_NAME", currentStep: null, context: { draft: "x" }, orderId: null, lastUpdateId: 2 });
  const order = await loadSession(admin, 1, "CUSTOMER_ORDER");
  const admin_ = await loadSession(admin, 1, "AFFILIATE_ADMIN");
  assert.equal(order?.currentFlow, "ORDER");
  assert.equal(admin_?.currentFlow, "ADMIN_PROMO_NAME");
  assert.equal(admin.sessions.length, 2, "expected two independent rows, not one overwritten by the other");
});

test("a session past its expires_at is not returned by loadSession", async () => {
  const admin = fakeAdmin();
  admin.sessions.push({ telegram_user_id: 5, session_scope: "CUSTOMER_ORDER", chat_id: 5, current_flow: "STALE", context: {}, expires_at: new Date(Date.now() - 60_000).toISOString() });
  const loaded = await loadSession(admin, 5, "CUSTOMER_ORDER");
  assert.equal(loaded, null);
});

test("clearSession removes only the targeted scope", async () => {
  const admin = fakeAdmin();
  await saveSession(admin, { telegramUserId: 2, sessionScope: "CUSTOMER_ORDER", chatId: 2, currentFlow: "ORDER", currentStep: null, context: {}, orderId: null, lastUpdateId: null });
  await saveSession(admin, { telegramUserId: 2, sessionScope: "AFFILIATE_ADMIN", chatId: 2, currentFlow: "ADMIN", currentStep: null, context: {}, orderId: null, lastUpdateId: null });
  await clearSession(admin, 2, "CUSTOMER_ORDER");
  assert.equal(await loadSession(admin, 2, "CUSTOMER_ORDER"), null);
  assert.ok(await loadSession(admin, 2, "AFFILIATE_ADMIN"));
});

test("isAlreadyProcessed is false until markProcessed is called for that key", async () => {
  const admin = fakeAdmin();
  assert.equal(await isAlreadyProcessed(admin, "update-100", "UPDATE"), false);
  await markProcessed(admin, "update-100", "UPDATE", 1, "start_command");
  assert.equal(await isAlreadyProcessed(admin, "update-100", "UPDATE"), true);
});

test("a mid-handler failure before markProcessed leaves the key unclaimed, so a Telegram retry can actually redo the work", async () => {
  const admin = fakeAdmin();
  assert.equal(await isAlreadyProcessed(admin, "update-200", "UPDATE"), false, "first delivery: not yet processed, proceed");
  // Simulate the handler throwing partway through -- markProcessed is never reached.
  assert.equal(await isAlreadyProcessed(admin, "update-200", "UPDATE"), false, "retry: still not marked processed, so the retry will actually run the handler instead of silently no-op-ing");
});

test("an UPDATE and a CALLBACK claim never collide even with the identical literal key", async () => {
  const admin = fakeAdmin();
  await markProcessed(admin, "12345", "UPDATE", 1, null);
  assert.equal(await isAlreadyProcessed(admin, "12345", "UPDATE"), true);
  assert.equal(await isAlreadyProcessed(admin, "12345", "CALLBACK"), false, "kind is part of the stored key, so the same literal id in two different Telegram ID spaces must not be treated as a replay of the other");
});
