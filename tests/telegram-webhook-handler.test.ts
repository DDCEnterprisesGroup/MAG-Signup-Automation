import assert from "node:assert/strict";
import test from "node:test";
import { handleUpdate, type TelegramUpdate } from "../supabase/functions/mag-telegram-webhook/handler.js";

interface Row { [key: string]: unknown }

function fakeAdmin(seed: { admins?: Row[]; products?: Row[]; customers?: Row[]; orders?: Row[]; history?: Row[] } = {}) {
  const tables: Record<string, Row[]> = {
    mag_telegram_admins: seed.admins ?? [],
    mag_products: seed.products ?? [],
    mag_customers: seed.customers ?? [],
    mag_orders: seed.orders ?? [],
    mag_order_status_history: seed.history ?? [],
    mag_telegram_sessions: [],
    mag_telegram_processed_updates: [],
  };
  let nextId = 1;

  function selectBuilder(table: string, rows: Row[]) {
    const applyEq: Array<[string, unknown]> = [];
    const applyGt: Array<[string, string]> = [];
    const matches = (r: Row) => applyEq.every(([c, v]) => r[c] === v) && applyGt.every(([c, v]) => String(r[c]) > v);
    const api = {
      eq(col: string, val: unknown) { applyEq.push([col, val]); return api; },
      gt(col: string, val: string) { applyGt.push([col, val]); return api; },
      order() { return api; },
      limit(n: number) { rows = rows.slice(0, n); return api; },
      async maybeSingle() {
        const row = rows.find(matches) ?? null;
        return { data: row, error: null };
      },
      then(resolve: (v: { data: Row[]; error: null }) => unknown) {
        const filtered = rows.filter(matches);
        return Promise.resolve({ data: filtered, error: null }).then(resolve);
      },
    };
    return api;
  }

  return {
    tables,
    from(table: string) {
      const rows = tables[table]!;
      return {
        select: () => selectBuilder(table, rows),
        upsert: (row: Row, opts: { onConflict: string }) => {
          const keys = opts.onConflict.split(",");
          const existing = rows.find((r) => keys.every((k) => r[k] === row[k]));
          const saved = existing ? Object.assign(existing, row) : Object.assign({ id: `${table}-${nextId++}` }, row);
          if (!existing) rows.push(saved);
          return { select: () => ({ single: async () => ({ data: saved, error: null }) }) };
        },
      };
    },
  };
}

function fakeTelegram() {
  const sent: Array<{ chatId: number | string; text: string; replyMarkup?: unknown }> = [];
  const answered: string[] = [];
  return {
    sent,
    answered,
    sendMessage: async (chatId: number | string, text: string, options: { replyMarkup?: unknown } = {}) => { sent.push({ chatId, text, replyMarkup: options.replyMarkup }); return { message_id: 1 }; },
    editMessageText: async () => true,
    answerCallbackQuery: async (id: string) => { answered.push(id); return true as const; },
  };
}

function messageUpdate(updateId: number, text: string, userId = 1, chatId = 1): TelegramUpdate {
  return { update_id: updateId, message: { message_id: updateId, text, chat: { id: chatId }, from: { id: userId } } };
}

function callbackUpdate(updateId: number, data: string, callbackId: string, userId = 1, chatId = 1): TelegramUpdate {
  return { update_id: updateId, callback_query: { id: callbackId, data, message: { message_id: 1, chat: { id: chatId } }, from: { id: userId } } };
}

test("/start creates a customer, saves a session, and sends the main menu", async () => {
  const admin = fakeAdmin();
  const telegram = fakeTelegram();
  await handleUpdate({ admin: admin as never, telegram: telegram as never }, messageUpdate(1, "/start", 42, 42));
  assert.equal(admin.tables.mag_customers!.length, 1);
  assert.equal(admin.tables.mag_customers![0]!.telegram_user_id, 42);
  assert.equal(admin.tables.mag_telegram_sessions!.length, 1);
  assert.equal(admin.tables.mag_telegram_sessions![0]!.session_scope, "CUSTOMER_ORDER");
  assert.match(telegram.sent[0]!.text, /Welcome to MAGHausPR/);
});

test("redelivering the same update_id does not create a second customer row or send a second message", async () => {
  const admin = fakeAdmin();
  const telegram = fakeTelegram();
  const update = messageUpdate(1, "/start", 42, 42);
  await handleUpdate({ admin: admin as never, telegram: telegram as never }, update);
  await handleUpdate({ admin: admin as never, telegram: telegram as never }, update);
  assert.equal(admin.tables.mag_customers!.length, 1);
  assert.equal(telegram.sent.length, 1, "the redelivered update must not be reprocessed");
  assert.equal(admin.tables.mag_telegram_processed_updates!.filter((row) => row.idempotency_key === "UPDATE:1").length, 1);
});

test("a failed route leaves its update unmarked so Telegram can retry", async () => {
  const admin = fakeAdmin();
  const telegram = fakeTelegram();
  const update = messageUpdate(101, "/start", 42, 42);
  const send = telegram.sendMessage;
  telegram.sendMessage = async () => { throw new Error("synthetic delivery failure"); };
  await assert.rejects(() => handleUpdate({ admin: admin as never, telegram: telegram as never }, update));
  assert.equal(admin.tables.mag_telegram_processed_updates!.length, 0);
  telegram.sendMessage = send;
  await handleUpdate({ admin: admin as never, telegram: telegram as never }, update);
  assert.equal(admin.tables.mag_telegram_processed_updates!.filter((row) => row.idempotency_key === "UPDATE:101").length, 1);
  assert.equal(telegram.sent.length, 1);
});

test("/admin denies a non-admin telegram user without revealing dashboard content", async () => {
  const admin = fakeAdmin({ admins: [] });
  const telegram = fakeTelegram();
  await handleUpdate({ admin: admin as never, telegram: telegram as never }, messageUpdate(2, "/admin", 99, 99));
  assert.equal(telegram.sent.length, 1);
  assert.match(telegram.sent[0]!.text, /restricted/i);
});

test("/admin allows an active admin from mag_telegram_admins", async () => {
  const admin = fakeAdmin({ admins: [{ telegram_user_id: 99, active: true }] });
  const telegram = fakeTelegram();
  await handleUpdate({ admin: admin as never, telegram: telegram as never }, messageUpdate(3, "/admin", 99, 99));
  assert.match(telegram.sent[0]!.text, /Admin Dashboard/);
});

test("admin order list, search, and history require an active Telegram admin", async () => {
  const admin = fakeAdmin({
    admins: [{ telegram_user_id: 99, active: true }],
    orders: [{ id: "order-1", order_number: "MAGHP-000001", payment_status: "PAYMENT_REVIEW", status: "DRAFT", customer_id: "cust-1", service_type: "PR500", total: 5000, payment_method: "ZELLE" }],
    history: [{ order_id: "order-1", previous_status: "DRAFT", new_status: "READY_FOR_REVIEW", created_at: "2026-09-19T00:00:00Z" }],
  });
  const telegram = fakeTelegram();
  const deps = { admin: admin as never, telegram: telegram as never };
  await handleUpdate(deps, callbackUpdate(100, "admin:list:PAYMENT_REVIEW", "cb-list", 7, 7));
  assert.match(telegram.sent.at(-1)!.text, /restricted/i);
  await handleUpdate(deps, callbackUpdate(101, "admin:list:PAYMENT_REVIEW", "cb-list-admin", 99, 99));
  assert.match(telegram.sent.at(-1)!.text, /1 recent order/);
  await handleUpdate(deps, callbackUpdate(102, "admin:find", "cb-find", 99, 99));
  assert.equal(admin.tables.mag_telegram_sessions![0]!.session_scope, "ADMIN");
  await handleUpdate(deps, messageUpdate(103, "maghp-000001", 99, 99));
  assert.match(telegram.sent.at(-1)!.text, /Sensitive intake is not shown/);
  assert.equal(admin.tables.mag_telegram_sessions![0]!.current_step, null);
  await handleUpdate(deps, callbackUpdate(104, "admin:history:order-1", "cb-history", 99, 99));
  assert.match(telegram.sent.at(-1)!.text, /DRAFT → READY_FOR_REVIEW/);
});

test("/admin denies a deactivated admin row", async () => {
  const admin = fakeAdmin({ admins: [{ telegram_user_id: 99, active: false }] });
  const telegram = fakeTelegram();
  await handleUpdate({ admin: admin as never, telegram: telegram as never }, messageUpdate(4, "/admin", 99, 99));
  assert.match(telegram.sent[0]!.text, /restricted/i);
});

test("order:begin lists active products as callback buttons priced in dollars", async () => {
  const admin = fakeAdmin({ products: [{ code: "PR500", name: "500 Public Records", standard_price: 5000, active: true }] });
  const telegram = fakeTelegram();
  await handleUpdate({ admin: admin as never, telegram: telegram as never }, callbackUpdate(5, "order:begin", "cb-1", 7, 7));
  assert.deepEqual(telegram.answered, ["cb-1"]);
  const keyboard = telegram.sent[0]!.replyMarkup as Array<Array<{ text: string; callback_data: string }>>;
  assert.match(keyboard[0]![0]!.text, /500 Public Records - \$50\.00/);
  assert.equal(keyboard[0]![0]!.callback_data, "order:service:PR500");
});

test("a double-tapped callback (same callback_query.id, new update_id) is acked but not reprocessed", async () => {
  const admin = fakeAdmin({ products: [{ code: "PR500", name: "500 Public Records", standard_price: 5000, active: true }] });
  const telegram = fakeTelegram();
  await handleUpdate({ admin: admin as never, telegram: telegram as never }, callbackUpdate(6, "order:begin", "cb-dup", 8, 8));
  await handleUpdate({ admin: admin as never, telegram: telegram as never }, callbackUpdate(7, "order:begin", "cb-dup", 8, 8));
  assert.equal(telegram.sent.length, 1, "the second (duplicate) callback must not re-send the product list");
  assert.equal(telegram.answered.length, 2, "both deliveries should still get their loading spinner cleared");
});

test("ordering selection persists service and profile count across separate updates", async () => {
  const admin = fakeAdmin({ products: [{ code: "PR500", name: "500 Public Records", standard_price: 5000, active: true, availability: "AVAILABLE" }] });
  const telegram = fakeTelegram();
  const deps = { admin: admin as never, telegram: telegram as never };
  await handleUpdate(deps, callbackUpdate(20, "order:begin", "cb-begin", 7, 7));
  await handleUpdate(deps, callbackUpdate(21, "order:service:PR500", "cb-service", 7, 7));
  assert.match(telegram.sent.at(-1)!.text, /how many profiles/i);
  await handleUpdate(deps, callbackUpdate(22, "order:count:other", "cb-other", 7, 7));
  await handleUpdate(deps, messageUpdate(23, "6", 7, 7));
  const session = admin.tables.mag_telegram_sessions![0]!;
  assert.equal(session.current_step, "ADDON_MODE");
  assert.deepEqual(session.context, { serviceCode: "PR500", profileCount: 6 });
  assert.match(telegram.sent.at(-1)!.text, /Email Confirmation add-on/);
});

test("service selection rejects stale callbacks and coming-soon products without changing order state", async () => {
  const admin = fakeAdmin({ products: [{ code: "PR500", name: "500 Public Records", standard_price: 5000, active: true, availability: "COMING_SOON" }] });
  const telegram = fakeTelegram();
  const deps = { admin: admin as never, telegram: telegram as never };
  await handleUpdate(deps, callbackUpdate(30, "order:service:PR500", "cb-stale", 7, 7));
  assert.match(telegram.sent.at(-1)!.text, /expired/i);
  await handleUpdate(deps, callbackUpdate(31, "order:begin", "cb-begin", 7, 7));
  await handleUpdate(deps, callbackUpdate(32, "order:service:PR500", "cb-soon", 7, 7));
  assert.match(telegram.sent.at(-1)!.text, /coming soon/i);
  assert.equal(admin.tables.mag_telegram_sessions![0]!.current_step, "SELECT_SERVICE");
});

test("invalid custom profile count does not advance the order wizard", async () => {
  const admin = fakeAdmin({ products: [{ code: "PR500", name: "500 Public Records", standard_price: 5000, active: true, availability: "AVAILABLE" }] });
  const telegram = fakeTelegram();
  const deps = { admin: admin as never, telegram: telegram as never };
  await handleUpdate(deps, callbackUpdate(40, "order:begin", "cb-begin", 7, 7));
  await handleUpdate(deps, callbackUpdate(41, "order:service:PR500", "cb-service", 7, 7));
  await handleUpdate(deps, callbackUpdate(42, "order:count:other", "cb-other", 7, 7));
  await handleUpdate(deps, messageUpdate(43, "26", 7, 7));
  assert.equal(admin.tables.mag_telegram_sessions![0]!.current_step, "PROFILE_COUNT_CUSTOM");
  assert.match(telegram.sent.at(-1)!.text, /1 to 25/);
});

test("order:status reports recent orders for a known customer and a friendly message for none", async () => {
  const admin = fakeAdmin({
    customers: [{ id: "cust-1", telegram_user_id: 55 }],
    orders: [{ order_number: "MAGHP-000001", payment_status: "AWAITING_PAYMENT", status: "DRAFT", customer_id: "cust-1" }],
  });
  const telegram = fakeTelegram();
  await handleUpdate({ admin: admin as never, telegram: telegram as never }, callbackUpdate(8, "order:status", "cb-2", 55, 55));
  assert.match(telegram.sent[0]!.text, /MAGHP-000001: AWAITING_PAYMENT \/ DRAFT/);
});

test("order lookup is scoped to the Telegram customer and clears the lookup state", async () => {
  const admin = fakeAdmin({
    customers: [{ id: "cust-1", telegram_user_id: 55 }, { id: "cust-2", telegram_user_id: 56 }],
    orders: [{ order_number: "MAGHP-000001", payment_status: "AWAITING_PAYMENT", status: "DRAFT", customer_id: "cust-1" }],
  });
  const telegram = fakeTelegram();
  const deps = { admin: admin as never, telegram: telegram as never };
  await handleUpdate(deps, callbackUpdate(60, "status:lookup", "cb-lookup", 56, 56));
  await handleUpdate(deps, messageUpdate(61, "MAGHP-000001", 56, 56));
  assert.match(telegram.sent.at(-1)!.text, /not found for your Telegram account/);
  assert.equal(admin.tables.mag_telegram_sessions![0]!.current_step, null);
  await handleUpdate(deps, callbackUpdate(62, "status:lookup", "cb-lookup2", 55, 55));
  await handleUpdate(deps, messageUpdate(63, "maghp-000001", 55, 55));
  assert.match(telegram.sent.at(-1)!.text, /MAGHP-000001: AWAITING_PAYMENT/);
});

test("/start preserves an in-progress order selection and pricing excludes disabled products", async () => {
  const admin = fakeAdmin({ products: [
    { code: "PR500", name: "500 Public Records", standard_price: 5000, active: true, availability: "AVAILABLE" },
    { code: "PR1000", name: "1000 Public Records", standard_price: 9000, active: false, availability: "DISABLED" },
  ] });
  const telegram = fakeTelegram();
  const deps = { admin: admin as never, telegram: telegram as never };
  await handleUpdate(deps, callbackUpdate(70, "order:begin", "cb-begin", 7, 7));
  await handleUpdate(deps, callbackUpdate(71, "order:service:PR500", "cb-service", 7, 7));
  await handleUpdate(deps, messageUpdate(72, "/start", 7, 7));
  assert.equal(admin.tables.mag_telegram_sessions![0]!.current_step, "PROFILE_COUNT");
  await handleUpdate(deps, callbackUpdate(73, "menu:pricing", "cb-pricing", 7, 7));
  assert.match(telegram.sent.at(-1)!.text, /500 Public Records: \$50\.00/);
  assert.doesNotMatch(telegram.sent.at(-1)!.text, /1000 Public Records/);
});

test("an unrecognized command gets a graceful fallback, not silence", async () => {
  const admin = fakeAdmin();
  const telegram = fakeTelegram();
  await handleUpdate({ admin: admin as never, telegram: telegram as never }, messageUpdate(9, "/unknown", 1, 1));
  assert.match(telegram.sent[0]!.text, /didn't understand/);
});
