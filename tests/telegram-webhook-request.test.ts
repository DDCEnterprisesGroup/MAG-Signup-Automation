import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { handleTelegramWebhookRequest } from "../supabase/functions/mag-telegram-webhook/request.js";

const secret = "synthetic-telegram-secret";
const body = JSON.stringify({ update_id: 37, message: { message_id: 1, text: "/start", chat: { id: 1 }, from: { id: 1 } } });
const request = (header?: string) => new Request("https://example.invalid/functions/v1/mag-telegram-webhook", {
  method: "POST", headers: header === undefined ? {} : { "X-Telegram-Bot-Api-Secret-Token": header }, body,
});

test("only the Telegram webhook bypasses gateway JWT verification", () => {
  const config = readFileSync(new URL("../supabase/config.toml", import.meta.url), "utf8");
  for (const name of ["mag-order-intake", "mag-profile-review", "mag-restricted-value"]) {
    assert.match(config, new RegExp(`\\[functions\\.${name}\\]\\s*verify_jwt = true`));
  }
  assert.match(config, /\[functions\.mag-telegram-webhook\]\s*verify_jwt = false/);
});

test("missing and invalid Telegram secrets are rejected before routing", async () => {
  let routes = 0;
  const route = async () => { routes += 1; };
  assert.equal((await handleTelegramWebhookRequest(request(), secret, route)).status, 401);
  assert.equal((await handleTelegramWebhookRequest(request("wrong"), secret, route)).status, 401);
  assert.equal((await handleTelegramWebhookRequest(request(secret), "", route)).status, 401);
  assert.equal(routes, 0);
});

test("a valid Telegram secret reaches routing; a failure returns a retryable error", async () => {
  let routedId = -1;
  const ok = await handleTelegramWebhookRequest(request(secret), secret, async (update) => { routedId = update.update_id; });
  assert.equal(ok.status, 200);
  assert.equal(routedId, 37);
  const originalError = console.error;
  console.error = () => undefined;
  try {
    const failed = await handleTelegramWebhookRequest(request(secret), secret, async () => { throw new Error("synthetic failure"); });
    assert.equal(failed.status, 500);
  } finally {
    console.error = originalError;
  }
});
