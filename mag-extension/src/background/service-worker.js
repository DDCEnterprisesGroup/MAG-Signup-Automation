"use strict";
importScripts(
  "../shared/constants.js", "../shared/storage.js",
  "../shared/supabase-config.js", "supabase-client.js", "sync-engine.js"
);

const SYNC_ALARM = "mag-profile-sync";
let profileRefreshPromise = null;

// Single flight: overlapping triggers (startup, alarm, side panel, manual)
// share one sync. Order is always: restore auth → refresh token if needed →
// sync profiles → update cache state.
async function refreshProfiles({ force = false, reason = "background" } = {}) {
  await MAG.Storage.ensureInitialized();
  if (!force && !(await MAG.Storage.isSyncStale())) {
    return { skipped: true, ...(await MAG.Storage.getSyncState()) };
  }
  if (profileRefreshPromise) return profileRefreshPromise;
  profileRefreshPromise = (async () => {
    try {
      await MAG.SupabaseClient.ensureValidSession();
      return { ...(await MAG.SyncEngine.sync({ reason })), offline: false };
    } catch (error) {
      const state = await MAG.Storage.recordSyncFailure(error);
      // A failed refresh never replaces the last valid remoteProfiles cache.
      return { offline: true, lastErrorCode: state.lastErrorCode, activeProfiles: state.activeProfiles || 0, syncedProfiles: state.syncedProfiles || 0, lastSuccessfulSync: state.lastSuccessfulSync || null };
    } finally {
      profileRefreshPromise = null;
    }
  })();
  return profileRefreshPromise;
}

function startBackgroundRefresh(options) {
  refreshProfiles(options).catch(() => undefined);
}

// Periodic background sync. Alarms persist across worker suspension; this
// re-creates the alarm only if it is missing (fresh install, reload, update).
async function ensureSyncAlarm() {
  if (!chrome.alarms) return;
  const existing = await chrome.alarms.get(SYNC_ALARM);
  if (!existing || existing.periodInMinutes !== MAG.SYNC_INTERVAL_MINUTES) {
    await chrome.alarms.create(SYNC_ALARM, { delayInMinutes: MAG.SYNC_INTERVAL_MINUTES, periodInMinutes: MAG.SYNC_INTERVAL_MINUTES });
  }
}

chrome.alarms?.onAlarm.addListener((alarm) => {
  // Quiet: no UI, no notifications, no logout on a failed scheduled sync.
  if (alarm.name === SYNC_ALARM) startBackgroundRefresh({ force: true, reason: "background" });
});

chrome.runtime.onInstalled.addListener(async () => {
  await MAG.Storage.ensureInitialized();
  await chrome.action.setBadgeBackgroundColor({ color: "#2457d6" });
  await ensureSyncAlarm().catch(() => undefined);
  // Install/update/reload keeps the persisted session; no forced logout.
  startBackgroundRefresh({ force: true, reason: "background" });
});

chrome.runtime.onStartup?.addListener(() => {
  // Local profiles are available immediately; this is an authenticated,
  // best-effort refresh and must never block extension startup.
  ensureSyncAlarm().catch(() => undefined);
  startBackgroundRefresh({ force: true, reason: "background" });
});

ensureSyncAlarm().catch(() => undefined);

chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => undefined);

async function authorizedValuesFor(profile) {
  const values = {};
  const restricted = ["date_of_birth", "ssn"];
  for (const canonicalKey of restricted) {
    try {
      const result = await MAG.SupabaseClient.invoke(MAG.SUPABASE.restrictedFunction, { profileId: profile.sync.remoteId, canonicalKey });
      if (result?.value) values[canonicalKey] = result.value;
    } catch (error) {
      // Ordinary fields still fill when a protected value is unavailable. The
      // side panel reports this without exposing the protected error details.
      // A protected value that cannot be hydrated must not block ordinary
      // profile autofill. The operator's single Autofill action remains the
      // authorization boundary; protected fields simply stay skipped.
    }
  }
  return values;
}

const AUTOFILL_READY_STATUSES = new Set(["READY_FOR_REVIEW", "ACTIVE"]);

async function autofillActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active browser tab is available.");
  const selectedId = await MAG.Storage.getSessionProfile();
  const profiles = await MAG.Storage.getProfiles();
  const profile = profiles.find((item) => item.id === selectedId);
  if (!profile) throw new Error("Choose a MAG profile in the side panel first.");

  // Synced profiles autofill once they are complete enough for review;
  // DRAFT, INCOMPLETE and any other status stay blocked.
  if (
    profile.sync?.source === "SUPABASE" &&
    !AUTOFILL_READY_STATUSES.has(profile.status)
  ) {
    throw new Error("This profile is not ready for autofill yet.");
  }

  const settings = await MAG.Storage.getSettings();
  const registry = await MAG.Storage.getFieldRegistry();
  const authorizedValues = profile.sync?.remoteId ? await authorizedValuesFor(profile) : {};
  const response = await chrome.tabs.sendMessage(tab.id, { type: MAG.MESSAGE.AUTOFILL, profile, settings, registry, authorizedValues });
  if (!response?.ok) throw new Error(response?.error || "MAG could not access this page.");
  return response.summary;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if ([MAG.MESSAGE.AUTH_STATUS, MAG.MESSAGE.AUTH_LOGIN, MAG.MESSAGE.AUTH_LOGOUT, MAG.MESSAGE.MFA_VERIFY, MAG.MESSAGE.AUDIT_EVENT, MAG.MESSAGE.SYNC_PROFILES, MAG.MESSAGE.RESTRICTED_UNLOCK].includes(message.type)) {
    (async () => {
      if (message.type === MAG.MESSAGE.AUTH_STATUS) return MAG.SupabaseClient.status();
      if (message.type === MAG.MESSAGE.AUTH_LOGIN) {
        const auth = await MAG.SupabaseClient.login(message.email, message.password);
        // Signing in immediately syncs; the user never has to press Sync. A sync
        // already in flight started signed out, so wait for it and run fresh.
        if (profileRefreshPromise) await profileRefreshPromise;
        return { ...auth, sync: await refreshProfiles({ force: true, reason: "login" }) };
      }
      if (message.type === MAG.MESSAGE.AUTH_LOGOUT) {
        await MAG.Storage.setSessionProfile("");
        return MAG.SupabaseClient.logout();
      }
      if (message.type === MAG.MESSAGE.MFA_VERIFY) return MAG.SupabaseClient.verifyMfa(message.code);
      if (message.type === MAG.MESSAGE.AUDIT_EVENT) return MAG.SupabaseClient.audit(message.action, message.entityId, message.fieldCanonicalKey);
      if (message.type === MAG.MESSAGE.SYNC_PROFILES) return refreshProfiles({ force: Boolean(message.force), reason: message.force ? "manual" : "panel" });
      if (message.type === MAG.MESSAGE.RESTRICTED_UNLOCK) {
        if (!MAG.RESTRICTED_AUTOFILL_ENABLED) throw new Error("RESTRICTED_AUTOFILL_DISABLED");
        return MAG.SupabaseClient.invoke(MAG.SUPABASE.restrictedFunction, { profileId: message.profileId, canonicalKey: message.canonicalKey });
      }
    })().then((data) => sendResponse({ ok: true, data })).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === "MAG_AUTOFILL_ACTIVE") {
    autofillActiveTab().then((data) => sendResponse({ ok: true, data })).catch((error) => sendResponse({ ok: false, error: error?.message || "Autofill failed." }));
    return true;
  }
  if (message.type !== MAG.MESSAGE.FORM_DETECTED || !sender.tab?.id) return;
  const text = message.supported ? String(Math.min(message.detected, 99)) : "";
  chrome.action.setBadgeText({ tabId: sender.tab.id, text }).catch(() => undefined);
  chrome.action.setTitle({
    tabId: sender.tab.id,
    title: message.supported ? `MAG detected ${message.detected} editable field${message.detected === 1 ? "" : "s"}` : "MAG Autofill Assistant"
  }).catch(() => undefined);
});

chrome.commands.onCommand.addListener((command) => {
  if (command !== "autofill-active-profile") return;
  autofillActiveTab().then((summary) => {
    chrome.action.setBadgeText({ text: String(Math.min(summary?.filled || 0, 99)) }).catch(() => undefined);
  }).catch(() => undefined);
});
