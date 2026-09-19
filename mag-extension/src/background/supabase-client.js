(function initializeSupabaseClient(root) {
  "use strict";
  const MAG = (root.MAG = root.MAG || {});
  const SESSION_KEY = "magSupabaseSession";

  async function request(path, options = {}, token = "") {
    const response = await fetch(`${MAG.SUPABASE.url}${path}`, {
      ...options,
      cache: "no-store",
      headers: {
        apikey: MAG.SUPABASE.publishableKey,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        "Content-Type": "application/json",
        ...(options.headers || {})
      }
    });
    const body = response.status === 204 ? null : await response.json().catch(() => null);
    if (!response.ok) throw new Error(body?.msg || body?.message || body?.error_description || body?.error || `MAG service returned ${response.status}.`);
    return body;
  }

  async function session() { return (await chrome.storage.session.get(SESSION_KEY))[SESSION_KEY] || null; }
  async function setSession(value) { value ? await chrome.storage.session.set({ [SESSION_KEY]: value }) : await chrome.storage.session.remove(SESSION_KEY); }

  async function refresh(current) {
    if (!current?.refresh_token) throw new Error("Sign in to sync MAG profiles.");
    const next = await request("/auth/v1/token?grant_type=refresh_token", { method: "POST", body: JSON.stringify({ refresh_token: current.refresh_token }) });
    await setSession(next);
    return next;
  }

  async function authenticatedSession() {
    let current = await session();
    if (!current) throw new Error("Sign in to sync MAG profiles.");
    if ((current.expires_at || 0) * 1000 <= Date.now() + 60000) current = await refresh(current);
    return current;
  }

  async function login(email, password) {
    if (!email || !password) throw new Error("Email and password are required.");
    const result = await request("/auth/v1/token?grant_type=password", { method: "POST", body: JSON.stringify({ email, password }) });
    await setSession(result);
    await request("/rest/v1/mag_audit_events", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ actor_id: result.user.id, action: "EXTENSION_LOGIN", entity_type: "SESSION", success: true, metadata: { client: "mag_extension" } }) }, result.access_token);
    return status();
  }

  async function logout() {
    const current = await session();
    try {
      if (current?.access_token) {
        await request("/rest/v1/mag_audit_events", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ actor_id: current.user.id, action: "EXTENSION_LOGOUT", entity_type: "SESSION", success: true, metadata: { client: "mag_extension" } }) }, current.access_token).catch(() => undefined);
        await request("/auth/v1/logout", { method: "POST" }, current.access_token);
      }
    }
    finally { await setSession(null); }
    return status();
  }

  async function status() {
    const current = await session();
    let aal = null;
    try { if (current?.access_token) aal = JSON.parse(atob(current.access_token.split(".")[1].replaceAll("-", "+").replaceAll("_", "/"))).aal || "aal1"; } catch { aal = null; }
    return { connected: Boolean(current?.access_token), aal, user: current?.user ? { id: current.user.id, email: current.user.email, displayName: current.user.user_metadata?.full_name || current.user.email } : null };
  }

  async function verifyMfa(code) {
    if (!/^\d{6,10}$/.test(String(code || "").trim())) throw new Error("Enter a valid authenticator code.");
    const current = await authenticatedSession();
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
    const current = await authenticatedSession();
    return request("/rest/v1/mag_audit_events", {
      method: "POST", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ actor_id: current.user.id, action, entity_type: "PROFILE", entity_id: entityId, field_canonical_key: fieldCanonicalKey, success: true, metadata: { client: "mag_extension" } })
    }, current.access_token);
  }

  async function rest(path, options = {}) { const current = await authenticatedSession(); return request(`/rest/v1/${path}`, options, current.access_token); }
  async function invoke(name, body) { const current = await authenticatedSession(); return request(`/functions/v1/${name}`, { method: "POST", body: JSON.stringify(body) }, current.access_token); }
  MAG.SupabaseClient = Object.freeze({ login, logout, status, verifyMfa, audit, rest, invoke, authenticatedSession });
})(globalThis);
