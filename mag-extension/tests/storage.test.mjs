import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("profiles, settings, and per-domain selection persist in local storage", async () => {
  const memory = {};
  globalThis.chrome = {
    storage: { local: {
      async get(keys) {
        const list = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(list.filter((key) => key in memory).map((key) => [key, memory[key]]));
      },
      async set(values) { Object.assign(memory, structuredClone(values)); }
    } }
  };
  globalThis.MAG = {};
  for (const file of ["src/shared/constants.js", "src/data/initial-profiles.js", "src/shared/storage.js"]) {
    (0, eval)(await readFile(path.join(root, file), "utf8"));
  }
  await MAG.Storage.ensureInitialized();
  assert.equal((await MAG.Storage.getProfiles()).length, 6);
  const profiles = await MAG.Storage.getProfiles();
  profiles.push({ id: "future-profile", label: "Future Profile", kind: "ORGANIZATION" });
  await MAG.Storage.saveProfiles(profiles);
  assert.equal((await MAG.Storage.getProfiles()).at(-1).id, "future-profile");
  await MAG.Storage.rememberDomainProfile("example.com", "future-profile");
  assert.equal(await MAG.Storage.getDomainProfile("example.com"), "future-profile");
  await MAG.Storage.saveSettings({ autofillThreshold: "MEDIUM" });
  assert.equal((await MAG.Storage.getSettings()).autofillThreshold, "MEDIUM");
  await assert.rejects(() => MAG.Storage.saveProfiles([{ id: "same", label: "A" }, { id: "same", label: "B" }]), /Duplicate/);
});
