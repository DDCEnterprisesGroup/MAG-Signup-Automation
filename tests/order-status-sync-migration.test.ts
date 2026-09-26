import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migration = () => readFile(path.join(root, "supabase/migrations/20260926211028_order_status_sync_completion_archive.sql"), "utf8");
const edgeFunction = () => readFile(path.join(root, "supabase/functions/mag-order-status/index.ts"), "utf8");

test("completion stamps mag_orders and archives only the order's linked customer profiles", async () => {
  const sql = await migration();
  assert.match(sql, /completed_at = case when p_new_status = 'COMPLETED' then coalesce\(p_occurred_at, now\(\)\)/);
  assert.match(sql, /set payment_status = p_new_status/);
  const archive = sql.slice(sql.indexOf("update public.mag_profiles"), sql.indexOf("get diagnostics"));
  assert.match(archive, /set status = 'ARCHIVED', archived_at = now\(\)/);
  assert.match(archive, /where order_id = v_order\.id/);
  assert.match(archive, /profile_scope = 'CUSTOMER'/);
  assert.doesNotMatch(archive, /customer_id|external_profile_id/, "never archive by customer or shared external id");
});

test("status sync is idempotent, never moves an order backwards, and is service-role only", async () => {
  const sql = await migration();
  assert.match(sql, /where external_event_id = trim\(p_external_event_id\)/);
  assert.match(sql, /order_payment_rank\(v_order\.payment_status\) < 5/);
  assert.match(sql, /order_payment_rank\(p_new_status\) > mag_private\.order_payment_rank\(v_order\.payment_status\)/);
  assert.match(sql, /revoke all on function public\.mag_sync_order_status\(text,text,text,text,text,uuid,timestamptz\)\s+from public, anon, authenticated;/);
  assert.match(sql, /grant execute on function public\.mag_sync_order_status\(text,text,text,text,text,uuid,timestamptz\)\s+to service_role;/);
  assert.match(sql, /'paymentStatus', p_new_status/, "bot contract: success echoes the event status");
});

test("mag-order-status requires an authorized MAG member and keeps the bot contract", async () => {
  const source = await edgeFunction();
  assert.match(source, /\["OWNER", "ADMIN", "SERVICE"\]\.includes\(membership\.role\)/);
  assert.match(source, /admin\.rpc\("mag_sync_order_status"/);
  assert.match(source, /data\.paymentStatus !== payload\.newStatus/);
  const config = await readFile(path.join(root, "supabase/config.toml"), "utf8");
  assert.match(config, /\[functions\.mag-order-status\]\nverify_jwt = true/);
});
