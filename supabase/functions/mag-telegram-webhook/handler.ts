/** Pure, testable routing logic for the Telegram webhook -- no Deno.serve,
 * no Deno-specific imports, so this is unit-testable under Node exactly
 * like the other _shared modules. index.ts is the thin Deno wrapper that
 * validates the request and constructs real clients, then calls
 * handleUpdate. See docs/TELEGRAM_WEBHOOK_MIGRATION.md for the route matrix
 * and remaining cutover gate. */

// @ts-ignore Deno source import
import { isAlreadyProcessed, loadSession, markProcessed, saveSession } from "../_shared/session-store.ts";
// @ts-ignore Deno source import
import type { TelegramClient } from "../_shared/telegram.ts";

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

const MAIN_MENU = [[{ text: "Start an order", callback_data: "order:begin" }], [{ text: "Order status", callback_data: "menu:status" }, { text: "Pricing", callback_data: "menu:pricing" }]];
const PUBLIC_RECORDS = new Set(["PR500", "PR1000", "PR1500", "PR2500", "PR5000"]);
const MAX_PROFILES_PER_ORDER = 25; // Python's current default; make project configuration explicit before cutover.
const COUNT_MENU = [
  [1, 2, 3].map((n) => ({ text: String(n), callback_data: `order:count:${n}` })),
  [4, 5].map((n) => ({ text: String(n), callback_data: `order:count:${n}` })).concat([{ text: "Other", callback_data: "order:count:other" }]),
];

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
  const existing = await loadSession(deps.admin, telegramUserId, "CUSTOMER_ORDER");
  if (!existing) await saveSession(deps.admin, { telegramUserId, sessionScope: "CUSTOMER_ORDER", chatId, currentFlow: "MAIN_MENU", currentStep: null, context: {}, orderId: null, lastUpdateId: null });
  await deps.telegram.sendMessage(chatId, "Welcome to MAGHausPR. What would you like to do?", { replyMarkup: MAIN_MENU });
}

async function handleAdminCommand(deps: WebhookDeps, chatId: number, telegramUserId: number): Promise<void> {
  if (!(await isActiveAdmin(deps, telegramUserId))) {
    await deps.telegram.sendMessage(chatId, "This command is restricted.");
    return;
  }
  await deps.telegram.sendMessage(chatId, "MAGHausPR Admin Dashboard: choose an operational area.", { replyMarkup: [
    [{ text: "Payment Review", callback_data: "admin:list:PAYMENT_REVIEW" }, { text: "Pending", callback_data: "admin:list:PENDING" }],
    [{ text: "Processing", callback_data: "admin:list:PROCESSING" }, { text: "Completed", callback_data: "admin:list:COMPLETED" }],
    [{ text: "Find Order", callback_data: "admin:find" }],
  ] });
}

const ADMIN_LIST_STATUSES = new Set(["PAYMENT_REVIEW", "PENDING", "PROCESSING", "COMPLETED"]);

async function showAdminOrder(deps: WebhookDeps, chatId: number, orderId: string): Promise<void> {
  const { data: order, error } = await deps.admin.from("mag_orders")
    .select("id,order_number,service_type,status,payment_status,total,payment_method")
    .eq("id", orderId).maybeSingle();
  if (error) throw error;
  if (!order) { await deps.telegram.sendMessage(chatId, "Order not found."); return; }
  await deps.telegram.sendMessage(chatId, `${order.order_number ?? "(pending number)"}\nService: ${order.service_type}\nPayment: ${order.payment_status}\nProfile: ${order.status}\nTotal: $${(Number(order.total) / 100).toFixed(2)}\nMethod: ${order.payment_method ?? "Not selected"}\nSensitive intake is not shown here.`, { replyMarkup: [
    [{ text: "Status History", callback_data: `admin:history:${order.id}` }],
    [{ text: "Admin Dashboard", callback_data: "admin:home" }],
  ] });
}

async function handleAdminSearch(deps: WebhookDeps, chatId: number, telegramUserId: number, orderNumber: string): Promise<void> {
  if (!(await isActiveAdmin(deps, telegramUserId))) { await deps.telegram.sendMessage(chatId, "This command is restricted."); return; }
  const { data: order, error } = await deps.admin.from("mag_orders").select("id").eq("order_number", orderNumber.trim().toUpperCase()).maybeSingle();
  if (error) throw error;
  if (order) await showAdminOrder(deps, chatId, order.id);
  else await deps.telegram.sendMessage(chatId, "Order not found.");
  const session = await loadSession(deps.admin, telegramUserId, "ADMIN");
  if (session?.currentStep === "FIND_ORDER") await saveSession(deps.admin, { ...session, currentStep: null, context: {} });
}

async function handleAdminCallback(deps: WebhookDeps, chatId: number, telegramUserId: number, callbackQueryId: string, data: string): Promise<void> {
  await deps.telegram.answerCallbackQuery(callbackQueryId);
  if (!(await isActiveAdmin(deps, telegramUserId))) { await deps.telegram.sendMessage(chatId, "This action is restricted."); return; }
  if (data === "admin:home") { await handleAdminCommand(deps, chatId, telegramUserId); return; }
  if (data === "admin:find") {
    await saveSession(deps.admin, { telegramUserId, sessionScope: "ADMIN", chatId, currentFlow: "ADMIN", currentStep: "FIND_ORDER", context: {}, orderId: null, lastUpdateId: null });
    await deps.telegram.sendMessage(chatId, "Enter the order number to find.");
    return;
  }
  if (data.startsWith("admin:list:")) {
    const status = data.slice("admin:list:".length);
    if (!ADMIN_LIST_STATUSES.has(status)) { await deps.telegram.sendMessage(chatId, "That order list is unavailable."); return; }
    const { data: orders, error } = await deps.admin.from("mag_orders").select("id,order_number,total")
      .eq("payment_status", status).order("created_at", { ascending: false }).limit(15);
    if (error) throw error;
    const rows = (orders ?? []).map((order: { id: string; order_number: string | null; total: number }) => [
      { text: `${order.order_number ?? "(pending number)"} · $${(order.total / 100).toFixed(2)}`, callback_data: `admin:view:${order.id}` },
    ]);
    rows.push([{ text: "Admin Dashboard", callback_data: "admin:home" }]);
    await deps.telegram.sendMessage(chatId, `${status.replaceAll("_", " ")}: ${orders?.length ?? 0} recent order(s).`, { replyMarkup: rows });
    return;
  }
  if (data.startsWith("admin:view:")) { await showAdminOrder(deps, chatId, data.slice("admin:view:".length)); return; }
  if (data.startsWith("admin:history:")) {
    const orderId = data.slice("admin:history:".length);
    const { data: rows, error } = await deps.admin.from("mag_order_status_history")
      .select("previous_status,new_status,reason,created_at").eq("order_id", orderId).order("created_at", { ascending: false }).limit(20);
    if (error) throw error;
    const lines = (rows ?? []).map((row: { previous_status: string | null; new_status: string; created_at: string }) => `${row.previous_status ?? "Created"} → ${row.new_status} (${row.created_at})`);
    await deps.telegram.sendMessage(chatId, lines.length ? `Order history:\n${lines.join("\n")}` : "No status history found.");
    return;
  }
  await deps.telegram.sendMessage(chatId, "That admin action is not available yet.");
}

async function handleOrderBegin(deps: WebhookDeps, chatId: number, telegramUserId: number, callbackQueryId: string): Promise<void> {
  await deps.telegram.answerCallbackQuery(callbackQueryId);
  const { data: products, error } = await deps.admin.from("mag_products").select("code,name,standard_price,availability").eq("active", true).order("standard_price", { ascending: true });
  if (error) throw error;
  if (!products?.length) {
    await deps.telegram.sendMessage(chatId, "No services are configured yet. Please check back soon.");
    return;
  }
  const keyboard = products.filter((p: { code: string; availability?: string }) => p.code !== "EMAIL_CONFIRMATION" && p.availability !== "DISABLED")
    .map((p: { code: string; name: string; standard_price: number; availability?: string }) => [{
      text: p.availability === "COMING_SOON" ? `${p.name} - Coming Soon` : `${p.name} - $${(p.standard_price / 100).toFixed(2)}`,
      callback_data: `order:service:${p.code}`,
    }]);
  await saveSession(deps.admin, { telegramUserId, sessionScope: "CUSTOMER_ORDER", chatId, currentFlow: "ORDER", currentStep: "SELECT_SERVICE", context: {}, orderId: null, lastUpdateId: null });
  await deps.telegram.sendMessage(chatId, "Choose a service:", { replyMarkup: keyboard });
}

async function handleServiceSelection(deps: WebhookDeps, chatId: number, telegramUserId: number, callbackQueryId: string, code: string): Promise<void> {
  await deps.telegram.answerCallbackQuery(callbackQueryId);
  const session = await loadSession(deps.admin, telegramUserId, "CUSTOMER_ORDER");
  if (session?.currentFlow !== "ORDER" || session.currentStep !== "SELECT_SERVICE") {
    await deps.telegram.sendMessage(chatId, "That selection has expired. Choose a service again.", { replyMarkup: [[{ text: "Services", callback_data: "order:begin" }]] });
    return;
  }
  const { data: product, error } = await deps.admin.from("mag_products").select("code,name,active,availability").eq("code", code).maybeSingle();
  if (error) throw error;
  if (!product || !product.active || product.availability === "DISABLED" || code === "EMAIL_CONFIRMATION") {
    await deps.telegram.sendMessage(chatId, "That service is not currently available.", { replyMarkup: [[{ text: "Services", callback_data: "order:begin" }]] });
    return;
  }
  if (product.availability === "COMING_SOON") {
    await deps.telegram.sendMessage(chatId, "That package is coming soon. Choose another service.", { replyMarkup: [[{ text: "Services", callback_data: "order:begin" }]] });
    return;
  }
  await saveSession(deps.admin, { ...session, currentStep: "PROFILE_COUNT", context: { serviceCode: code } });
  await deps.telegram.sendMessage(chatId, `${product.name}: how many profiles are you ordering for?`, { replyMarkup: COUNT_MENU });
}

async function selectProfileCount(deps: WebhookDeps, chatId: number, telegramUserId: number, raw: string, callbackQueryId?: string): Promise<void> {
  if (callbackQueryId) await deps.telegram.answerCallbackQuery(callbackQueryId);
  const session = await loadSession(deps.admin, telegramUserId, "CUSTOMER_ORDER");
  if (session?.currentFlow !== "ORDER" || !["PROFILE_COUNT", "PROFILE_COUNT_CUSTOM"].includes(session.currentStep ?? "")) {
    await deps.telegram.sendMessage(chatId, "Choose a package before selecting the profile count.", { replyMarkup: [[{ text: "Services", callback_data: "order:begin" }]] });
    return;
  }
  if (raw === "other" && callbackQueryId) {
    await saveSession(deps.admin, { ...session, currentStep: "PROFILE_COUNT_CUSTOM" });
    await deps.telegram.sendMessage(chatId, `Enter the number of profiles (1–${MAX_PROFILES_PER_ORDER}).`);
    return;
  }
  if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > MAX_PROFILES_PER_ORDER) {
    await deps.telegram.sendMessage(chatId, `Enter a whole number from 1 to ${MAX_PROFILES_PER_ORDER}.`);
    return;
  }
  const serviceCode = session.context.serviceCode;
  if (typeof serviceCode !== "string") throw new Error("ORDER_SESSION_SERVICE_MISSING");
  await saveSession(deps.admin, { ...session, currentStep: PUBLIC_RECORDS.has(serviceCode) ? "ADDON_MODE" : "INTAKE_PENDING", context: { ...session.context, profileCount: Number(raw) } });
  if (PUBLIC_RECORDS.has(serviceCode)) {
    await deps.telegram.sendMessage(chatId, "Email Confirmation add-on: choose how it should apply.", { replyMarkup: [
      [{ text: "No", callback_data: "order:addon:none" }],
      [{ text: "Add to All Profiles", callback_data: "order:addon:all" }],
      [{ text: "Choose Profiles Individually", callback_data: "order:addon:individual" }],
    ] });
  } else {
    await deps.telegram.sendMessage(chatId, "Profile count saved. The next step is customer intake.");
  }
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

async function handleStatusLookup(deps: WebhookDeps, chatId: number, telegramUserId: number, orderNumber: string): Promise<void> {
  const { data: customer, error: customerError } = await deps.admin.from("mag_customers").select("id").eq("telegram_user_id", telegramUserId).maybeSingle();
  if (customerError) throw customerError;
  const { data: order, error } = customer
    ? await deps.admin.from("mag_orders").select("order_number,payment_status,status").eq("customer_id", customer.id).eq("order_number", orderNumber.trim().toUpperCase()).maybeSingle()
    : { data: null, error: null };
  if (error) throw error;
  if (!order) await deps.telegram.sendMessage(chatId, "That order was not found for your Telegram account.", { replyMarkup: MAIN_MENU });
  else await deps.telegram.sendMessage(chatId, `${order.order_number}: ${order.payment_status} / ${order.status}`, { replyMarkup: MAIN_MENU });
  const session = await loadSession(deps.admin, telegramUserId, "CUSTOMER_ORDER");
  if (session?.currentStep === "STATUS_LOOKUP") await saveSession(deps.admin, { ...session, currentFlow: "MAIN_MENU", currentStep: null, context: {} });
}

async function handlePricing(deps: WebhookDeps, chatId: number, callbackQueryId: string): Promise<void> {
  await deps.telegram.answerCallbackQuery(callbackQueryId);
  const { data: products, error } = await deps.admin.from("mag_products").select("name,standard_price,active,availability").eq("active", true).order("standard_price", { ascending: true });
  if (error) throw error;
  const lines = (products ?? []).filter((p: { availability?: string }) => p.availability !== "DISABLED")
    .map((p: { name: string; standard_price: number; availability?: string }) => `${p.name}: ${p.availability === "COMING_SOON" ? "Coming Soon" : `$${(p.standard_price / 100).toFixed(2)} per profile`}`);
  await deps.telegram.sendMessage(chatId, lines.length ? `MAGHausPR Pricing\n${lines.join("\n")}` : "No services are configured yet.", { replyMarkup: [[{ text: "Main Menu", callback_data: "menu:start" }]] });
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
    else if (text && (await loadSession(deps.admin, from.id, "ADMIN"))?.currentStep === "FIND_ORDER") await handleAdminSearch(deps, chat.id, from.id, text);
    else if (text) {
      const session = await loadSession(deps.admin, from.id, "CUSTOMER_ORDER");
      if (session?.currentStep === "PROFILE_COUNT_CUSTOM") await selectProfileCount(deps, chat.id, from.id, text.trim());
      else if (session?.currentStep === "STATUS_LOOKUP") await handleStatusLookup(deps, chat.id, from.id, text);
      else await handleFallback(deps, chat.id);
    }
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
    if (data?.startsWith("admin:")) await handleAdminCallback(deps, message.chat.id, from.id, callbackQueryId, data);
    else if (data === "menu:start") { await deps.telegram.answerCallbackQuery(callbackQueryId); await handleStart(deps, message.chat.id, from.id, undefined); }
    else if (data === "menu:status") { await deps.telegram.answerCallbackQuery(callbackQueryId); await deps.telegram.sendMessage(message.chat.id, "Check order status:", { replyMarkup: [[{ text: "Recent Orders", callback_data: "status:recent" }, { text: "Order Number Lookup", callback_data: "status:lookup" }]] }); }
    else if (data === "menu:pricing") await handlePricing(deps, message.chat.id, callbackQueryId);
    else if (data === "status:recent") await handleOrderStatus(deps, message.chat.id, from.id, callbackQueryId);
    else if (data === "status:lookup") { await deps.telegram.answerCallbackQuery(callbackQueryId); await saveSession(deps.admin, { telegramUserId: from.id, sessionScope: "CUSTOMER_ORDER", chatId: message.chat.id, currentFlow: "STATUS", currentStep: "STATUS_LOOKUP", context: {}, orderId: null, lastUpdateId: update.update_id }); await deps.telegram.sendMessage(message.chat.id, "Enter your order number, for example MAGHP-000123."); }
    else if (data === "order:begin") await handleOrderBegin(deps, message.chat.id, from.id, callbackQueryId);
    else if (data === "order:status") await handleOrderStatus(deps, message.chat.id, from.id, callbackQueryId);
    else if (data?.startsWith("order:service:")) await handleServiceSelection(deps, message.chat.id, from.id, callbackQueryId, data.slice("order:service:".length));
    else if (data?.startsWith("order:count:")) await selectProfileCount(deps, message.chat.id, from.id, data.slice("order:count:".length), callbackQueryId);
    else {
      await deps.telegram.answerCallbackQuery(callbackQueryId, { text: "Not available yet." });
      await handleFallback(deps, message.chat.id);
    }
    await markProcessed(deps.admin, callbackQueryId, "CALLBACK", from.id, data ?? null);
    await markProcessed(deps.admin, updateKey, "UPDATE", updateActorId, data ?? null);
  }
}
