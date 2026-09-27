// Live acceptance for persistent Supabase auth + automatic background sync.
// Runs a real Chromium with the unpacked extension against the production MAG
// project. Read-only for customer data: it signs in, syncs, and verifies
// session behavior. Output contains only booleans, counts and short SHA-256
// fingerprints — never tokens or credentials.
//   node tests/live-auth-persistence.mjs [--wait-alarm]
import { chromium } from "playwright";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const extensionDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const botEnvPath = "/Volumes/Mac Storage/Dre-Organized-2026-09-09/MAG/MAGHausPR-Bot-GitHub/.env";
const waitForAlarm = process.argv.includes("--wait-alarm");
const env = Object.fromEntries((await fs.readFile(botEnvPath, "utf8")).split(/\r?\n/).filter((line) => line && !line.trimStart().startsWith("#") && line.includes("=")).map((line) => {
  const index = line.indexOf("=");
  return [line.slice(0, index).trim(), line.slice(index + 1).trim().replace(/^(["'])(.*)\1$/, "$2")];
}));
if (!env.MAG_SUPABASE_SERVICE_EMAIL || !env.MAG_SUPABASE_SERVICE_PASSWORD) throw new Error("Operator credentials are unavailable.");

const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "mag-auth-live-"));
const results = [];
const record = (name, pass, evidence) => { results.push({ name, pass, evidence }); console.log(`${pass === null ? "N/A " : pass ? "PASS" : "FAIL"}  ${name}  ${JSON.stringify(evidence)}`); };
const launch = () => chromium.launchPersistentContext(userDataDir, { channel: "chromium", headless: true, args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`] });
async function workerOf(context) { return context.serviceWorkers()[0] || context.waitForEvent("serviceworker", { timeout: 20000 }); }
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Runs inside the service worker. Returns safe facts only.
async function inspect(worker) {
  return worker.evaluate(async () => {
    const fingerprint = async (value) => value ? [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].slice(0, 4).map((byte) => byte.toString(16).padStart(2, "0")).join("") : null;
    const session = await MAG.SupabaseClient.restoreSession();
    const local = JSON.stringify(await chrome.storage.local.get(null));
    const sessionArea = JSON.stringify(await chrome.storage.session.get(null));
    const profiles = (await chrome.storage.local.get("remoteProfiles")).remoteProfiles || [];
    const state = (await chrome.storage.local.get("syncState")).syncState || {};
    const alarm = await chrome.alarms.get("mag-profile-sync");
    return {
      connected: Boolean(session?.refresh_token),
      refreshFp: await fingerprint(session?.refresh_token),
      expiresInMin: session ? Math.round((session.expires_at * 1000 - Date.now()) / 60000) : null,
      tokensInChromeStorage: Boolean(session && (local.includes(session.refresh_token) || local.includes(session.access_token) || sessionArea.includes(session.refresh_token))),
      authState: (await chrome.storage.local.get("authState")).authState?.connected ?? null,
      profiles: profiles.length,
      statuses: profiles.reduce((counts, profile) => ({ ...counts, [profile.status || "?"]: (counts[profile.status || "?"] || 0) + 1 }), {}),
      archivedCached: profiles.filter((profile) => profile.status === "ARCHIVED").length,
      restrictedCached: profiles.filter((profile) => Object.keys(profile.dynamicFields || {}).some((key) => /ssn|social|birth|tax|bank|routing/i.test(key))).length,
      sync: { status: state.status, lastErrorCode: state.lastErrorCode || null, lastAttemptAt: state.lastAttemptAt || null, lastSuccessfulSync: state.lastSuccessfulSync || null, activeProfiles: state.activeProfiles, syncedProfiles: state.syncedProfiles },
      alarmPeriod: alarm?.periodInMinutes ?? null
    };
  });
}
// Marks the stored access token as expired (tokens themselves untouched).
const expireAccessToken = (worker, { revokeFirst = false } = {}) => worker.evaluate(async (revoke) => {
  const session = await MAG.SupabaseClient.ensureValidSession();
  if (revoke) await fetch(`${MAG.SUPABASE.url}/auth/v1/logout?scope=local`, { method: "POST", headers: { apikey: MAG.SUPABASE.publishableKey, Authorization: `Bearer ${session.access_token}` } });
  session.expires_at = Math.floor(Date.now() / 1000) - 5;
  await new Promise((resolve, reject) => { const open = indexedDB.open("mag-auth", 1); open.onsuccess = () => { const tx = open.result.transaction("kv", "readwrite"); tx.objectStore("kv").put(session, "supabaseSession"); tx.oncomplete = resolve; tx.onerror = reject; }; });
}, revokeFirst);
// Messages go through an extension page, exactly as the side panel sends them
// (a worker cannot message its own onMessage listener).
let uiPage = null;
async function send(worker, message) {
  if (!uiPage || uiPage.isClosed()) {
    uiPage = await worker.context?.()?.newPage?.() ?? await currentContext.newPage();
    await uiPage.goto(`chrome-extension://${new URL(worker.url()).host}/src/options/options.html`);
  }
  return uiPage.evaluate((msg) => chrome.runtime.sendMessage(msg), message);
}

let context = await launch();
let currentContext = context;
try {
  let worker = await workerOf(context);
  const extensionId = new URL(worker.url()).host;
  await pause(1500);
  let facts = await inspect(worker);
  record("pre: starts signed out, alarm registered", !facts.connected && facts.alarmPeriod === 5, { connected: facts.connected, alarmPeriod: facts.alarmPeriod, lastErrorCode: facts.sync.lastErrorCode });

  // T1: sign in through the real options UI; never click Sync.
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/src/options/options.html`);
  await options.locator("#email").fill(env.MAG_SUPABASE_SERVICE_EMAIL);
  await options.locator("#password").fill(env.MAG_SUPABASE_SERVICE_PASSWORD);
  await options.locator("#login").click();
  await options.locator("#message").filter({ hasText: /Signed in/ }).waitFor({ timeout: 30000 });
  const loginMessage = (await options.locator("#message").textContent()).replace(/\S+@\S+/g, "<email>");
  facts = await inspect(worker);
  record("T1 initial login: persisted + auto-synced without Sync click", facts.connected && facts.profiles > 0 && facts.sync.status === "SUCCESS" && !facts.tokensInChromeStorage && facts.authState === true,
    { loginMessage, profiles: facts.profiles, statuses: facts.statuses, tokensInChromeStorage: facts.tokensInChromeStorage, expiresInMin: facts.expiresInMin });
  record("T12/T13 statuses: non-ARCHIVED visible, no ARCHIVED, no restricted fields cached", facts.archivedCached === 0 && facts.restrictedCached === 0, { statuses: facts.statuses, activeProfiles: facts.sync.activeProfiles });

  // T12 live: a READY_FOR_REVIEW profile passes the status guard. The active
  // tab here is an extension page, so the fill itself stops at "page access".
  const reviewId = await worker.evaluate(async () => ((await chrome.storage.local.get("remoteProfiles")).remoteProfiles || []).find((profile) => profile.status === "READY_FOR_REVIEW")?.id || null);
  if (reviewId) {
    await worker.evaluate((id) => MAG.Storage.setSessionProfile(id), reviewId);
    const attempt = await options.evaluate(() => chrome.runtime.sendMessage({ type: "MAG_AUTOFILL_ACTIVE" }));
    record("T12 READY_FOR_REVIEW profile allowed past the status guard", !/not ready for autofill/.test(attempt.error || ""), { ok: attempt.ok, error: attempt.error });
    await worker.evaluate(() => MAG.Storage.setSessionProfile(""));
  } else record("T12 READY_FOR_REVIEW profile allowed past the status guard", null, { note: "no READY_FOR_REVIEW profile present in production" });

  // T2: side panel close/reopen — the panel page renders cache and stays signed in.
  const firstFp = facts.refreshFp;
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/sidepanel.html`);
  await panel.locator("#connection").filter({ hasText: "Connected as" }).waitFor({ timeout: 15000 });
  const optionCount = await panel.locator("#profile option").count();
  await panel.close();
  const reopened = await context.newPage();
  await reopened.goto(`chrome-extension://${extensionId}/src/sidepanel/sidepanel.html`);
  await reopened.locator("#connection").filter({ hasText: "Connected as" }).waitFor({ timeout: 15000 });
  await reopened.locator("#sync-meta").filter({ hasText: /synced profile/ }).waitFor({ timeout: 15000 });
  const reopenedCount = await reopened.locator("#profile option").count();
  const loginFormShown = await reopened.locator("#login-form").count();
  record("T2 close/reopen panel: still signed in, cached profiles listed", reopenedCount === optionCount && optionCount > 0 && loginFormShown === 0, { firstOpen: optionCount, reopened: reopenedCount, connection: await reopened.locator("#connection").textContent(), syncMeta: (await reopened.locator("#sync-meta").textContent()).replace(/\d{1,2}\/\d{1,2}\/\d{4}.*/, "<time>") });
  await reopened.close();

  // T4: kill the service worker; Chrome restarts it on the next event.
  const cdp = await context.browser()?.newBrowserCDPSession?.().catch(() => null);
  let killed = false;
  if (cdp) {
    const { targetInfos } = await cdp.send("Target.getTargets");
    const target = targetInfos.find((info) => info.type === "service_worker" && info.url.includes(extensionId));
    if (target) { await cdp.send("Target.closeTarget", { targetId: target.targetId }).catch(() => undefined); killed = true; }
  }
  if (!killed) {
    // Fallback: stop via DevTools on the options page.
    const pageCdp = await context.newCDPSession(options);
    await pageCdp.send("ServiceWorker.enable").catch(() => undefined);
    await pageCdp.send("ServiceWorker.stopAllWorkers").then(() => { killed = true; }).catch(() => undefined);
  }
  await pause(1500);
  const statusAfterKill = await options.evaluate(() => chrome.runtime.sendMessage({ type: "MAG_AUTH_STATUS" }));
  const forcedAfterKill = await options.evaluate(() => chrome.runtime.sendMessage({ type: "MAG_SYNC_PROFILES", force: true }));
  worker = await workerOf(context);
  record("T4 service-worker restart: session restores, requests work", killed && statusAfterKill.data?.connected === true && forcedAfterKill.data?.offline === false, { workerStopped: killed, connected: statusAfterKill.data?.connected, syncOffline: forcedAfterKill.data?.offline });

  // T6/T7: force the access token to look expired; the real refresh endpoint rotates it.
  await expireAccessToken(worker);
  const beforeRefresh = (await inspect(worker)).refreshFp;
  const afterExpiry = await send(worker, { type: "MAG_SYNC_PROFILES", force: true });
  facts = await inspect(worker);
  const secondFp = facts.refreshFp;
  record("T6 expired access token: refreshed, request succeeded, no prompt", afterExpiry.data?.offline === false && facts.connected && facts.expiresInMin > 5, { syncOffline: afterExpiry.data?.offline, expiresInMin: facts.expiresInMin });
  await expireAccessToken(worker);
  const secondRefresh = await send(worker, { type: "MAG_SYNC_PROFILES", force: true });
  facts = await inspect(worker);
  record("T7 rotated refresh token persisted; next refresh with it works", beforeRefresh !== secondFp && secondFp !== facts.refreshFp && secondRefresh.data?.offline === false && facts.connected, { fingerprints: [beforeRefresh, secondFp, facts.refreshFp], secondSyncOffline: secondRefresh.data?.offline });

  // T9: backend unreachable (fetch blocked inside the worker), then recovery.
  await worker.evaluate(() => { globalThis.__realFetch = fetch; globalThis.fetch = () => Promise.reject(new TypeError("Failed to fetch")); });
  const offline = await send(worker, { type: "MAG_SYNC_PROFILES", force: true });
  const offlineFacts = await inspect(worker);
  await worker.evaluate(() => { globalThis.fetch = globalThis.__realFetch; });
  const recovered = await send(worker, { type: "MAG_SYNC_PROFILES", force: true });
  facts = await inspect(worker);
  record("T9 network failure: still signed in, cache intact, OFFLINE recorded, recovers", offline.data?.offline === true && offline.data?.lastErrorCode === "OFFLINE" && offlineFacts.connected && offlineFacts.profiles === facts.profiles && recovered.data?.offline === false && facts.sync.status === "SUCCESS",
    { offlineCode: offline.data?.lastErrorCode, connectedWhileOffline: offlineFacts.connected, cacheWhileOffline: offlineFacts.profiles, recovered: recovered.data?.offline === false });

  // T3: fully quit and relaunch the browser with the same profile directory.
  const beforeQuit = facts;
  await context.close();
  const quitAt = new Date().toISOString();
  context = await launch();
  currentContext = context;
  uiPage = null;
  worker = await workerOf(context);
  await pause(6000);
  facts = await inspect(worker);
  record("T3 browser restart: session restored, startup sync ran, no prompt", facts.connected && facts.sync.lastAttemptAt > quitAt && facts.sync.status === "SUCCESS" && facts.profiles === beforeQuit.profiles,
    { connected: facts.connected, startupSyncAfterRelaunch: facts.sync.lastAttemptAt > quitAt, status: facts.sync.status, profiles: facts.profiles, alarmPeriod: facts.alarmPeriod });

  // T5: not automatable here. Playwright's Chromium disables a --load-extension
  // extension when it calls chrome.runtime.reload() (ERR_BLOCKED_BY_CLIENT, no
  // worker). Covered by the unit simulation and the owner's manual reload.
  record("T5 extension reload", null, { note: "harness limitation: reload disables command-line-loaded extensions under Playwright" });

  // T10 (mechanism): the 5-minute alarm syncs with no user action.
  if (waitForAlarm) {
    const idleFrom = facts.sync.lastAttemptAt;
    await pause(5.5 * 60 * 1000);
    facts = await inspect(worker);
    record("T10 periodic alarm sync ran unattended", facts.sync.lastAttemptAt > idleFrom && facts.sync.status === "SUCCESS" && facts.connected, { before: idleFrom, after: facts.sync.lastAttemptAt });
  }

  // T8: really revoke this session server-side, then force a refresh.
  await expireAccessToken(worker, { revokeFirst: true });
  const cacheBefore = (await inspect(worker)).profiles;
  const revoked = await send(worker, { type: "MAG_SYNC_PROFILES", force: true });
  facts = await inspect(worker);
  const restAfter = await worker.evaluate(() => MAG.SupabaseClient.rest("mag_profiles?select=id&limit=1").then(() => "allowed").catch((error) => error.code));
  record("T8 revoked refresh token: signed out, cache kept, auth required", revoked.data?.lastErrorCode === "AUTH_REQUIRED" && !facts.connected && facts.authState === false && facts.profiles === cacheBefore && restAfter === "AUTH_REQUIRED",
    { lastErrorCode: revoked.data?.lastErrorCode, connected: facts.connected, cacheKept: facts.profiles === cacheBefore, protectedCall: restAfter });

  // Logout: sign in again through the UI, then log out; no tokens left behind.
  const page = await context.newPage();
  await page.goto(`chrome-extension://${new URL(worker.url()).host}/src/options/options.html`);
  await page.locator("#email").fill(env.MAG_SUPABASE_SERVICE_EMAIL);
  await page.locator("#password").fill(env.MAG_SUPABASE_SERVICE_PASSWORD);
  await page.locator("#login").click();
  await page.locator("#message").filter({ hasText: /Signed in/ }).waitFor({ timeout: 30000 });
  await page.locator("#logout").click();
  await page.locator("#auth-status").filter({ hasText: "Not connected" }).waitFor({ timeout: 15000 });
  const vaultEmpty = await worker.evaluate(async () => !(await MAG.SupabaseClient.restoreSession()));
  facts = await inspect(worker);
  record("logout: tokens cleared, cache preserved", vaultEmpty && !facts.connected && facts.profiles > 0, { vaultEmpty, profiles: facts.profiles });
} finally {
  await context.close().catch(() => undefined);
  await fs.rm(userDataDir, { recursive: true, force: true });
}
const failed = results.filter((item) => item.pass === false);
console.log(`\n${results.filter((item) => item.pass).length} passed, ${failed.length} failed, ${results.filter((item) => item.pass === null).length} not applicable`);
process.exitCode = failed.length ? 1 : 0;
