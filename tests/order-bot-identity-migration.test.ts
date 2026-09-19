import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationPath = path.join(root, "supabase/migrations/20260917114149_mag_v1_1_order_bot_identity.sql");

async function readMigration(): Promise<string> {
  return readFile(migrationPath, "utf8");
}

test("order-bot identity migration is present and non-empty", async () => {
  const sql = await readMigration();
  assert.ok(sql.trim().length > 0, "migration must not be a 0-byte placeholder");
});

test("provisions SERVICE membership without embedding any credential", async () => {
  const sql = await readMigration();
  assert.match(sql, /create or replace function public\.mag_provision_service_membership/);
  assert.match(sql, /role\s*=\s*'SERVICE'|'SERVICE',\s*p_display_name/);
  const credentialPattern = /password\s*(:=|=)|passwd\s*=|api[_-]?key\s*(:=|=)\s*['"a-z0-9]|BEGIN (RSA|OPENSSH|PRIVATE)|service_role_key\s*(:=|=)|@gmail\.com|@outlook\.com/i;
  assert.doesNotMatch(sql, credentialPattern, "migration must never hardcode a real credential or account");
});

test("provisioning and revoke functions are executable only by service_role", async () => {
  const sql = await readMigration();
  for (const fn of ["mag_provision_service_membership(uuid, text)", "mag_revoke_service_membership(uuid)"]) {
    const revokeLine = new RegExp(`revoke all on function public\\.${fn.replace(/[()]/g, "\\$&")} from public, anon, authenticated;`);
    const grantLine = new RegExp(`grant execute on function public\\.${fn.replace(/[()]/g, "\\$&")} to service_role;`);
    assert.match(sql, revokeLine, `${fn} must revoke execute from public/anon/authenticated`);
    assert.match(sql, grantLine, `${fn} must grant execute only to service_role`);
    assert.doesNotMatch(sql, new RegExp(`grant execute on function public\\.${fn.replace(/[()]/g, "\\$&")} to authenticated`), `${fn} must never be callable by authenticated`);
  }
});

test("both functions run as security definer with a locked search_path", async () => {
  const sql = await readMigration();
  const definerCount = (sql.match(/^language plpgsql\nsecurity definer$/gm) || []).length;
  const searchPathCount = (sql.match(/set search_path = ''/g) || []).length;
  assert.equal(definerCount, 2, "both function definitions must declare security definer");
  assert.equal(searchPathCount, 2, "both function definitions must lock search_path");
});

test("provisioning refuses to reassign a non-SERVICE membership", async () => {
  const sql = await readMigration();
  assert.match(sql, /existing_role is not null and existing_role <> 'SERVICE'/);
  assert.match(sql, /raise exception 'Refusing to reassign existing % membership % to SERVICE'/);
});

test("revoke deactivates rather than deletes the membership row", async () => {
  const sql = await readMigration();
  assert.match(sql, /update public\.mag_memberships\s*\n\s*set active = false/);
  assert.doesNotMatch(sql, /delete from public\.mag_memberships/);
});
