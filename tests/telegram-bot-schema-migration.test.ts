import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationPath = path.join(root, "supabase/migrations/20260919120000_mag_telegram_bot_schema.sql");

async function readMigration(): Promise<string> {
  return readFile(migrationPath, "utf8");
}

const NEW_TABLES = [
  "mag_telegram_admins", "mag_telegram_sessions", "mag_telegram_processed_updates",
  "mag_products", "mag_promotions", "mag_promotion_products", "mag_order_items",
  "mag_payment_settings", "mag_payment_proofs", "mag_order_status_history", "mag_reviews",
  "mag_affiliates", "mag_affiliate_commission_rates", "mag_referral_attributions",
  "mag_affiliate_payouts", "mag_affiliate_commissions", "mag_affiliate_audit",
];

test("migration is present and creates every reconciled table", async () => {
  const sql = await readMigration();
  assert.ok(sql.trim().length > 0);
  for (const table of NEW_TABLES) {
    assert.match(sql, new RegExp(`create table public\\.${table} \\(`), `expected CREATE TABLE for ${table}`);
  }
});

test("every new table has RLS enabled", async () => {
  const sql = await readMigration();
  for (const table of NEW_TABLES) {
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security;`), `expected RLS enabled on ${table}`);
  }
});

test("no table grants select/insert/update/delete to anon", async () => {
  const sql = await readMigration();
  assert.doesNotMatch(sql, /to anon\b/, "no grant statement in this migration should target anon");
});

test("catalog/commerce tables are staff-read (authenticated) and service_role-write only", async () => {
  const sql = await readMigration();
  // mag_affiliate_audit intentionally uses the existing "_admin_read" naming
  // (matching mag_audit_admin_read) rather than "_staff_read", since it's
  // admin-only, not staff-readable.
  const catalogTables = NEW_TABLES.filter((t) => !t.startsWith("mag_telegram_") && t !== "mag_affiliate_audit");
  for (const table of catalogTables) {
    assert.match(sql, new RegExp(`create policy ${table}_staff_read on public\\.${table} for select to authenticated`), `expected a staff-read policy on ${table}`);
  }
  assert.match(sql, /create policy mag_affiliate_audit_admin_read on public\.mag_affiliate_audit for select to authenticated/);
  // Telegram-only operational tables get no authenticated policy at all -- service_role only.
  for (const table of ["mag_telegram_admins", "mag_telegram_sessions", "mag_telegram_processed_updates"]) {
    assert.doesNotMatch(sql, new RegExp(`create policy \\w+ on public\\.${table}`), `${table} must have no authenticated-facing policy`);
  }
});

test("customer-order, affiliate-admin, and admin sessions cannot collide for the same telegram user", async () => {
  const sql = await readMigration();
  assert.match(sql, /primary key \(telegram_user_id, session_scope\)/);
  assert.match(sql, /session_scope text not null default 'CUSTOMER_ORDER' check \(session_scope in \('CUSTOMER_ORDER', 'AFFILIATE_ADMIN', 'ADMIN'\)\)/);
});

test("idempotency table covers both whole-update and per-callback replay", async () => {
  const sql = await readMigration();
  assert.match(sql, /idempotency_key text primary key/);
  assert.match(sql, /kind text not null check \(kind in \('UPDATE', 'CALLBACK'\)\)/);
});

test("every dual-actor column forbids setting both the auth-user and telegram-user side", async () => {
  const sql = await readMigration();
  const checks = (sql.match(/check \(\s*\n?\s*\w+_auth_user_id is null or \w+_telegram_user_id is null\s*\n?\s*\)/g) || []).length;
  assert.ok(checks >= 5, `expected at least 5 not-both-actors constraints, found ${checks}`);
});

test("partial unique indexes are preserved from the SQLite sqlite_where design", async () => {
  const sql = await readMigration();
  assert.match(sql, /create unique index mag_global_commission_rate_idx on public\.mag_affiliate_commission_rates\(product_id\) where affiliate_id is null;/);
  assert.match(sql, /create unique index mag_live_commission_line_idx on public\.mag_affiliate_commissions\(order_id, profile_id, product_id\) where status != 'VOID';/);
});

test("referral code case-insensitive uniqueness ports SQLite's NOCASE collation", async () => {
  const sql = await readMigration();
  assert.match(sql, /create unique index mag_affiliates_referral_code_ci_idx on public\.mag_affiliates \(lower\(referral_code\)\);/);
});

test("mag_customers and mag_orders are extended, not duplicated", async () => {
  const sql = await readMigration();
  assert.match(sql, /alter table public\.mag_customers\s*\n\s*add column telegram_user_id bigint unique/);
  assert.match(sql, /alter table public\.mag_orders\s*\n\s*add column order_number text unique/);
  assert.doesNotMatch(sql, /create table public\.mag_customers/, "mag_customers already exists; this migration must only alter it");
  assert.doesNotMatch(sql, /create table public\.mag_orders/, "mag_orders already exists; this migration must only alter it");
});

test("migration never embeds a credential, token, or real key", async () => {
  const sql = await readMigration();
  const credentialPattern = /password\s*(:=|=)|passwd\s*=|api[_-]?key\s*(:=|=)\s*['"a-z0-9]|BEGIN (RSA|OPENSSH|PRIVATE)|service_role_key\s*(:=|=)/i;
  assert.doesNotMatch(sql, credentialPattern);
});
