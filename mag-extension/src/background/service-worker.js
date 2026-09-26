"use strict";
importScripts(
  "../shared/constants.js", "../shared/storage.js",
  "../shared/supabase-config.js", "supabase-client.js", "sync-engine.js"
);

let profileRefreshPromise = null;

async function refreshProfiles({ force = false } = {}) {
  await MAG.Storage.ensureInitialized();
  if (!force && !(await MAG.Storage.isSyncStale())) {
    return { skipped: true, ...(await MAG.Storage.getSyncState()) };
  }
  if (profileRefreshPromise) return profileRefreshPromise;
  profileRefreshPromise = (async () => {
    try {
      return { ...(await MAG.SyncEngine.sync()), offline: false };
    } catch (error) {
      const state = await MAG.Storage.recordSyncFailure(error);
      // A failed refresh never replaces the last valid remoteProfiles cache.
      return { offline: true, activeProfiles: state.activeProfiles || 0, lastSuccessfulSync: state.lastSuccessfulSync || null };
    } finally {
      profileRefreshPromise = null;
    }
  })();
  return profileRefreshPromise;
}

function startBackgroundRefresh() {
  refreshProfiles().catch(() => undefined);
}

chrome.runtime.onInstalled.addListener(async () => {
  await MAG.Storage.ensureInitialized();
  await chrome.action.setBadgeBackgroundColor({ color: "#2457d6" });
  startBackgroundRefresh();
});

chrome.runtime.onStartup?.addListener(() => {
  // Local profiles are available immediately; this is an authenticated,
  // best-effort refresh and must never block extension startup.
  startBackgroundRefresh();
});

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

async function autofillActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active browser tab is available.");
  const selectedId = await MAG.Storage.getSessionProfile();
  const profiles = await MAG.Storage.getProfiles();
  const profile = profiles.find((item) => item.id === selectedId);
  if (!profile) throw new Error("Choose a MAG profile in the side panel first.");
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
      if (message.type === MAG.MESSAGE.AUTH_LOGIN) return MAG.SupabaseClient.login(message.email, message.password);
      if (message.type === MAG.MESSAGE.AUTH_LOGOUT) {
        await MAG.Storage.setSessionProfile("");
        return MAG.SupabaseClient.logout();
      }
      if (message.type === MAG.MESSAGE.MFA_VERIFY) return MAG.SupabaseClient.verifyMfa(message.code);
      if (message.type === MAG.MESSAGE.AUDIT_EVENT) return MAG.SupabaseClient.audit(message.action, message.entityId, message.fieldCanonicalKey);
      if (message.type === MAG.MESSAGE.SYNC_PROFILES) return refreshProfiles({ force: Boolean(message.force) });
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
