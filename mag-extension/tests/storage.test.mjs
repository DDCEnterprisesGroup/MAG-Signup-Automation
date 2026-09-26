import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("profiles, settings, and per-domain selection persist in local storage", async () => {
  const memory = {};
  const area = {
      async get(keys) {
        const list = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(list.filter((key) => key in memory).map((key) => [key, memory[key]]));
      },
      async set(values) { Object.assign(memory, structuredClone(values)); }
    };
  globalThis.chrome = {
    storage: { local: area, session: {
      async get(keys) { const list = Array.isArray(keys) ? keys : [keys]; return Object.fromEntries(list.filter((key) => key in memory).map((key) => [key, memory[key]])); },
      async set(values) { Object.assign(memory, structuredClone(values)); },
      async remove(keys) { for (const key of (Array.isArray(keys) ? keys : [keys])) delete memory[key]; }
    } }
  };
  globalThis.MAG = {};
  for (const file of ["src/shared/constants.js", "src/shared/storage.js"]) {
    (0, eval)(await readFile(path.join(root, file), "utf8"));
  }
  await MAG.Storage.ensureInitialized();
  assert.equal((await MAG.Storage.getProfiles()).length, 0);
  const profiles = await MAG.Storage.getProfiles();
  profiles.push({ id: "future-profile", label: "Future Profile", kind: "ORGANIZATION" });
  await MAG.Storage.saveProfiles(profiles);
  assert.equal((await MAG.Storage.getProfiles()).at(-1).id, "future-profile");
  await MAG.Storage.rememberDomainProfile("example.com", "future-profile");
  assert.equal(await MAG.Storage.getDomainProfile("example.com"), "future-profile");
  await MAG.Storage.setSessionProfile("future-profile");
  assert.equal(await MAG.Storage.getSessionProfile(), "future-profile");
  await MAG.Storage.setSessionProfile("");
  assert.equal(await MAG.Storage.getSessionProfile(), "");
  await MAG.Storage.saveSettings({ autofillThreshold: "MEDIUM" });
  assert.equal((await MAG.Storage.getSettings()).autofillThreshold, "MEDIUM");
  await assert.rejects(() => MAG.Storage.saveProfiles([{ id: "same", label: "A" }, { id: "same", label: "B" }]), /Duplicate/);
});

test("offline refresh state preserves the last valid cache and never seeds profiles", async () => {
  const memory = {};
  const area = {
    async get(keys) { const list = Array.isArray(keys) ? keys : [keys]; return Object.fromEntries(list.filter((key) => key in memory).map((key) => [key, structuredClone(memory[key])])); },
    async set(values) { Object.assign(memory, structuredClone(values)); }
  };
  globalThis.chrome = { storage: { local: area, session: area } };
  globalThis.MAG = {};
  for (const file of ["src/shared/constants.js", "src/shared/storage.js"]) (0, eval)(await readFile(path.join(root, file), "utf8"));
  await MAG.Storage.ensureInitialized();
  memory.remoteProfiles = [{ id: "supabase:customer-1", label: "Cached Customer", dynamicFields: { first_name: "Rico" }, sync: { source: "SUPABASE" } }];
  memory.syncState = { status: "SUCCESS", lastSuccessfulSync: new Date().toISOString(), activeProfiles: 1 };
  assert.equal((await MAG.Storage.getProfiles())[0].label, "Cached Customer");
  assert.equal(await MAG.Storage.isSyncStale(), false);
  const state = await MAG.Storage.recordSyncFailure(new Error("network unavailable"));
  assert.equal(state.status, "OFFLINE");
  assert.equal((await MAG.Storage.getProfiles())[0].label, "Cached Customer");
  assert.equal(JSON.stringify(memory).includes("INITIAL_PROFILES"), false);
});
