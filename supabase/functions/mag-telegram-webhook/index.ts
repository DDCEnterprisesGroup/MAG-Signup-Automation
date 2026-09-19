import { createClient } from "npm:@supabase/supabase-js@2.116.0";
import { TelegramClient } from "../_shared/telegram.ts";
import { handleUpdate } from "./handler.ts";
import { handleTelegramWebhookRequest } from "./request.ts";

// Telegram sets this header to the exact value configured via setWebhook's
// secret_token parameter on every request. It is the only way to verify a
// request actually came from Telegram (Telegram webhooks are otherwise
// unauthenticated by design). Configure with:
//   curl -X POST "https://api.telegram.org/bot$TOKEN/setWebhook" \
//     -d url=... -d secret_token=$TELEGRAM_WEBHOOK_SECRET
const WEBHOOK_SECRET = Deno.env.get("TELEGRAM_WEBHOOK_SECRET")!;
const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;

Deno.serve(async (req) => {
  return handleTelegramWebhookRequest(req, WEBHOOK_SECRET, async (update) => {
    const url = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const telegram = new TelegramClient({ botToken: BOT_TOKEN });
    await handleUpdate({ admin, telegram }, update);
  });
});
