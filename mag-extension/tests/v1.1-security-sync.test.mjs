import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const load = async (...files) => { for (const file of files) (0, eval)(await readFile(path.join(root, file), "utf8")); };
const storageMock = () => {
  const local = {}, session = {};
  const area = (memory) => ({
    async get(keys) { const list = Array.isArray(keys) ? keys : [keys]; return Object.fromEntries(list.filter((key) => key in memory).map((key) => [key, structuredClone(memory[key])])); },
    async set(values) { Object.assign(memory, structuredClone(values)); },
    async remove(key) { delete memory[key]; }
  });
  return { memory: { local, session }, chrome: { storage: { local: area(local), session: area(session) } } };
};

test("dynamic registry adds STANDARD fields without extension changes and keeps SENSITIVE fields protected", async () => {
  globalThis.MAG = {};
  await load("src/shared/constants.js", "src/core/normalize.js", "src/shared/dynamic-registry.js", "src/core/field-classifier.js", "src/core/profile-mapper.js");
  MAG.DynamicRegistry.setDefinitions([
    { canonical_key: "favorite_color", semantic_type: "OTHER", display_name: "Favorite color", aliases: ["Preferred Color"], security_class: "STANDARD", cache_policy: "LOCAL", autofill_policy: "CONFIDENCE", active: true },
    { canonical_key: "date_of_birth", semantic_type: "DATE_OF_BIRTH", display_name: "Birthday", aliases: ["DOB", "Date of Birth"], security_class: "SENSITIVE", cache_policy: "NONE", autofill_policy: "REVIEW_REQUIRED", active: true },
    { canonical_key: "ssn", semantic_type: "SOCIAL_SECURITY_NUMBER", display_name: "Social Security Number", aliases: ["SSN"], security_class: "RESTRICTED", cache_policy: "NONE", autofill_policy: "EXPLICIT_UNLOCK", active: true }
  ]);
  const base = { ariaLabel: "", name: "", id: "", placeholder: "", describedBy: "", legend: "", heading: "", nearbyText: "", autocomplete: "", type: "text" };
  const standard = MAG.FieldClassifier.classify({ ...base, label: "Preferred Color" });
  assert.equal(standard.canonicalKey, "favorite_color"); assert.equal(standard.protected, false);
  assert.equal(MAG.ProfileMapper.map({ ...base, canonicalKey: standard.canonicalKey, maxlength: 20 }, standard, { dynamicFields: { favorite_color: "Blue" } }).value, "Blue");
  const sensitive = MAG.FieldClassifier.classify({ ...base, label: "DOB", type: "date" });
  assert.equal(sensitive.securityClass, "SENSITIVE"); assert.equal(sensitive.protected, true);
  const restricted = MAG.FieldClassifier.classify({ ...base, label: "SSN" });
  assert.equal(restricted.restricted, true); assert.equal(restricted.autofillPolicy, "EXPLICIT_UNLOCK");
  const unknown = MAG.FieldClassifier.classify({ ...base, label: "Uninvented intake answer" });
  assert.equal(unknown.semantic, "OTHER"); assert.equal(unknown.level, "UNKNOWN");
});

test("cache permits only STANDARD/LOCAL fields and never stores restricted plaintext", async () => {
  const mock = storageMock(); globalThis.chrome = mock.chrome; globalThis.MAG = {};
  await load("src/shared/constants.js", "src/data/initial-profiles.js", "src/shared/storage.js");
  const definitions = [
    { canonical_key: "organization_name", security_class: "STANDARD", cache_policy: "LOCAL", active: true },
    { canonical_key: "date_of_birth", security_class: "SENSITIVE", cache_policy: "NONE", active: true },
    { canonical_key: "ssn", security_class: "RESTRICTED", cache_policy: "NONE", active: true }
  ];
  await MAG.Storage.replaceRemoteCache([{ id: "supabase:1", label: "Client", dynamicFields: { organization_name: "Client Co" }, sync: { source: "SUPABASE" } }], definitions, {});
  await assert.rejects(() => MAG.Storage.replaceRemoteCache([{ id: "supabase:1", label: "Client", dynamicFields: { ssn: "probe-value" }, sync: { source: "SUPABASE" } }], definitions, {}), /not permitted/);
  assert.equal(JSON.stringify(mock.memory.local).includes("probe-value"), false);
  assert.equal(JSON.stringify(mock.memory.local).includes("ssn\":\""), false);
});

test("incremental sync updates versions, adds profiles, removes inactive profiles, and remains usable offline", async () => {
  const mock = storageMock(); globalThis.chrome = mock.chrome; globalThis.MAG = {};
  await load("src/shared/constants.js", "src/data/initial-profiles.js", "src/shared/storage.js");
  await MAG.Storage.ensureInitialized();
  mock.memory.local.remoteProfiles = [
    { id: "supabase:p1", label: "Old", dynamicFields: { organization_name: "Old" }, sync: { source: "SUPABASE", remoteId: "p1", version: 16 } },
    { id: "supabase:p3", label: "Deactivate", dynamicFields: { organization_name: "Gone" }, sync: { source: "SUPABASE", remoteId: "p3", version: 1 } }
  ];
  const definitions = [{ canonical_key: "organization_name", semantic_type: "ORGANIZATION", display_name: "Organization", aliases: ["Business"], security_class: "STANDARD", cache_policy: "LOCAL", autofill_policy: "CONFIDENCE", active: true }];
  MAG.SupabaseClient = { async status() { return { connected: true, user: { id: "owner" } }; }, async rest(url) {
    if (url.startsWith("mag_field_definitions")) return definitions;
    if (url.startsWith("mag_profiles")) { assert.match(url, /profile_scope=eq\.CUSTOMER/); return [
      { id: "p1", label: "Updated", profile_type: "ORGANIZATION", status: "ACTIVE", profile_scope: "CUSTOMER", profile_version: 17, updated_at: "2026-09-17T12:00:00Z" },
      { id: "p2", label: "New", profile_type: "ORGANIZATION", status: "ACTIVE", profile_scope: "CUSTOMER", profile_version: 1, updated_at: "2026-09-17T12:00:00Z" },
      { id: "p3", label: "Deactivate", profile_type: "ORGANIZATION", status: "ARCHIVED", profile_scope: "CUSTOMER", profile_version: 2, updated_at: "2026-09-17T12:00:00Z" }
    ]; }
    if (url.startsWith("mag_audit_events")) return null;
    assert.match(url, /profile_id=in/);
    return [
      { profile_id: "p1", value: "Updated Co", validation_status: "VALID", mag_field_definitions: { canonical_key: "organization_name" } },
      { profile_id: "p2", value: "New Co", validation_status: "VALID", mag_field_definitions: { canonical_key: "organization_name" } }
    ];
  } };
  await load("src/background/sync-engine.js");
  const result = await MAG.SyncEngine.sync();
  assert.deepEqual({ active: result.activeProfiles, updated: result.updatedProfiles }, { active: 2, updated: 2 });
  const remote = mock.memory.local.remoteProfiles;
  assert.deepEqual(remote.map((item) => item.id).sort(), ["supabase:p1", "supabase:p2"]);
  assert.equal(remote.find((item) => item.id === "supabase:p1").sync.version, 17);
  MAG.SupabaseClient.rest = async () => { throw new Error("offline"); };
  assert.equal((await MAG.Storage.getProfiles()).some((item) => item.id === "supabase:p2"), true);
});

test("authentication persists only in session storage and logout revokes the local session", async () => {
  const mock = storageMock(); globalThis.chrome = mock.chrome; globalThis.MAG = {};
  await load("src/shared/constants.js", "src/shared/supabase-config.js");
  const originalFetch = globalThis.fetch;
  const calls = [];
  const authSession = { access_token: "<test-access>", refresh_token: "<test-refresh>", expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: "u1", email: "dre@example.invalid", user_metadata: { full_name: "Dre" } } };
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), body: options.body });
    let body = authSession;
    if (String(url).endsWith("/auth/v1/user")) body = { factors: [{ id: "factor-1", status: "verified", factor_type: "totp" }] };
    if (String(url).endsWith("/challenge")) body = { id: "challenge-1" };
    if (String(url).endsWith("/logout")) body = null;
    return { ok: true, status: 200, async json() { return body; } };
  };
  try {
    await load("src/background/supabase-client.js");
    assert.equal((await MAG.SupabaseClient.login("dre@example.invalid", "<test-password>")).connected, true);
    assert.equal(JSON.stringify(mock.memory.local).includes("test-refresh"), false);
    assert.equal(JSON.stringify(mock.memory.session).includes("test-password"), false);
    await MAG.SupabaseClient.verifyMfa("123456");
    assert.equal(calls.some((call) => call.url.endsWith("/factors/factor-1/challenge")), true);
    assert.equal(calls.some((call) => call.url.endsWith("/factors/factor-1/verify")), true);
    assert.equal(JSON.stringify(mock.memory.session).includes("123456"), false);
    await MAG.SupabaseClient.logout();
    assert.equal((await MAG.SupabaseClient.status()).connected, false);
  } finally { globalThis.fetch = originalFetch; }
});

test("extension source and manifest contain no privileged key or prohibited secret material", async () => {
  async function files(directory) { return (await Promise.all((await readdir(directory, { withFileTypes: true })).map((entry) => entry.isDirectory() ? files(path.join(directory, entry.name)) : [path.join(directory, entry.name)]))).flat(); }
  const sources = [...(await files(path.join(root, "src"))).filter((file) => /\.(?:js|json|html)$/.test(file)), path.join(root, "manifest.json")];
  const combined = (await Promise.all(sources.map((file) => readFile(file, "utf8")))).join("\n");
  assert.doesNotMatch(combined, /service_role/i);
  assert.doesNotMatch(combined, /eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/);
  assert.doesNotMatch(combined, /\b\d{3}-\d{2}-\d{4}\b/);
  assert.doesNotMatch(combined, /SUPABASE_SERVICE_ROLE_KEY/);
});
