import { createClient } from "npm:@supabase/supabase-js@2.116.0";
import { bearer, corsHeaders, json, jwtPayload } from "../_shared/http.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "METHOD_NOT_ALLOWED" }, 405);
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false, autoRefreshToken: false } });
  try {
    const token = bearer(req);
    const { data: userData, error: userError } = await admin.auth.getUser(token);
    if (userError || !userData.user) throw new Error("AUTH_REQUIRED");
    const claims = jwtPayload(token);
    if (claims.aal !== "aal2") throw new Error("MFA_REQUIRED");
    const actorId = userData.user.id;
    const { data: membership } = await admin.from("mag_memberships").select("role,active").eq("user_id", actorId).single();
    if (!membership?.active || !["OWNER", "ADMIN"].includes(membership.role)) throw new Error("ADMIN_REQUIRED");
    const { profileId, approve } = await req.json();
    const { data: profile } = await admin.from("mag_profiles").select("id,status").eq("id", profileId).single();
    if (!profile || profile.status !== "READY_FOR_REVIEW") throw new Error("PROFILE_NOT_READY");
    const { count: invalid } = await admin.from("mag_profile_field_values").select("id", { count: "exact", head: true }).eq("profile_id", profileId).neq("validation_status", "VALID");
    if (invalid) throw new Error("PROFILE_VALIDATION_FAILED");
    const nextStatus = approve ? "ACTIVE" : "NEEDS_UPDATE";
    const update = approve ? { status: nextStatus, approved_by: actorId, approved_at: new Date().toISOString() } : { status: nextStatus, approved_by: null, approved_at: null };
    const { error } = await admin.from("mag_profiles").update(update).eq("id", profileId);
    if (error) throw error;
    await admin.from("mag_audit_events").insert({ actor_id: actorId, action: approve ? "PROFILE_APPROVED" : "PROFILE_REJECTED", entity_type: "PROFILE", entity_id: profileId, success: true, metadata: { resulting_status: nextStatus } });
    return json({ profileId, status: nextStatus });
  } catch (error) {
    const code = error instanceof Error ? error.message : "REVIEW_FAILED";
    return json({ error: code }, code === "AUTH_REQUIRED" ? 401 : 403);
  }
});
