import assert from "node:assert/strict";
import test from "node:test";
import { handleUpdate, type TelegramUpdate } from "../supabase/functions/mag-telegram-webhook/handler.js";

interface Row { [key: string]: unknown }

function fakeAdmin(seed: { admins?: Row[]; products?: Row[]; customers?: Row[]; orders?: Row[] } = {}) {
  const tables: Record<string, Row[]> = {
    mag_telegram_admins: seed.admins ?? [],
    mag_products: seed.products ?? [],
    mag_customers: seed.customers ?? [],
    mag_orders: seed.orders ?? [],
    mag_telegram_sessions: [],
    mag_telegram_processed_updates: [],
  };
  let nextId = 1;

  function selectBuilder(table: string, rows: Row[]) {
    const applyEq: Array<[string, unknown]> = [];
    const api = {
      eq(col: string, val: unknown) { applyEq.push([col, val]); return api; },
      order() { return api; },
      limit(n: number) { rows = rows.slice(0, n); return api; },
      async maybeSingle() {
        const row = rows.find((r) => applyEq.every(([c, v]) => r[c] === v)) ?? null;
        return { data: row, error: null };
      },
      then(resolve: (v: { data: Row[]; error: null }) => unknown) {
        const filtered = rows.filter((r) => applyEq.every(([c, v]) => r[c] === v));
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
  assert.match(telegram.sent[0]!.text, /Admin dashboard/);
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

test("order:status reports recent orders for a known customer and a friendly message for none", async () => {
  const admin = fakeAdmin({
    customers: [{ id: "cust-1", telegram_user_id: 55 }],
    orders: [{ order_number: "MAGHP-000001", payment_status: "AWAITING_PAYMENT", status: "DRAFT", customer_id: "cust-1" }],
  });
  const telegram = fakeTelegram();
  await handleUpdate({ admin: admin as never, telegram: telegram as never }, callbackUpdate(8, "order:status", "cb-2", 55, 55));
  assert.match(telegram.sent[0]!.text, /MAGHP-000001: AWAITING_PAYMENT \/ DRAFT/);
});

test("an unrecognized command gets a graceful fallback, not silence", async () => {
  const admin = fakeAdmin();
  const telegram = fakeTelegram();
  await handleUpdate({ admin: admin as never, telegram: telegram as never }, messageUpdate(9, "/unknown", 1, 1));
  assert.match(telegram.sent[0]!.text, /didn't understand/);
});
