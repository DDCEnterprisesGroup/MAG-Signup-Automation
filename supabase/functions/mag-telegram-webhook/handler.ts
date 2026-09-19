/** Pure, testable routing logic for the Telegram webhook -- no Deno.serve,
 * no Deno-specific imports, so this is unit-testable under Node exactly
 * like the other _shared modules. index.ts is the thin Deno wrapper that
 * validates the request and constructs real clients, then calls
 * handleUpdate. See docs/TELEGRAM_WEBHOOK_MIGRATION.md for scope: this
 * covers /start, a minimal catalog-read order kickoff, and /admin
 * authorization -- the full ordering/payment/promotions/affiliates/reviews
 * wizards are not ported yet (tracked there as remaining work). */

import { isAlreadyProcessed, markProcessed, saveSession } from "../_shared/session-store.js";
import type { TelegramClient } from "../_shared/telegram.js";

/* eslint-disable @typescript-eslint/no-explicit-any -- admin is a supabase-js client; see _shared/order-intake.ts for the same rationale. */
export interface WebhookDeps {
  admin: any;
  telegram: TelegramClient;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface TelegramUpdate {
  update_id: number;
  message?: { message_id: number; text?: string; chat: { id: number }; from: { id: number } };
  callback_query?: { id: string; data?: string; message?: { message_id: number; chat: { id: number } }; from: { id: number } };
}

const MAIN_MENU = [[{ text: "Start an order", callback_data: "order:begin" }], [{ text: "Order status", callback_data: "order:status" }]];

async function isActiveAdmin(deps: WebhookDeps, telegramUserId: number): Promise<boolean> {
  const { data } = await deps.admin.from("mag_telegram_admins").select("active").eq("telegram_user_id", telegramUserId).maybeSingle();
  return Boolean(data?.active);
}

async function ensureCustomer(deps: WebhookDeps, telegramUserId: number, telegramUsername: string | undefined, displayName: string): Promise<string> {
  const { data, error } = await deps.admin.from("mag_customers").upsert({
    scope: "CUSTOMER",
    telegram_user_id: telegramUserId,
    telegram_username: telegramUsername ?? null,
    display_name: displayName,
    normalized_name: displayName.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(),
  }, { onConflict: "telegram_user_id" }).select().single();
  if (error) throw error;
  return data.id as string;
}

async function handleStart(deps: WebhookDeps, chatId: number, telegramUserId: number, telegramUsername: string | undefined): Promise<void> {
  await ensureCustomer(deps, telegramUserId, telegramUsername, telegramUsername ? `@${telegramUsername}` : "MAGHausPR Customer");
  await saveSession(deps.admin, { telegramUserId, sessionScope: "CUSTOMER_ORDER", chatId, currentFlow: "MAIN_MENU", currentStep: null, context: {}, orderId: null, lastUpdateId: null });
  await deps.telegram.sendMessage(chatId, "Welcome to MAGHausPR. What would you like to do?", { replyMarkup: MAIN_MENU });
}

async function handleAdminCommand(deps: WebhookDeps, chatId: number, telegramUserId: number): Promise<void> {
  if (!(await isActiveAdmin(deps, telegramUserId))) {
    await deps.telegram.sendMessage(chatId, "This command is restricted.");
    return;
  }
  await deps.telegram.sendMessage(chatId, "Admin dashboard: order review, promotions, settings, reviews, and affiliates are not yet available through the webhook -- use the existing bot for those until webhook parity is reached.");
}

async function handleOrderBegin(deps: WebhookDeps, chatId: number, telegramUserId: number, callbackQueryId: string): Promise<void> {
  await deps.telegram.answerCallbackQuery(callbackQueryId);
  const { data: products, error } = await deps.admin.from("mag_products").select("code,name,standard_price").eq("active", true).order("standard_price", { ascending: true });
  if (error) throw error;
  if (!products?.length) {
    await deps.telegram.sendMessage(chatId, "No services are configured yet. Please check back soon.");
    return;
  }
  const keyboard = products.map((p: { code: string; name: string; standard_price: number }) => [{ text: `${p.name} - $${(p.standard_price / 100).toFixed(2)}`, callback_data: `order:service:${p.code}` }]);
  await saveSession(deps.admin, { telegramUserId, sessionScope: "CUSTOMER_ORDER", chatId, currentFlow: "ORDER", currentStep: "SELECT_SERVICE", context: {}, orderId: null, lastUpdateId: null });
  await deps.telegram.sendMessage(chatId, "Choose a service:", { replyMarkup: keyboard });
}

async function handleOrderStatus(deps: WebhookDeps, chatId: number, telegramUserId: number, callbackQueryId: string): Promise<void> {
  await deps.telegram.answerCallbackQuery(callbackQueryId);
  const { data: customer } = await deps.admin.from("mag_customers").select("id").eq("telegram_user_id", telegramUserId).maybeSingle();
  if (!customer) {
    await deps.telegram.sendMessage(chatId, "You don't have any orders yet. Send /start to begin one.");
    return;
  }
  const { data: orders, error } = await deps.admin.from("mag_orders").select("order_number,payment_status,status").eq("customer_id", customer.id).order("created_at", { ascending: false }).limit(5);
  if (error) throw error;
  if (!orders?.length) {
    await deps.telegram.sendMessage(chatId, "You don't have any orders yet. Send /start to begin one.");
    return;
  }
  const lines = orders.map((o: { order_number: string | null; payment_status: string; status: string }) => `${o.order_number ?? "(pending number)"}: ${o.payment_status} / ${o.status}`);
  await deps.telegram.sendMessage(chatId, `Your recent orders:\n${lines.join("\n")}`);
}

async function handleFallback(deps: WebhookDeps, chatId: number): Promise<void> {
  await deps.telegram.sendMessage(chatId, "I didn't understand that. Send /start to see what I can do.");
}

export async function handleUpdate(deps: WebhookDeps, update: TelegramUpdate): Promise<void> {
  const updateKey = String(update.update_id);
  const updateActorId = update.message?.from.id ?? update.callback_query?.from.id ?? null;
  if (await isAlreadyProcessed(deps.admin, updateKey, "UPDATE")) return; // Telegram redelivered this update_id -- already fully handled.

  if (update.message) {
    const { text, chat, from } = update.message;
    if (text === "/start") await handleStart(deps, chat.id, from.id, undefined);
    else if (text === "/admin") await handleAdminCommand(deps, chat.id, from.id);
    else await handleFallback(deps, chat.id);
    await markProcessed(deps.admin, updateKey, "UPDATE", updateActorId, text ?? null);
    return;
  }

  if (update.callback_query) {
    const { id: callbackQueryId, data, message, from } = update.callback_query;
    if (!message) return;
    if (await isAlreadyProcessed(deps.admin, callbackQueryId, "CALLBACK")) {
      await deps.telegram.answerCallbackQuery(callbackQueryId);
      await markProcessed(deps.admin, updateKey, "UPDATE", updateActorId, data ?? null);
      return; // double-tapped button -- ack so Telegram clears the loading spinner, but don't reprocess.
    }
    if (data === "order:begin") await handleOrderBegin(deps, message.chat.id, from.id, callbackQueryId);
    else if (data === "order:status") await handleOrderStatus(deps, message.chat.id, from.id, callbackQueryId);
    else {
      await deps.telegram.answerCallbackQuery(callbackQueryId, { text: "Not available yet." });
      await handleFallback(deps, message.chat.id);
    }
    await markProcessed(deps.admin, callbackQueryId, "CALLBACK", from.id, data ?? null);
    await markProcessed(deps.admin, updateKey, "UPDATE", updateActorId, data ?? null);
  }
}
