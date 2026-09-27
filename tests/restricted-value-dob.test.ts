import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fn = () => readFile(path.join(root, "supabase/functions/mag-restricted-value/index.ts"), "utf8");
const migration = () => readFile(path.join(root, "supabase/migrations/20260927010653_restricted_value_release_dob.sql"), "utf8");

test("only date_of_birth, classified SENSITIVE by the server registry, skips the recent-MFA gate", async () => {
  const source = await fn();
  assert.match(source, /const SESSION_RELEASABLE_KEYS = new Set\(\["date_of_birth"\]\);/);
  assert.match(source, /from\("mag_field_definitions"\)\.select\("security_class"\)\.eq\("canonical_key", body\.canonicalKey\)/, "class comes from the registry, not the client");
  assert.match(source, /SESSION_RELEASABLE_KEYS\.has\(body\.canonicalKey\) && definition\?\.security_class === "SENSITIVE"/);
  assert.match(source, /if \(!sessionReleasable && \(claims\.aal !== "aal2" \|\| !issuedAt \|\| Date\.now\(\) \/ 1000 - issuedAt > 600\)\) throw new Error\("RECENT_MFA_REQUIRED"\)/, "every other key keeps the AAL2 gate");
});

test("the restricted-value RPC releases SENSITIVE rows for date_of_birth only; checks and audit unchanged", async () => {
  const sql = await migration();
  assert.match(sql, /and \(pv\.classification = 'RESTRICTED'\s+or \(pv\.classification = 'SENSITIVE' and p_canonical_key = 'date_of_birth'\)\);/);
  assert.match(sql, /m\.role in \('OWNER','ADMIN','OPERATOR'\)/);
  assert.match(sql, /mag_profile_access/);
  assert.match(sql, /'RESTRICTED_ACCESS_SUCCESS'/, "access is still audited");
  assert.match(sql, /SECURITY DEFINER\s+SET search_path TO ''/);
});
