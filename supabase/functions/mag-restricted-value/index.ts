import { createClient } from "npm:@supabase/supabase-js@2.116.0";
import { bearer, corsHeaders, json, jwtPayload, safeErrorCode } from "../_shared/http.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "METHOD_NOT_ALLOWED" }, 405);
  let actorId: string | null = null;
  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  try {
    const token = bearer(req);
    const { data: userData, error: userError } = await admin.auth.getUser(token);
    if (userError || !userData.user) throw new Error("AUTH_REQUIRED");
    actorId = userData.user.id;
    const claims = jwtPayload(token);
    const issuedAt = Number(claims.iat || 0);
    if (claims.aal !== "aal2" || !issuedAt || Date.now() / 1000 - issuedAt > 600) throw new Error("RECENT_MFA_REQUIRED");
    const body = await req.json();
    if (!body?.profileId || !body?.canonicalKey) throw new Error("INVALID_REQUEST");
    const { data, error } = await admin.rpc("mag_read_restricted_value", {
      p_actor_id: actorId, p_profile_id: body.profileId, p_canonical_key: body.canonicalKey,
    });
    if (error) throw error;
    const row = data?.[0];
    if (!row?.plaintext) throw new Error("RESTRICTED_VALUE_UNAVAILABLE");
    return json({ value: row.plaintext, maskedHint: row.masked_hint, classification: row.classification });
  } catch (error) {
    if (actorId) {
      await admin.from("mag_audit_events").insert({ actor_id: actorId, action: "RESTRICTED_ACCESS_FAILED", entity_type: "PROFILE", success: false, metadata: { reason_code: safeErrorCode(error, "ACCESS_DENIED") } });
    }
    const code = safeErrorCode(error, "ACCESS_DENIED");
    return json({ error: code }, code === "AUTH_REQUIRED" ? 401 : 403);
  }
});
