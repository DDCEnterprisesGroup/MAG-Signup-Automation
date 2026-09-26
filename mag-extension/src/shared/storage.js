(function initializeStorage(root) {
  "use strict";
  const MAG = (root.MAG = root.MAG || {});
  const KEYS = Object.freeze({
    profiles: "profiles", settings: "settings", domainProfiles: "domainProfiles", logs: "debugLogs",
    remoteProfiles: "remoteProfiles", fieldRegistry: "fieldRegistry", syncState: "syncState", authState: "authState"
  });
  const SESSION_PROFILE_KEY = "magActiveProfileId";
  const DEFAULT_SYNC_STATE = Object.freeze({ lastSuccessfulSync: null, status: "NEVER", conflicts: [] });

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  async function ensureInitialized() {
    const current = await chrome.storage.local.get([KEYS.profiles, KEYS.settings, KEYS.domainProfiles, KEYS.remoteProfiles, KEYS.fieldRegistry, KEYS.syncState]);
    const updates = {};
    if (!Array.isArray(current[KEYS.profiles])) updates[KEYS.profiles] = [];
    if (!current[KEYS.settings]) updates[KEYS.settings] = { ...MAG.DEFAULT_SETTINGS };
    if (!current[KEYS.domainProfiles]) updates[KEYS.domainProfiles] = {};
    if (!Array.isArray(current[KEYS.remoteProfiles])) updates[KEYS.remoteProfiles] = [];
    if (!Array.isArray(current[KEYS.fieldRegistry])) updates[KEYS.fieldRegistry] = [];
    if (!current[KEYS.syncState]) updates[KEYS.syncState] = { ...DEFAULT_SYNC_STATE };
    if (Object.keys(updates).length) await chrome.storage.local.set(updates);
  }

  async function getProfiles() {
    await ensureInitialized();
    const stored = await chrome.storage.local.get([KEYS.profiles, KEYS.remoteProfiles]);
    const local = stored[KEYS.profiles] || [];
    const remote = stored[KEYS.remoteProfiles] || [];
    return [...local, ...remote.filter((candidate) => !local.some((item) => item.id === candidate.id))];
  }

  async function saveProfiles(profiles) {
    validateProfiles(profiles);
    if (profiles.some((profile) => profile?.sync?.source === "SUPABASE")) throw new Error("Synced profiles are read-only. Update and approve them in MAG, then sync.");
    await chrome.storage.local.set({ [KEYS.profiles]: profiles });
  }

  function validateProfiles(profiles) {
    if (!Array.isArray(profiles)) throw new Error("Profile import must be a JSON array.");
    const ids = new Set();
    for (const profile of profiles) {
      if (!profile || typeof profile !== "object" || !String(profile.id || "").trim() || !String(profile.label || "").trim()) {
        throw new Error("Each profile requires a non-empty id and label.");
      }
      if (ids.has(profile.id)) throw new Error(`Duplicate profile id: ${profile.id}`);
      ids.add(profile.id);
    }
  }

  async function getSettings() {
    await ensureInitialized();
    return { ...MAG.DEFAULT_SETTINGS, ...(await chrome.storage.local.get(KEYS.settings))[KEYS.settings] };
  }

  async function saveSettings(settings) {
    const merged = { ...MAG.DEFAULT_SETTINGS, ...settings };
    if (!Object.keys(MAG.CONFIDENCE).includes(merged.autofillThreshold)) throw new Error("Invalid autofill threshold.");
    await chrome.storage.local.set({ [KEYS.settings]: merged });
  }

  async function rememberDomainProfile(hostname, profileId) {
    const current = (await chrome.storage.local.get(KEYS.domainProfiles))[KEYS.domainProfiles] || {};
    current[hostname] = profileId;
    await chrome.storage.local.set({ [KEYS.domainProfiles]: current });
  }

  async function getDomainProfile(hostname) {
    const current = (await chrome.storage.local.get(KEYS.domainProfiles))[KEYS.domainProfiles] || {};
    return current[hostname] || "";
  }

  async function appendLog(entry) {
    const settings = await getSettings();
    if (!settings.debug) return;
    const current = (await chrome.storage.local.get(KEYS.logs))[KEYS.logs] || [];
    current.push({ at: new Date().toISOString(), ...entry });
    await chrome.storage.local.set({ [KEYS.logs]: current.slice(-200) });
  }

  function validateRemoteCache(profiles, definitions) {
    validateProfiles(profiles);
    const allowed = new Set(definitions.filter((item) => item.active && item.security_class === "STANDARD" && item.cache_policy === "LOCAL").map((item) => item.canonical_key));
    for (const profile of profiles) {
      if (profile?.sync?.source !== "SUPABASE") throw new Error("Remote cache entry lacks Supabase provenance.");
      for (const key of Object.keys(profile.dynamicFields || {})) {
        if (!allowed.has(key)) throw new Error(`Field ${key} is not permitted in the local cache.`);
      }
    }
  }

  async function replaceRemoteCache(profiles, definitions, state) {
    validateRemoteCache(profiles, definitions);
    await chrome.storage.local.set({
      [KEYS.remoteProfiles]: clone(profiles),
      [KEYS.fieldRegistry]: clone(definitions),
      [KEYS.syncState]: { ...state, status: "SUCCESS", lastAttemptAt: new Date().toISOString(), lastSuccessfulSync: new Date().toISOString() }
    });
  }

  async function getFieldRegistry() { return (await chrome.storage.local.get(KEYS.fieldRegistry))[KEYS.fieldRegistry] || []; }
  async function getSyncState() { return (await chrome.storage.local.get(KEYS.syncState))[KEYS.syncState] || { ...DEFAULT_SYNC_STATE }; }

  // Matches the background alarm cadence, so opening MAG right after a
  // periodic sync does not repeat it.
  async function isSyncStale(maxAgeMs = MAG.SYNC_INTERVAL_MINUTES * 60 * 1000) {
    const state = await getSyncState();
    if (state.status === "OFFLINE" || !state.lastSuccessfulSync) return true;
    const lastSuccessful = Date.parse(state.lastSuccessfulSync);
    return !Number.isFinite(lastSuccessful) || Date.now() - lastSuccessful >= maxAgeMs;
  }

  function errorCode(error) {
    if (["AUTH_REQUIRED", "AUTH_INVALID"].includes(error?.code)) return "AUTH_REQUIRED";
    if (["OFFLINE", "SYNC_UNAVAILABLE"].includes(error?.code)) return error.code;
    const reason = String(error?.message || "").toLowerCase();
    return reason.includes("sign in") || reason.includes("session") ? "AUTH_REQUIRED" : "SYNC_UNAVAILABLE";
  }

  async function recordSyncFailure(error) {
    const current = await getSyncState();
    const state = {
      ...current,
      status: "OFFLINE",
      lastAttemptAt: new Date().toISOString(),
      lastErrorCode: errorCode(error)
    };
    await chrome.storage.local.set({ [KEYS.syncState]: state });
    return state;
  }

  // Token-free auth metadata (signed in, user, expiry) for extension pages.
  // The tokens themselves live only in the service worker's IndexedDB vault.
  async function setAuthState(state) { await chrome.storage.local.set({ [KEYS.authState]: { ...state, updatedAt: new Date().toISOString() } }); }
  async function getAuthState() { return (await chrome.storage.local.get(KEYS.authState))[KEYS.authState] || { connected: false }; }

  async function setSessionProfile(profileId) {
    if (!chrome.storage.session) return;
    if (profileId) await chrome.storage.session.set({ [SESSION_PROFILE_KEY]: profileId });
    else await chrome.storage.session.remove(SESSION_PROFILE_KEY);
  }

  async function getSessionProfile() {
    if (!chrome.storage.session) return "";
    return (await chrome.storage.session.get(SESSION_PROFILE_KEY))[SESSION_PROFILE_KEY] || "";
  }

  MAG.Storage = Object.freeze({ ensureInitialized, getProfiles, saveProfiles, validateProfiles, getSettings, saveSettings, rememberDomainProfile, getDomainProfile, appendLog, validateRemoteCache, replaceRemoteCache, getFieldRegistry, getSyncState, isSyncStale, recordSyncFailure, setAuthState, getAuthState, setSessionProfile, getSessionProfile, KEYS });
})(globalThis);
