"use strict";
importScripts(
  "../shared/constants.js", "../data/initial-profiles.js", "../shared/storage.js",
  "../shared/supabase-config.js", "supabase-client.js", "sync-engine.js"
);

chrome.runtime.onInstalled.addListener(async () => {
  await MAG.Storage.ensureInitialized();
  await chrome.action.setBadgeBackgroundColor({ color: "#2457d6" });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if ([MAG.MESSAGE.AUTH_STATUS, MAG.MESSAGE.AUTH_LOGIN, MAG.MESSAGE.AUTH_LOGOUT, MAG.MESSAGE.MFA_VERIFY, MAG.MESSAGE.AUDIT_EVENT, MAG.MESSAGE.SYNC_PROFILES, MAG.MESSAGE.RESTRICTED_UNLOCK].includes(message.type)) {
    (async () => {
      if (message.type === MAG.MESSAGE.AUTH_STATUS) return MAG.SupabaseClient.status();
      if (message.type === MAG.MESSAGE.AUTH_LOGIN) return MAG.SupabaseClient.login(message.email, message.password);
      if (message.type === MAG.MESSAGE.AUTH_LOGOUT) return MAG.SupabaseClient.logout();
      if (message.type === MAG.MESSAGE.MFA_VERIFY) return MAG.SupabaseClient.verifyMfa(message.code);
      if (message.type === MAG.MESSAGE.AUDIT_EVENT) return MAG.SupabaseClient.audit(message.action, message.entityId, message.fieldCanonicalKey);
      if (message.type === MAG.MESSAGE.SYNC_PROFILES) return MAG.SyncEngine.sync();
      if (message.type === MAG.MESSAGE.RESTRICTED_UNLOCK) {
        return MAG.SupabaseClient.invoke(MAG.SUPABASE.restrictedFunction, { profileId: message.profileId, canonicalKey: message.canonicalKey });
      }
    })().then((data) => sendResponse({ ok: true, data })).catch((error) => sendResponse({ ok: false, error: error.message }));
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
