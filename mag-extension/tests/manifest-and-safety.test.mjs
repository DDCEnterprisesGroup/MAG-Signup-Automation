import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => entry.isDirectory() ? filesUnder(path.join(directory, entry.name)) : [path.join(directory, entry.name)]));
  return nested.flat();
}

test("Manifest V3 declares the modular extension execution path", async () => {
  const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.background.service_worker, "src/background/service-worker.js");
  assert.ok(manifest.content_scripts[0].js.length >= 8);
  assert.ok(manifest.permissions.includes("storage"));
  assert.equal(manifest.permissions.includes("alarms"), false);
  assert.equal(manifest.permissions.includes("downloads"), false);
  for (const relative of [manifest.background.service_worker, manifest.action.default_popup, manifest.options_page, ...manifest.content_scripts[0].js]) {
    await readFile(path.join(root, relative));
  }
});

test("extension execution path contains no prohibited submission mechanism", async () => {
  const executionRoots = ["src/content", "src/core", "src/adapters", "src/background"];
  const files = (await Promise.all(executionRoots.map((entry) => filesUnder(path.join(root, entry))))).flat().filter((file) => file.endsWith(".js"));
  const prohibited = [
    [/\.requestSubmit\s*\(/, "requestSubmit"],
    [/\.submit\s*\(/, "DOM submit"],
    [/\.click\s*\(/, "programmatic click"],
    [/new\s+KeyboardEvent\b/, "keyboard simulation"],
    [/key\s*:\s*["']Enter["']/, "Enter simulation"],
    [/dispatchEvent\s*\(\s*new\s+(?:SubmitEvent|MouseEvent|KeyboardEvent)/, "synthetic submit/click/key event"],
    [/chrome\.alarms\b/, "scheduled execution"]
  ];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    for (const [pattern, label] of prohibited) assert.doesNotMatch(source, pattern, `${label} found in ${path.relative(root, file)}`);
  }
});

test("seed profiles contain only the six requested initial contexts and preserve unknowns", async () => {
  globalThis.MAG = {};
  for (const file of ["src/shared/constants.js", "src/data/initial-profiles.js"]) {
    const source = await readFile(path.join(root, file), "utf8");
    (0, eval)(source);
  }
  assert.equal(MAG.INITIAL_PROFILES.length, 6);
  const event = MAG.INITIAL_PROFILES.find((profile) => profile.id === "christmas-at-the-magical-midway-2026");
  assert.equal(event.event.date, "2026-12-12");
  assert.equal(event.event.startTime, "12:00");
  assert.equal(event.safeguards.electronicDonationsActive, false);
  assert.equal(JSON.stringify(event).includes("3rd Annual"), true, "outdated phrase should exist only as an explicit excluded claim");
  const iceHouse = MAG.INITIAL_PROFILES.find((profile) => profile.id === "ice-house-jewelers");
  assert.equal("website" in iceHouse.organization, false);
  const dre = MAG.INITIAL_PROFILES.find((profile) => profile.id === "dandre-d-combs-jr");
  assert.equal("biography" in dre.person, false);
});
