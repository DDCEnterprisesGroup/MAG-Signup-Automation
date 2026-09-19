/** Server-side adapter for the existing order bot. Secrets come only from its host. */
export function validateIntake(payload) {
  const required = [payload?.externalOrderId, payload?.customer?.externalId, payload?.customer?.name, payload?.serviceType, payload?.profile?.externalId, payload?.profile?.label];
  if (required.some((value) => typeof value !== "string" || !value.trim() || value.length > 254)
    || !["ORGANIZATION", "PERSON", "EVENT", "PRODUCT", "OTHER"].includes(payload.profile.type || "OTHER")
    || (payload.profile.fields !== undefined && (typeof payload.profile.fields !== "object" || payload.profile.fields === null || Array.isArray(payload.profile.fields)))) {
    throw new Error("INVALID_INTAKE");
  }
  return payload;
}

const safeRemoteCode = (value) => new Set(["INVALID_INTAKE", "ORDER_IDENTITY_CONFLICT", "PROFILE_ARCHIVED", "SERVICE_ACCESS_REQUIRED", "AUTH_REQUIRED"]).has(value) ? value : "REMOTE_SYNC_FAILED";

export class MagSupabaseIntakeClient {
  constructor({ url, publishableKey, email, password, fetchImpl = fetch }) {
    if (![url, publishableKey, email, password].every(Boolean)) throw new Error("MAG Supabase bot configuration is incomplete.");
    this.url = url.replace(/\/$/, ""); this.key = publishableKey; this.email = email; this.password = password; this.fetch = fetchImpl; this.accessToken = "";
  }
  async authenticate() {
    const response = await this.fetch(`${this.url}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: this.key, "Content-Type": "application/json" }, body: JSON.stringify({ email: this.email, password: this.password }) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || typeof body.access_token !== "string" || !body.access_token) throw new Error("SERVICE_AUTH_FAILED");
    this.accessToken = body.access_token;
  }
  async submitIntake(payload) {
    validateIntake(payload);
    if (!this.accessToken) await this.authenticate();
    for (let attempt = 0; ; attempt += 1) {
      const response = await this.fetch(`${this.url}/functions/v1/mag-order-intake`, { method: "POST", headers: { apikey: this.key, Authorization: `Bearer ${this.accessToken}`, "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      if (response.status === 401 && attempt === 0) {
        this.accessToken = "";
        await this.authenticate();
        continue;
      }
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(safeRemoteCode(body.error));
      if (!body || typeof body.profileId !== "string" || !body.profileId) throw new Error("INVALID_SYNC_RESPONSE");
      return body;
    }
  }
}
