import { chromium } from "playwright";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROFILE_ID = "30c1f5e5-b775-4db0-821e-1ec6ccd84bb0";
const extensionDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const botEnvPath = "/Volumes/Mac Storage/Dre-Organized-2026-09-09/MAG/MAGHausPR-Bot-GitHub/.env";

function parseEnv(source) {
  return Object.fromEntries(source.split(/\r?\n/).filter((line) => line && !line.trimStart().startsWith("#") && line.includes("=")).map((line) => {
    const index = line.indexOf("=");
    return [line.slice(0, index).trim(), line.slice(index + 1).trim().replace(/^(["'])(.*)\1$/, "$2")];
  }));
}

const env = parseEnv(await fs.readFile(botEnvPath, "utf8"));
if (!env.MAG_SUPABASE_SERVICE_EMAIL || !env.MAG_SUPABASE_SERVICE_PASSWORD) throw new Error("Operator credentials are unavailable.");
const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "mag-extension-v1-"));
const context = await chromium.launchPersistentContext(userDataDir, {
  channel: "chromium",
  headless: true,
  args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
});

try {
  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: 20000 });
  const extensionId = new URL(worker.url()).host;
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/src/options/options.html`);
  await options.locator("#email").fill(env.MAG_SUPABASE_SERVICE_EMAIL);
  await options.locator("#password").fill(env.MAG_SUPABASE_SERVICE_PASSWORD);
  await options.locator("#login").click();
  await options.locator("#auth-status").filter({ hasText: "Connected as" }).waitFor({ timeout: 20000 });
  await options.locator("#sync").click();
  await options.locator("#message").filter({ hasText: "Sync complete:" }).waitFor({ timeout: 20000 });

  const sync = await worker.evaluate(async (profileId) => {
    const profiles = await MAG.Storage.getProfiles();
    const profile = profiles.find((item) => item.id === `supabase:${profileId}`);
    const state = await MAG.Storage.getSyncState();
    const auth = await MAG.SupabaseClient.status();
    const keys = Object.keys(profile?.dynamicFields || {}).sort();
    const valuesPresent = Object.values(profile?.dynamicFields || {}).every((value) => typeof value === "string" && value.trim().length > 0);
    const prohibited = keys.filter((key) => /ssn|social|tax|bank|routing|card|birth|password|credential/i.test(key));
    return {
      authenticated: auth.connected,
      exactProfileFound: Boolean(profile),
      source: profile?.sync?.source,
      version: profile?.sync?.version,
      fieldCount: keys.length,
      keys,
      valuesPresent,
      prohibited,
      activeProfiles: state.activeProfiles,
    };
  }, PROFILE_ID);

  const target = await context.newPage();
  await target.goto("https://httpbin.org/forms/post", { waitUntil: "domcontentloaded", timeout: 30000 });
  await target.evaluate(() => {
    window.__magSubmitEvents = 0;
    document.querySelector("form")?.addEventListener("submit", (event) => { window.__magSubmitEvents += 1; event.preventDefault(); });
    const form = document.querySelector("form");
    const unknown = document.createElement("input"); unknown.name = "orbital_preference"; unknown.id = "mag-unknown";
    const restricted = document.createElement("input"); restricted.name = "ssn"; restricted.id = "mag-restricted";
    form?.append(unknown, restricted);
  });
  const tabId = await target.evaluate(() => new Promise((resolve, reject) => chrome.runtime.sendMessage({ type: "__not_used" }, () => chrome.runtime.lastError ? reject(chrome.runtime.lastError) : resolve(null))).catch(() => null));
  const result = await worker.evaluate(async ({ profileId, targetUrl }) => {
    const profiles = await MAG.Storage.getProfiles();
    const profile = profiles.find((item) => item.id === `supabase:${profileId}`);
    const settings = await MAG.Storage.getSettings();
    const registry = await MAG.Storage.getFieldRegistry();
    const tabs = await chrome.tabs.query({ url: `${targetUrl}*` });
    if (!profile || tabs.length !== 1) throw new Error("Acceptance target/profile unavailable.");
    const analysis = await chrome.tabs.sendMessage(tabs[0].id, { type: MAG.MESSAGE.ANALYZE, profile, settings, registry });
    const fill = await chrome.tabs.sendMessage(tabs[0].id, { type: MAG.MESSAGE.AUTOFILL, profile, settings, registry });
    return { analysis: analysis.summary, fill: fill.summary };
  }, { profileId: PROFILE_ID, targetUrl: "https://httpbin.org/forms/post" });

  const pageState = await target.evaluate(() => ({
    submitEvents: window.__magSubmitEvents,
    unchangedUrl: location.href.startsWith("https://httpbin.org/forms/post"),
    nameFilled: Boolean(document.querySelector('[name="custname"]')?.value),
    phoneFilled: Boolean(document.querySelector('[name="custtel"]')?.value),
    emailFilled: Boolean(document.querySelector('[name="custemail"]')?.value),
    unknownBlank: document.querySelector("#mag-unknown")?.value === "",
    restrictedBlank: document.querySelector("#mag-restricted")?.value === "",
    submitButtonUntouched: !document.querySelector('[type="submit"]')?.classList.contains("mag-field-filled"),
    highlightedForReview: document.querySelectorAll(".mag-field-filled,.mag-field-review,.mag-field-missing").length > 0,
  }));
  await target.screenshot({ path: "/tmp/mag-v1-httpbin-autofill.png", fullPage: true });
  console.log(JSON.stringify({
    operatorLogin: sync.authenticated,
    exactProfileRetrieved: sync.exactProfileFound && sync.source === "SUPABASE",
    profileVersion: sync.version,
    standardCache: sync.fieldCount === 4 && sync.valuesPresent && sync.prohibited.length === 0,
    cacheKeys: sync.keys,
    activeProfiles: sync.activeProfiles,
    detected: result.analysis.detected,
    filled: result.fill.filled,
    needsReview: result.fill.needsReview,
    missing: result.fill.missing,
    items: (result.fill.items || []).map(({ label, semantic, status, confidence, reason }) => ({ label, semantic, status, confidence, reason })),
    ...pageState,
  }));
} finally {
  await context.close();
  await fs.rm(userDataDir, { recursive: true, force: true });
}
