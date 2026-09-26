import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("browser startup triggers a best-effort refresh without blocking the local cache", async () => {
  let startupListener;
  let syncCalls = 0;
  let failureCalls = 0;
  const state = { status: "SUCCESS", lastSuccessfulSync: new Date().toISOString(), activeProfiles: 1 };
  globalThis.MAG = {
    Storage: {
      async ensureInitialized() {},
      async isSyncStale() { return true; },
      async getSyncState() { return state; },
      async recordSyncFailure() { failureCalls += 1; state.status = "OFFLINE"; return state; },
      async getSessionProfile() { return ""; },
      async getProfiles() { return []; },
      async getSettings() { return {}; },
      async getFieldRegistry() { return []; },
      KEYS: { remoteProfiles: "remoteProfiles" }
    },
    SyncEngine: { async sync() { syncCalls += 1; return { activeProfiles: 1 }; } },
    SupabaseClient: { async ensureValidSession() { return { access_token: "x" }; } },
    SYNC_INTERVAL_MINUTES: 5,
    MESSAGE: { AUTH_STATUS: "AUTH_STATUS", AUTH_LOGIN: "AUTH_LOGIN", AUTH_LOGOUT: "AUTH_LOGOUT", MFA_VERIFY: "MFA_VERIFY", AUDIT_EVENT: "AUDIT_EVENT", SYNC_PROFILES: "SYNC_PROFILES", RESTRICTED_UNLOCK: "RESTRICTED_UNLOCK", FORM_DETECTED: "FORM_DETECTED" },
    SUPABASE: {},
    RESTRICTED_AUTOFILL_ENABLED: false
  };
  globalThis.importScripts = () => {};
  globalThis.chrome = {
    runtime: {
      onInstalled: { addListener() {} },
      onStartup: { addListener(listener) { startupListener = listener; } },
      onMessage: { addListener() {} }
    },
    sidePanel: { setPanelBehavior: async () => {} },
    action: { setBadgeBackgroundColor: async () => {}, setBadgeText: async () => {}, setTitle: async () => {} },
    commands: { onCommand: { addListener() {} } },
    tabs: { query: async () => [], sendMessage: async () => ({ ok: true }) }
  };
  (0, eval)(await readFile(path.join(root, "src/background/service-worker.js"), "utf8"));
  startupListener();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(syncCalls, 1);
  assert.equal(failureCalls, 0);

  MAG.SyncEngine.sync = async () => { throw new Error("network unavailable"); };
  startupListener();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(failureCalls, 1);
  assert.equal(state.status, "OFFLINE");
});
