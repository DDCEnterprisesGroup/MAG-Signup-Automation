(function initializeSupabaseClient(root) {
  "use strict";
  const MAG = (root.MAG = root.MAG || {});
  const LEGACY_SESSION_KEY = "magSupabaseSession";
  const VAULT_KEY = "supabaseSession";
  // Refresh proactively when the access token has less than this much life
  // left. Supabase issues ~60 minute tokens; the periodic alarm runs every 5.
  const REFRESH_MARGIN_MS = 5 * 60 * 1000;

  // Error codes shared with the sync state and UI:
  //   AUTH_REQUIRED — no usable session; the user must sign in.
  //   AUTH_INVALID  — Supabase rejected the session (expired/revoked refresh token).
  //   OFFLINE       — the network request itself failed; the session is kept.
  //   SYNC_UNAVAILABLE — Supabase answered with a server/rate-limit error; the session is kept.
  class MagError extends Error {
    constructor(message, code, status = 0) { super(message); this.code = code; this.status = status; }
  }

  // Tokens live in the extension origin's IndexedDB, which is persistent
  // (survives browser restart, worker suspension and extension reload/update)
  // and, unlike chrome.storage.local, is not readable from content scripts.
  // Only the service worker loads this file.
  const indexedDbVault = (() => {
    let opening = null;
    function open() {
      if (!root.indexedDB) return Promise.reject(new MagError("Secure session storage is unavailable.", "AUTH_REQUIRED"));
      opening ||= new Promise((resolve, reject) => {
        const request = root.indexedDB.open("mag-auth", 1);
        request.onupgradeneeded = () => request.result.createObjectStore("kv");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => { opening = null; reject(request.error); };
      });
      return opening;
    }
    async function run(mode, action) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction("kv", mode);
        const request = action(transaction.objectStore("kv"));
        transaction.oncomplete = () => resolve(request.result);
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
    }
    return {
      get: (key) => run("readonly", (store) => store.get(key)),
      set: (key, value) => run("readwrite", (store) => store.put(value, key)),
      remove: (key) => run("readwrite", (store) => store.delete(key))
    };
  })();
  const vault = () => MAG.AuthVault || indexedDbVault;

  async function request(path, options = {}, token = "") {
    if (!/^https:\/\/[a-z0-9]+\.supabase\.co$/.test(MAG.SUPABASE.url || "") ||
        MAG.SUPABASE.url === "https://swsnttpchmxekbftcvlu.supabase.co" ||
        !MAG.SUPABASE.publishableKey?.startsWith("sb_publishable_")) {
      throw new Error("Dedicated MAG Supabase project is not configured.");
    }
    let response;
    try {
      response = await fetch(`${MAG.SUPABASE.url}${path}`, {
        ...options,
        cache: "no-store",
        headers: {
          apikey: MAG.SUPABASE.publishableKey,
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          "Content-Type": "application/json",
          ...(options.headers || {})
        }
      });
    } catch {
      throw new MagError("MAG service is unreachable.", "OFFLINE");
    }
    const body = response.status === 204 ? null : await response.json().catch(() => null);
    if (!response.ok) {
      const message = body?.msg || body?.message || body?.error_description || body?.error || `MAG service returned ${response.status}.`;
      const code = response.status >= 500 || response.status === 429 ? "SYNC_UNAVAILABLE" : response.status === 401 ? "AUTH_INVALID" : "REQUEST_FAILED";
      throw new MagError(message, code, response.status);
    }
    return body;
  }

  // Persist only what the extension needs. The password is never stored.
  function slim(value) {
    const expiresAt = Number(value.expires_at) || Math.floor(Date.now() / 1000) + (Number(value.expires_in) || 3600);
    return {
      access_token: value.access_token,
      refresh_token: value.refresh_token,
      token_type: value.token_type || "bearer",
      expires_at: expiresAt,
      user: value.user ? { id: value.user.id, email: value.user.email, user_metadata: { full_name: value.user.user_metadata?.full_name } } : null
    };
  }

  function publicState(current, extra = {}) {
    return {
      connected: Boolean(current?.refresh_token),
      userId: current?.user?.id || null,
      email: current?.user?.email || null,
      displayName: current?.user?.user_metadata?.full_name || current?.user?.email || null,
      expiresAt: current?.expires_at ? new Date(current.expires_at * 1000).toISOString() : null,
      ...extra
    };
  }

  async function getSession() { return (await vault().get(VAULT_KEY)) || null; }

  async function setSession(value, extra = {}) {
    const stored = value ? slim(value) : null;
    if (stored) await vault().set(VAULT_KEY, stored); else await vault().remove(VAULT_KEY);
    // Safe, token-free metadata that open extension pages can observe.
    await MAG.Storage?.setAuthState?.(publicState(stored, extra));
    return stored;
  }

  // One-time move of a session saved by versions that used session storage.
  async function restoreSession() {
    let current = await getSession();
    if (!current && root.chrome?.storage?.session) {
      const legacy = (await chrome.storage.session.get(LEGACY_SESSION_KEY))[LEGACY_SESSION_KEY];
      if (legacy?.refresh_token) current = await setSession(legacy);
      await chrome.storage.session.remove(LEGACY_SESSION_KEY).catch(() => undefined);
    }
    return current;
  }

  // Single flight: concurrent callers share one refresh-token exchange so a
  // rotated refresh token is never presented twice.
  let refreshing = null;
  function refreshSession() {
    refreshing ||= (async () => {
      try {
        // Re-read inside the lock: the persisted session is authoritative after
        // worker suspension and may already hold a newer rotated token.
        const current = await restoreSession();
        if (!current?.refresh_token) throw new MagError("Sign in to sync MAG profiles.", "AUTH_REQUIRED");
        let next;
        try {
          next = await request("/auth/v1/token?grant_type=refresh_token", { method: "POST", body: JSON.stringify({ refresh_token: current.refresh_token }) });
        } catch (error) {
          // Only a 400/401/403 from the token endpoint (refresh token expired,
          // revoked or already used) clears the session. Network and server
          // errors keep it for the next attempt. The profile cache always stays.
          if (![400, 401, 403].includes(error.status)) throw error;
          await setSession(null, { lastErrorCode: "AUTH_INVALID" });
          throw new MagError("Your MAG session expired. Sign in again.", "AUTH_REQUIRED", error.status);
        }
        if (!next?.access_token || !next?.refresh_token) throw new MagError("MAG service returned an incomplete session.", "SYNC_UNAVAILABLE");
        return await setSession(next);
      } finally { refreshing = null; }
    })();
    return refreshing;
  }

  async function ensureValidSession() {
    const current = await restoreSession();
    if (!current?.refresh_token) throw new MagError("Sign in to sync MAG profiles.", "AUTH_REQUIRED");
    if ((current.expires_at || 0) * 1000 <= Date.now() + REFRESH_MARGIN_MS) return refreshSession();
    return current;
  }

  // Every REST/Edge call goes through here. A 401 on a token we believed valid
  // (clock skew, server-side revocation of the access token) gets one refresh.
  async function authorized(path, options = {}) {
    const current = await ensureValidSession();
    try { return await request(path, options, current.access_token); }
    catch (error) {
      if (error.status !== 401) throw error;
      const next = await refreshSession();
      return request(path, options, next.access_token);
    }
  }

  async function login(email, password) {
    if (!email || !password) throw new Error("Email and password are required.");
    const result = await request("/auth/v1/token?grant_type=password", { method: "POST", body: JSON.stringify({ email, password }) });
    await setSession(result);
    await request("/rest/v1/mag_audit_events", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ actor_id: result.user.id, action: "EXTENSION_LOGIN", entity_type: "SESSION", success: true, metadata: { client: "mag_extension" } }) }, result.access_token).catch(() => undefined);
    return status();
  }

  async function logout() {
    let current = null;
    try {
      current = await ensureValidSession();
      await request("/rest/v1/mag_audit_events", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ actor_id: current.user.id, action: "EXTENSION_LOGOUT", entity_type: "SESSION", success: true, metadata: { client: "mag_extension" } }) }, current.access_token).catch(() => undefined);
      // scope=local revokes this extension's refresh token without signing the
      // same account out of MAG Admin or other devices.
      await request("/auth/v1/logout?scope=local", { method: "POST" }, current.access_token).catch(() => undefined);
    } catch { /* Already signed out or offline: local tokens are still cleared. */ }
    finally { await setSession(null); }
    return status();
  }

  // Local only: never waits on the network, so opening MAG is instant.
  async function status() {
    const current = await restoreSession();
    let aal = null;
    try { if (current?.access_token) aal = JSON.parse(atob(current.access_token.split(".")[1].replaceAll("-", "+").replaceAll("_", "/"))).aal || "aal1"; } catch { aal = null; }
    const state = publicState(current);
    return { connected: state.connected, aal, expiresAt: state.expiresAt, user: current?.user ? { id: state.userId, email: state.email, displayName: state.displayName } : null };
  }

  async function verifyMfa(code) {
    if (!/^\d{6,10}$/.test(String(code || "").trim())) throw new Error("Enter a valid authenticator code.");
    const current = await ensureValidSession();
    const user = await request("/auth/v1/user", {}, current.access_token);
    const factor = (user?.factors || []).find((item) => item.status === "verified" && item.factor_type === "totp");
    if (!factor) throw new Error("No verified TOTP factor is enrolled for this MAG account.");
    const challenge = await request(`/auth/v1/factors/${factor.id}/challenge`, { method: "POST", body: JSON.stringify({ factorId: factor.id }) }, current.access_token);
    const elevated = await request(`/auth/v1/factors/${factor.id}/verify`, { method: "POST", body: JSON.stringify({ challenge_id: challenge.id, code: String(code).trim() }) }, current.access_token);
    await setSession(elevated);
    return status();
  }

  async function audit(action, entityId, fieldCanonicalKey) {
    if (!["RESTRICTED_FILL_APPROVED"].includes(action)) throw new Error("Unsupported audit action.");
    const current = await ensureValidSession();
    return authorized("/rest/v1/mag_audit_events", {
      method: "POST", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ actor_id: current.user.id, action, entity_type: "PROFILE", entity_id: entityId, field_canonical_key: fieldCanonicalKey, success: true, metadata: { client: "mag_extension" } })
    });
  }

  async function rest(path, options = {}) { return authorized(`/rest/v1/${path}`, options); }
  async function invoke(name, body) { return authorized(`/functions/v1/${name}`, { method: "POST", body: JSON.stringify(body) }); }
  const authenticatedSession = ensureValidSession;
  MAG.SupabaseClient = Object.freeze({ login, logout, status, verifyMfa, audit, rest, invoke, restoreSession, ensureValidSession, refreshSession, authenticatedSession, MagError });
})(globalThis);
