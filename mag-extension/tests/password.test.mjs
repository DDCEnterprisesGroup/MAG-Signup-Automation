import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadGenerator() {
  globalThis.MAG = {};
  (0, eval)(await readFile(path.join(root, "src/shared/password.js"), "utf8"));
  return MAG.Password;
}

test("generator: strong defaults, every character class, bounded length", async () => {
  const Password = await loadGenerator();
  const { lower, upper, digits, symbols } = Password.SETS;
  const allowed = new Set(lower + upper + digits + symbols);
  for (let run = 0; run < 500; run += 1) {
    const value = Password.generate();
    assert.equal(value.length, 16);
    for (const set of [lower, upper, digits, symbols]) assert.ok([...value].some((c) => set.includes(c)), `missing class in ${run}`);
    assert.ok([...value].every((c) => allowed.has(c)));
  }
  assert.equal(Password.generate({ length: 5 }).length, 12, "clamped up to the 12-character minimum");
  assert.equal(Password.generate({ length: 999 }).length, 64, "clamped to 64");
  assert.equal(Password.generate({ length: 32 }).length, 32);
  assert.doesNotMatch([...Array(200)].map(() => Password.generate()).join(""), /[0O1lI]/, "no look-alike characters");
});

test("generator: symbols can be turned off", async () => {
  const Password = await loadGenerator();
  for (let run = 0; run < 300; run += 1) {
    const value = Password.generate({ symbols: false });
    assert.match(value, /^[A-Za-z0-9]{16}$/);
    assert.match(value, /[a-z]/); assert.match(value, /[A-Z]/); assert.match(value, /[0-9]/);
  }
});

test("generator: uses the platform CSPRNG, never Math.random, and does not repeat", async () => {
  const Password = await loadGenerator();
  const original = Math.random;
  Math.random = () => { throw new Error("Math.random must not be used"); };
  try {
    const seen = new Set([...Array(5000)].map(() => Password.generate()));
    assert.equal(seen.size, 5000, "no duplicates in 5000 passwords");
    const counts = {};
    for (const c of [...Array(3000)].map(() => Password.generate({ length: 64 })).join("")) counts[c] = (counts[c] || 0) + 1;
    const all = Object.values(Password.SETS).join("");
    assert.ok([...all].every((c) => counts[c] > 0), "every allowed character is reachable");
  } finally { Math.random = original; }
});

test("side panel: generate, reuse within the session, length, copy, never persisted", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mag-password-"));
  const context = await chromium.launchPersistentContext(dir, { channel: "chromium", headless: true, args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`] });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const url = `chrome-extension://${new URL(worker.url()).host}/src/sidepanel/sidepanel.html`;
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(url);
    const output = page.locator("#password-output");
    await output.evaluate((input) => new Promise((resolve) => { const check = () => input.value ? resolve() : setTimeout(check, 20); check(); }));
    const first = await output.inputValue();
    assert.equal(first.length, 16, "a password is ready when the panel opens");
    await page.locator("#password-generate").click();
    const second = await output.inputValue();
    assert.notEqual(second, first, "Generate makes a new one");
    await page.reload();
    await page.waitForFunction(() => document.querySelector("#password-output").value);
    assert.equal(await output.inputValue(), second, "reopening the panel reuses the session's password");
    await page.locator("#password-length").selectOption("24");
    await page.waitForFunction(() => document.querySelector("#password-output").value.length === 24);
    const third = await output.inputValue();
    await page.evaluate(() => { window.__copied = null; navigator.clipboard.writeText = async (text) => { window.__copied = text; }; });
    await page.locator("#password-copy").click();
    assert.equal(await page.evaluate(() => window.__copied), third, "Copy puts the shown password on the clipboard");
    assert.match(await page.locator("#password-status").textContent(), /Copied/);
    const stored = await worker.evaluate(async () => JSON.stringify(await chrome.storage.local.get(null)));
    assert.equal(stored.includes(third) || stored.includes(second), false, "never written to persistent storage");
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
    await rm(dir, { recursive: true, force: true });
  }
});
