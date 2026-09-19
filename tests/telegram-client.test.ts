import assert from "node:assert/strict";
import test from "node:test";
import { TelegramClient } from "../supabase/functions/_shared/telegram.js";

function fakeFetch(responses: Array<{ ok: boolean; result?: unknown; description?: string; error_code?: number }>) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
    const next = responses.shift()!;
    return new Response(JSON.stringify(next), { status: next.ok ? 200 : 400 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

test("sendMessage posts to the correct bot-token URL with chat_id and text", async () => {
  const { fetchImpl, calls } = fakeFetch([{ ok: true, result: { message_id: 42 } }]);
  const client = new TelegramClient({ botToken: "<test-token>", fetchImpl });
  const result = await client.sendMessage(123, "hello");
  assert.equal(result.message_id, 42);
  assert.equal(calls[0]!.url, "https://api.telegram.org/bot<test-token>/sendMessage");
  assert.equal(calls[0]!.body.chat_id, 123);
  assert.equal(calls[0]!.body.text, "hello");
});

test("sendMessage truncates text to Telegram's 4096-character limit", async () => {
  const { fetchImpl, calls } = fakeFetch([{ ok: true, result: { message_id: 1 } }]);
  const client = new TelegramClient({ botToken: "<test-token>", fetchImpl });
  await client.sendMessage(1, "x".repeat(5000));
  assert.equal((calls[0]!.body.text as string).length, 4096);
});

test("sendMessage with a reply keyboard sends inline_keyboard in the expected shape", async () => {
  const { fetchImpl, calls } = fakeFetch([{ ok: true, result: { message_id: 1 } }]);
  const client = new TelegramClient({ botToken: "<test-token>", fetchImpl });
  await client.sendMessage(1, "pick one", { replyMarkup: [[{ text: "A", callback_data: "a" }, { text: "B", callback_data: "b" }]] });
  assert.deepEqual(calls[0]!.body.reply_markup, { inline_keyboard: [[{ text: "A", callback_data: "a" }, { text: "B", callback_data: "b" }]] });
});

test("a non-ok Telegram response throws with the Telegram-provided description", async () => {
  const { fetchImpl } = fakeFetch([{ ok: false, description: "Bad Request: chat not found", error_code: 400 }]);
  const client = new TelegramClient({ botToken: "<test-token>", fetchImpl });
  await assert.rejects(() => client.sendMessage(999, "hi"), /chat not found/);
});

test("answerCallbackQuery posts the callback_query_id", async () => {
  const { fetchImpl, calls } = fakeFetch([{ ok: true, result: true }]);
  const client = new TelegramClient({ botToken: "<test-token>", fetchImpl });
  await client.answerCallbackQuery("cb-1", { text: "Done" });
  assert.equal(calls[0]!.body.callback_query_id, "cb-1");
  assert.equal(calls[0]!.body.text, "Done");
});

test("constructing a client without a bot token fails loudly instead of silently no-op-ing", () => {
  assert.throws(() => new TelegramClient({ botToken: "" }), /requires a bot token/);
});
