// Deno Edge Functions resolve source .ts imports; the repo's NodeNext test
// compiler does not enable that extension mode.
// @ts-ignore Deno source import
import { json } from "../_shared/http.ts";
// @ts-ignore Deno source import
import type { TelegramUpdate } from "./handler.ts";

/** Gateway-independent request boundary. Construct clients only inside route. */
export async function handleTelegramWebhookRequest(
  req: Request,
  secret: string,
  route: (update: TelegramUpdate) => Promise<void>,
): Promise<Response> {
  if (req.method !== "POST") return json({ error: "METHOD_NOT_ALLOWED" }, 405);
  if (!secret || req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== secret) {
    return json({ error: "UNAUTHORIZED" }, 401);
  }

  let update: TelegramUpdate;
  try {
    update = await req.json();
  } catch {
    // A malformed body will not improve on Telegram retry.
    return json({ ok: true });
  }
  if (!Number.isSafeInteger(update?.update_id) || update.update_id < 0) {
    return json({ error: "INVALID_UPDATE" }, 400);
  }

  try {
    await route(update);
    return json({ ok: true });
  } catch (error) {
    // Never log an update body or an error message, which may contain PII.
    console.error("mag-telegram-webhook failed", { updateId: update.update_id, errorType: error instanceof Error ? error.name : "UNKNOWN" });
    return json({ error: "INTERNAL_ERROR" }, 500);
  }
}
