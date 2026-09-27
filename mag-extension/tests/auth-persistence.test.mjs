import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFile(path.join(root, file), "utf8");

// Simulated Supabase: GoTrue-style rotating refresh tokens plus PostgREST
// tables that enforce bearer-token validity like RLS-authenticated access.
function fakeSupabase() {
  const state = {
    offline: false, serverError: false, counter: 0, now: () => Date.now(),
    accessTokens: new Map(), refreshTokens: new Set(), usedRefreshTokens: new Set(),
    refreshCalls: 0, restCalls: [], audits: [],
    definitions: [
      { canonical_key: "full_name", semantic_type: "CONTACT_NAME", display_name: "Name", aliases: [], security_class: "STANDARD", cache_policy: "LOCAL", autofill_policy: "CONFIDENCE", active: true },
      { canonical_key: "ssn", semantic_type: "SOCIAL_SECURITY_NUMBER", display_name: "SSN", aliases: [], security_class: "RESTRICTED", cache_policy: "NONE", autofill_policy: "EXPLICIT_UNLOCK", active: true }
    ],
    profiles: [
      { id: "11111111-aaaa", label: "Jessica Williams", profile_type: "PERSON", status: "READY_FOR_REVIEW", profile_scope: "CUSTOMER", profile_version: 1, updated_at: "2026-09-25T10:00:00Z" },
      { id: "22222222-bbbb", label: "Rico Rollins", profile_type: "PERSON", status: "ACTIVE", profile_scope: "CUSTOMER", profile_version: 3, updated_at: "2026-09-25T11:00:00Z" }
    ],
    values: [
      { profile_id: "11111111-aaaa", value: "Jessica Williams", key: "full_name" },
      { profile_id: "22222222-bbbb", value: "Rico Rollins", key: "full_name" }
    ]
  };
  const user = { id: "owner-1", email: "dre@example.invalid", user_metadata: { full_name: "Dre" } };
  function issue(lifetimeSeconds = 3600) {
    state.counter += 1;
    const access = `access-${state.counter}`, refresh = `refresh-${state.counter}`;
    state.accessTokens.set(access, state.now() + lifetimeSeconds * 1000);
    state.refreshTokens.add(refresh);
    return { access_token: access, refresh_token: refresh, token_type: "bearer", expires_in: lifetimeSeconds, expires_at: Math.floor((state.now() + lifetimeSeconds * 1000) / 1000), user };
  }
  const json = (status, body) => ({ ok: status < 300, status, async json() { return body; } });
  state.fetch = async (url, options = {}) => {
    if (state.offline) throw new TypeError("Failed to fetch");
    const parsed = new URL(String(url));
    const target = parsed.pathname + parsed.search;
    if (state.serverError) return json(503, { message: "Service unavailable" });
    if (target === "/auth/v1/token?grant_type=password") return json(200, issue(state.nextLifetime ?? 3600));
    if (target === "/auth/v1/token?grant_type=refresh_token") {
      state.refreshCalls += 1;
      const presented = JSON.parse(options.body).refresh_token;
      if (!state.refreshTokens.has(presented)) return json(400, { error: "invalid_grant", error_description: "Invalid Refresh Token: Already Used" });
      state.refreshTokens.delete(presented); state.usedRefreshTokens.add(presented);
      return json(200, issue());
    }
    const bearer = String(options.headers?.Authorization || "").replace("Bearer ", "");
    const tokenValid = (state.accessTokens.get(bearer) || 0) > state.now();
    if (parsed.pathname.startsWith("/auth/v1/logout")) {
      if (!tokenValid) return json(401, { message: "JWT expired" });
      state.refreshTokens.clear(); state.logoutScope = parsed.searchParams.get("scope");
      return json(204, null);
    }
    if (parsed.pathname === "/functions/v1/mag-restricted-value") {
      if (!tokenValid) return json(401, { error: "AUTH_REQUIRED" });
      const { canonicalKey } = JSON.parse(options.body);
      state.restrictedCalls = [...(state.restrictedCalls || []), canonicalKey];
      // Deployed rule: SENSITIVE DOB at AAL1 on explicit autofill; RESTRICTED needs recent MFA.
      if (canonicalKey === "date_of_birth") return json(200, { value: "1985-03-07", maskedHint: "••/••/1985", classification: "SENSITIVE" });
      return json(403, { error: "RECENT_MFA_REQUIRED" });
    }
    if (parsed.pathname.startsWith("/rest/v1/")) {
      if (!tokenValid) return json(401, { message: "JWT expired" });
      state.restCalls.push(target);
      const table = parsed.pathname.slice("/rest/v1/".length);
      if (table === "mag_audit_events") { state.audits.push(JSON.parse(options.body)); return json(201, null); }
      if (table === "mag_field_definitions") return json(200, state.definitions);
      if (table === "mag_profiles") return json(200, state.profiles);
      if (table === "mag_profile_field_values") {
        const ids = decodeURIComponent(parsed.search).match(/profile_id=in\.\(([^)]*)\)/)[1].replaceAll("\"", "").split(",");
        return json(200, state.values.filter((item) => ids.includes(item.profile_id)).map((item) => {
          const definition = state.definitions.find((entry) => entry.canonical_key === item.key);
          return { profile_id: item.profile_id, value: item.value, validation_status: "VALID", mag_field_definitions: { canonical_key: definition.canonical_key, semantic_type: definition.semantic_type, security_class: definition.security_class, cache_policy: definition.cache_policy, active: true } };
        }).filter((item) => item.mag_field_definitions.security_class === "STANDARD"));
      }
    }
    return json(404, { message: `unhandled ${target}` });
  };
  return state;
}

// Persistent browser state that survives worker restarts: chrome.storage.local,
// the IndexedDB auth vault and registered alarms. chrome.storage.session is
// wiped by a browser restart or extension reload.
function browserState() {
  return { local: {}, session: {}, vault: new Map(), alarms: new Map() };
}

async function startWorker(browser, backend, { event } = {}) {
  const listeners = { installed: [], startup: [], message: [], alarm: [], changed: [] };
  const area = (name) => ({
    async get(keys) { const memory = browser[name]; const list = keys === undefined ? Object.keys(memory) : Array.isArray(keys) ? keys : [keys]; return Object.fromEntries(list.filter((key) => key in memory).map((key) => [key, structuredClone(memory[key])])); },
    async set(values) { const changes = {}; for (const [key, value] of Object.entries(values)) { changes[key] = { newValue: structuredClone(value) }; browser[name][key] = structuredClone(value); } listeners.changed.forEach((listener) => listener(changes, name)); },
    async remove(key) { delete browser[name][key]; }
  });
  globalThis.fetch = backend.fetch;
  globalThis.chrome = {
    storage: { local: area("local"), session: area("session"), onChanged: { addListener(listener) { listeners.changed.push(listener); } } },
    runtime: {
      onInstalled: { addListener(listener) { listeners.installed.push(listener); } },
      onStartup: { addListener(listener) { listeners.startup.push(listener); } },
      onMessage: { addListener(listener) { listeners.message.push(listener); } }
    },
    alarms: {
      async get(name) { return browser.alarms.get(name); },
      async create(name, info) { browser.alarms.set(name, { name, ...info }); },
      onAlarm: { addListener(listener) { listeners.alarm.push(listener); } }
    },
    sidePanel: { setPanelBehavior: async () => {} },
    action: { setBadgeBackgroundColor: async () => {}, setBadgeText: async () => {}, setTitle: async () => {} },
    commands: { onCommand: { addListener() {} } },
    tabs: { query: async () => [{ id: 7 }], sendMessage: async (_tab, message) => { browser.sent = [...(browser.sent || []), message]; return { ok: true, summary: { filled: 1, profile: message.profile.id } }; } }
  };
  globalThis.MAG = { AuthVault: { get: async (key) => structuredClone(browser.vault.get(key)), set: async (key, value) => { browser.vault.set(key, structuredClone(value)); }, remove: async (key) => { browser.vault.delete(key); } } };
  const sources = { "../shared/constants.js": await read("src/shared/constants.js"), "../shared/storage.js": await read("src/shared/storage.js"), "../shared/supabase-config.js": await read("src/shared/supabase-config.js"), "supabase-client.js": await read("src/background/supabase-client.js"), "sync-engine.js": await read("src/background/sync-engine.js") };
  globalThis.importScripts = (...files) => files.forEach((file) => (0, eval)(sources[file]));
  (0, eval)(await read("src/background/service-worker.js"));
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
  const worker = {
    listeners, settle,
    async send(message) {
      return new Promise((resolve) => { const keepOpen = listeners.message[0](message, {}, resolve); if (!keepOpen) resolve(undefined); });
    },
    async fireAlarm() { listeners.alarm.forEach((listener) => listener({ name: "mag-profile-sync" })); await settle(); },
    remoteProfiles: () => browser.local.remoteProfiles || [],
    syncState: () => browser.local.syncState
  };
  if (event === "install") { for (const listener of listeners.installed) await listener({ reason: "update" }); await settle(); }
  if (event === "startup") { listeners.startup.forEach((listener) => listener()); await settle(); }
  await settle();
  return worker;
}

const realFetch = globalThis.fetch;
test.after(() => { globalThis.fetch = realFetch; });

async function signedIn() {
  const backend = fakeSupabase(), browser = browserState();
  const worker = await startWorker(browser, backend, { event: "install" });
  const login = await worker.send({ type: "MAG_AUTH_LOGIN", email: "dre@example.invalid", password: "<test-password>" });
  return { backend, browser, worker, login };
}

test("T1 initial login persists the session and syncs automatically without a Sync click", async () => {
  const backend = fakeSupabase(), browser = browserState();
  const worker = await startWorker(browser, backend, { event: "install" });
  assert.equal((await worker.send({ type: "MAG_AUTH_STATUS" })).data.connected, false);
  assert.equal(worker.syncState().lastErrorCode, "AUTH_REQUIRED", "signed-out install records a safe code and makes no data request");
  assert.equal(backend.restCalls.length, 0);
  const login = await worker.send({ type: "MAG_AUTH_LOGIN", email: "dre@example.invalid", password: "<test-password>" });
  assert.equal(login.ok, true);
  assert.equal(login.data.connected, true);
  assert.equal(login.data.sync.offline, false);
  assert.deepEqual(worker.remoteProfiles().map((item) => item.label).sort(), ["Jessica Williams", "Rico Rollins"]);
  const stored = browser.vault.get("supabaseSession");
  assert.ok(stored.access_token && stored.refresh_token && stored.expires_at, "complete session persisted in the vault");
  const everythingElse = JSON.stringify({ local: browser.local, session: browser.session });
  assert.equal(everythingElse.includes(stored.refresh_token), false, "tokens never reach chrome.storage (readable by content scripts)");
  assert.equal(everythingElse.includes(stored.access_token), false);
  assert.equal(JSON.stringify([...browser.vault.values()]).includes("<test-password>"), false, "password never stored");
  assert.equal(browser.local.authState.connected, true, "token-free auth metadata published for UI");
  assert.equal(browser.local.alarms, undefined);
  assert.equal(browser.alarms.get("mag-profile-sync").periodInMinutes, 5);
});

test("T2/T4 reopening the panel after a worker restart restores the session without a login prompt", async () => {
  const { backend, browser } = await signedIn();
  const before = backend.restCalls.length;
  const restarted = await startWorker(browser, backend); // service worker suspended and re-created
  const status = await restarted.send({ type: "MAG_AUTH_STATUS" });
  assert.equal(status.data.connected, true);
  assert.equal(status.data.user.displayName, "Dre");
  const panel = await restarted.send({ type: "MAG_SYNC_PROFILES", force: false });
  assert.equal(panel.data.skipped, true, "fresh cache: panel open does not refetch");
  assert.equal(backend.restCalls.length, before);
  assert.equal(restarted.remoteProfiles().length, 2);
  const forced = await restarted.send({ type: "MAG_SYNC_PROFILES", force: true });
  assert.equal(forced.data.offline, false, "requests keep working after restart");
});

test("T3/T5 browser restart and extension reload restore auth and sync at startup", async () => {
  const { backend, browser } = await signedIn();
  browser.session = {}; // chrome.storage.session is cleared by restart/reload
  backend.profiles[1] = { ...backend.profiles[1], label: "Rico Rollins Jr", profile_version: 4, updated_at: "2026-09-26T09:00:00Z" };
  const afterRestart = await startWorker(browser, backend, { event: "startup" });
  assert.equal((await afterRestart.send({ type: "MAG_AUTH_STATUS" })).data.connected, true);
  assert.ok(afterRestart.remoteProfiles().some((item) => item.label === "Rico Rollins Jr"), "startup sync ran with restored auth");
  backend.profiles[0] = { ...backend.profiles[0], label: "Jessica Williams-Reyes", updated_at: "2026-09-26T09:30:00Z" };
  const afterReload = await startWorker(browser, backend, { event: "install" });
  assert.equal((await afterReload.send({ type: "MAG_AUTH_STATUS" })).data.connected, true, "extension reload/update does not force logout");
  assert.ok(afterReload.remoteProfiles().some((item) => item.label === "Jessica Williams-Reyes"), "updated_at-only change is picked up");
});

test("T6/T7 expired access token refreshes proactively and the rotated refresh token replaces the old one", async () => {
  const { backend, browser, worker } = await signedIn();
  const first = browser.vault.get("supabaseSession");
  let offset = 58 * 60 * 1000; // 2 minutes before expiry: inside the refresh margin
  backend.now = () => Date.now() + offset;
  const realNow = Date.now; Date.now = () => realNow() + offset;
  try {
    const result = await worker.send({ type: "MAG_SYNC_PROFILES", force: true });
    assert.equal(result.data.offline, false);
    assert.equal(backend.refreshCalls, 1);
    const second = browser.vault.get("supabaseSession");
    assert.notEqual(second.refresh_token, first.refresh_token);
    assert.ok(backend.usedRefreshTokens.has(first.refresh_token));
    offset += 60 * 60 * 1000; // an hour later: the new token has expired too
    const again = await worker.send({ type: "MAG_SYNC_PROFILES", force: true });
    assert.equal(again.data.offline, false, "second refresh with the rotated token succeeds");
    assert.equal(backend.refreshCalls, 2);
    assert.notEqual(browser.vault.get("supabaseSession").refresh_token, second.refresh_token);
  } finally { Date.now = realNow; }
});

test("T6 concurrent requests share a single refresh-token exchange", async () => {
  const { backend, browser } = await signedIn();
  const session = browser.vault.get("supabaseSession");
  browser.vault.set("supabaseSession", { ...session, expires_at: Math.floor(Date.now() / 1000) - 10 });
  const results = await Promise.all([MAG.SupabaseClient.rest("mag_profiles?select=id"), MAG.SupabaseClient.rest("mag_field_definitions?select=canonical_key"), MAG.SupabaseClient.invoke("mag-restricted-value", {}).catch(() => "edge"), MAG.SupabaseClient.ensureValidSession()]);
  assert.equal(results.length, 4);
  assert.equal(backend.refreshCalls, 1, "no refresh-token race");
});

test("T6 a 401 on a token believed valid triggers one refresh and a retry", async () => {
  const { backend, browser } = await signedIn();
  backend.accessTokens.set(browser.vault.get("supabaseSession").access_token, 0); // revoked server-side
  const rows = await MAG.SupabaseClient.rest("mag_profiles?select=id");
  assert.equal(rows.length, 2);
  assert.equal(backend.refreshCalls, 1);
});

test("T8 a revoked refresh token signs out, keeps the profile cache and requires sign-in", async () => {
  const { backend, browser, worker } = await signedIn();
  backend.refreshTokens.clear(); // revoked elsewhere
  const session = browser.vault.get("supabaseSession");
  browser.vault.set("supabaseSession", { ...session, expires_at: Math.floor(Date.now() / 1000) - 10 });
  const result = await worker.send({ type: "MAG_SYNC_PROFILES", force: true });
  assert.equal(result.data.offline, true);
  assert.equal(result.data.lastErrorCode, "AUTH_REQUIRED");
  assert.equal(browser.vault.has("supabaseSession"), false, "persisted auth cleared");
  assert.equal(browser.local.authState.connected, false);
  assert.equal((await worker.send({ type: "MAG_AUTH_STATUS" })).data.connected, false);
  assert.equal(worker.remoteProfiles().length, 2, "last valid cache kept");
  await assert.rejects(MAG.SupabaseClient.rest("mag_profiles"), /Sign in/);
});

test("T9 network and server failures keep the session and cache, record a safe code, and recover", async () => {
  const { backend, browser, worker } = await signedIn();
  const session = browser.vault.get("supabaseSession");
  browser.vault.set("supabaseSession", { ...session, expires_at: Math.floor(Date.now() / 1000) - 10 });
  backend.offline = true;
  const offline = await worker.send({ type: "MAG_SYNC_PROFILES", force: true });
  assert.equal(offline.data.lastErrorCode, "OFFLINE");
  assert.equal(browser.vault.get("supabaseSession").refresh_token, session.refresh_token, "not logged out while offline");
  assert.equal(worker.remoteProfiles().length, 2);
  backend.offline = false; backend.serverError = true;
  await worker.fireAlarm();
  assert.equal(worker.syncState().lastErrorCode, "SYNC_UNAVAILABLE");
  assert.equal(browser.vault.has("supabaseSession"), true, "server error is not a revoked session");
  backend.serverError = false;
  await worker.fireAlarm();
  assert.equal(worker.syncState().status, "SUCCESS");
  assert.equal(worker.syncState().lastErrorCode, undefined, "recovered state clears the error");
});

test("T10/T11/T12/T13/T14 periodic sync picks up edits, new, review and archived profiles; READY_FOR_REVIEW and ACTIVE autofill", async () => {
  const { backend, worker } = await signedIn();
  const auditsAfterLogin = backend.audits.length;
  await worker.fireAlarm();
  assert.equal(backend.audits.length, auditsAfterLogin, "an unchanged background sync writes no audit row");
  backend.profiles[1] = { ...backend.profiles[1], label: "Rico Rollins (edited)", profile_version: 4, updated_at: "2026-09-26T12:00:00Z" };
  backend.profiles.push({ id: "33333333-cccc", label: "New Draft Customer", profile_type: "PERSON", status: "DRAFT", profile_scope: "CUSTOMER", profile_version: 1, updated_at: "2026-09-26T12:01:00Z" });
  backend.profiles.push({ id: "44444444-dddd", label: "Incomplete Customer", profile_type: "PERSON", status: "INCOMPLETE", profile_scope: "CUSTOMER", profile_version: 1, updated_at: "2026-09-26T12:02:00Z" });
  await worker.fireAlarm(); // no Sync click
  const cache = worker.remoteProfiles();
  assert.ok(cache.some((item) => item.label === "Rico Rollins (edited)"), "T10 edit synced automatically");
  assert.ok(cache.some((item) => item.id === "supabase:33333333-cccc" && item.status === "DRAFT"), "T11 new non-archived profile appears");
  const review = cache.find((item) => item.id === "supabase:11111111-aaaa");
  assert.equal(review.status, "READY_FOR_REVIEW", "T12 visible with status");
  assert.equal(JSON.stringify(cache).includes("ssn"), false, "restricted fields never cached");
  await MAG.Storage.setSessionProfile(review.id);
  const reviewed = await worker.send({ type: "MAG_AUTOFILL_ACTIVE" });
  assert.equal(reviewed.ok, true, "T12 READY_FOR_REVIEW profile autofills");
  for (const id of ["supabase:33333333-cccc", "supabase:44444444-dddd"]) {
    await MAG.Storage.setSessionProfile(id);
    const blocked = await worker.send({ type: "MAG_AUTOFILL_ACTIVE" });
    assert.equal(blocked.ok, false, `${id} (DRAFT/INCOMPLETE) is blocked`);
    assert.equal(blocked.error, "This profile is not ready for autofill yet.");
  }
  await MAG.Storage.setSessionProfile("supabase:22222222-bbbb");
  const allowed = await worker.send({ type: "MAG_AUTOFILL_ACTIVE" });
  assert.equal(allowed.ok, true, "T13 ACTIVE profile autofills");
  backend.profiles[1] = { ...backend.profiles[1], status: "ARCHIVED", updated_at: "2026-09-26T12:05:00Z" };
  await worker.fireAlarm();
  assert.equal(worker.remoteProfiles().some((item) => item.id === "supabase:22222222-bbbb"), false, "T14 archived profile removed");
  assert.equal(worker.syncState().removedProfiles, 1);
  await MAG.Storage.setSessionProfile("supabase:22222222-bbbb");
  const archived = await worker.send({ type: "MAG_AUTOFILL_ACTIVE" });
  assert.equal(archived.ok, false, "archived profile is no longer available to autofill");
  assert.match(archived.error, /Choose a MAG profile/);
});

test("T3 DOB is fetched only on explicit Autofill, reaches the page, and is never cached; SSN stays blocked", async () => {
  const { backend, browser, worker } = await signedIn();
  await worker.fireAlarm();
  await worker.send({ type: "MAG_SYNC_PROFILES", force: true });
  assert.equal(backend.restrictedCalls, undefined, "sync never requests protected values");
  await MAG.Storage.setSessionProfile("supabase:22222222-bbbb");
  const result = await worker.send({ type: "MAG_AUTOFILL_ACTIVE" });
  assert.equal(result.ok, true);
  assert.deepEqual(backend.restrictedCalls, ["date_of_birth", "ssn"], "requested only on the explicit Autofill action");
  const sent = browser.sent.at(-1);
  assert.equal(sent.authorizedValues.date_of_birth, "1985-03-07", "DOB handed to the page for this fill");
  assert.equal("ssn" in sent.authorizedValues, false, "SSN still refused without recent MFA");
  const persisted = JSON.stringify({ local: browser.local, session: browser.session, vault: [...browser.vault.values()] });
  assert.equal(persisted.includes("1985-03-07"), false, "DOB is not written to any extension storage");
  assert.equal(JSON.stringify(worker.remoteProfiles()).includes("date_of_birth"), false, "no DOB key in the cached profiles");
});

test("logout revokes only this session and leaves no tokens behind", async () => {
  const { backend, browser, worker } = await signedIn();
  await MAG.Storage.setSessionProfile("supabase:22222222-bbbb");
  const result = await worker.send({ type: "MAG_AUTH_LOGOUT" });
  assert.equal(result.data.connected, false);
  assert.equal(backend.logoutScope, "local");
  assert.equal(backend.refreshTokens.size, 0);
  assert.equal(browser.vault.size, 0);
  assert.equal(await MAG.Storage.getSessionProfile(), "");
  assert.equal(worker.remoteProfiles().length, 2, "cached profiles preserved");
});

test("a session saved by the previous session-storage build is migrated once", async () => {
  const backend = fakeSupabase(), browser = browserState();
  const worker = await startWorker(browser, backend);
  const legacy = await (async () => { const response = await backend.fetch("https://qtjpahbuewptnocqklas.supabase.co/auth/v1/token?grant_type=password", { method: "POST" }); return response.json(); })();
  browser.session.magSupabaseSession = legacy;
  assert.equal((await worker.send({ type: "MAG_AUTH_STATUS" })).data.connected, true);
  assert.equal(browser.session.magSupabaseSession, undefined);
  assert.equal(browser.vault.get("supabaseSession").refresh_token, legacy.refresh_token);
});
