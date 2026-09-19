import { createClient } from "npm:@supabase/supabase-js@2.116.0";
import { json } from "../_shared/http.ts";
import { TelegramClient } from "../_shared/telegram.ts";
import { handleUpdate, type TelegramUpdate } from "./handler.ts";

// Telegram sets this header to the exact value configured via setWebhook's
// secret_token parameter on every request. It is the only way to verify a
// request actually came from Telegram (Telegram webhooks are otherwise
// unauthenticated by design). Configure with:
//   curl -X POST "https://api.telegram.org/bot$TOKEN/setWebhook" \
//     -d url=... -d secret_token=$TELEGRAM_WEBHOOK_SECRET
const WEBHOOK_SECRET = Deno.env.get("TELEGRAM_WEBHOOK_SECRET")!;
const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "METHOD_NOT_ALLOWED" }, 405);
  const secretHeader = req.headers.get("X-Telegram-Bot-Api-Secret-Token");
  if (!WEBHOOK_SECRET || secretHeader !== WEBHOOK_SECRET) return json({ error: "UNAUTHORIZED" }, 401);

  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const telegram = new TelegramClient({ botToken: BOT_TOKEN });

  let update: TelegramUpdate;
  try {
    update = await req.json();
  } catch {
    // Malformed body is not something a retry will fix -- ack so Telegram stops resending it.
    return json({ ok: true });
  }

  try {
    await handleUpdate({ admin, telegram }, update);
    return json({ ok: true });
  } catch (error) {
    // Do NOT log the full update (may contain customer-entered text/PII) -- only the update_id and error type.
    console.error("mag-telegram-webhook failed", { updateId: update.update_id, error: error instanceof Error ? error.message : "UNKNOWN" });
    // 500 lets Telegram retry. handleUpdate only marks an update_id processed
    // AFTER its side effects succeed, so a failure here leaves it unmarked and
    // the retry will actually redo the work, not silently no-op.
    return json({ error: "INTERNAL_ERROR" }, 500);
  }
});
