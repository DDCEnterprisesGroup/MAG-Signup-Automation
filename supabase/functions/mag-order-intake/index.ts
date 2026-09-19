import { createClient } from "npm:@supabase/supabase-js@2.116.0";
import { bearer, corsHeaders, json, safeErrorCode } from "../_shared/http.ts";
import { runOrderIntake } from "../_shared/order-intake.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "METHOD_NOT_ALLOWED" }, 405);
  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  try {
    const token = bearer(req);
    const { data: userData, error: userError } = await admin.auth.getUser(token);
    if (userError || !userData.user) throw new Error("AUTH_REQUIRED");
    const actorId = userData.user.id;
    const { data: membership } = await admin.from("mag_memberships").select("role,active").eq("user_id", actorId).single();
    if (!membership?.active || !["OWNER", "ADMIN", "SERVICE"].includes(membership.role)) throw new Error("SERVICE_ACCESS_REQUIRED");
    const payload = await req.json();
    const result = await runOrderIntake(admin, actorId, payload);
    return json(result);
  } catch (error) {
    const code = safeErrorCode(error, "INTAKE_FAILED");
    return json({ error: code }, code === "AUTH_REQUIRED" ? 401 : code === "SERVICE_ACCESS_REQUIRED" ? 403 : code === "INTAKE_FAILED" ? 500 : 400);
  }
});
