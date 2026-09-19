/** Server-side adapter for the existing order bot. Secrets come only from its host. */
export class MagSupabaseIntakeClient {
  constructor({ url, publishableKey, email, password, fetchImpl = fetch }) {
    if (![url, publishableKey, email, password].every(Boolean)) throw new Error("MAG Supabase bot configuration is incomplete.");
    this.url = url.replace(/\/$/, ""); this.key = publishableKey; this.email = email; this.password = password; this.fetch = fetchImpl; this.accessToken = "";
  }
  async authenticate() {
    const response = await this.fetch(`${this.url}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: this.key, "Content-Type": "application/json" }, body: JSON.stringify({ email: this.email, password: this.password }) });
    const body = await response.json();
    if (!response.ok) throw new Error(`MAG bot authentication failed (${response.status}).`);
    this.accessToken = body.access_token;
  }
  async submitIntake(payload) {
    if (!this.accessToken) await this.authenticate();
    for (let attempt = 0; ; attempt += 1) {
      const response = await this.fetch(`${this.url}/functions/v1/mag-order-intake`, { method: "POST", headers: { apikey: this.key, Authorization: `Bearer ${this.accessToken}`, "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      if (response.status === 401 && attempt === 0) {
        this.accessToken = "";
        await this.authenticate();
        continue;
      }
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || `MAG intake failed (${response.status}).`);
      return body;
    }
  }
}
