import { createClient } from "npm:@supabase/supabase-js@2.116.0";
import { bearer, corsHeaders, json, safeErrorCode } from "../_shared/http.ts";

const STATUSES = new Set(["AWAITING_PAYMENT", "PAYMENT_REVIEW", "PAYMENT_NEEDS_PROOF", "PAYMENT_REJECTED", "PENDING", "PROCESSING", "COMPLETED", "CANCELLED"]);
// Order-sync codes surfaced to the bot's retry log instead of a generic failure.
const ORDER_CODES = new Set(["INVALID_ORDER_STATUS", "ORDER_NOT_FOUND"]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "METHOD_NOT_ALLOWED" }, 405);
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false, autoRefreshToken: false } });
  try {
    const token = bearer(req);
    const { data: userData, error: userError } = await admin.auth.getUser(token);
    if (userError || !userData.user) throw new Error("AUTH_REQUIRED");
    const actorId = userData.user.id;
    const { data: membership } = await admin.from("mag_memberships").select("role,active").eq("user_id", actorId).single();
    if (!membership?.active || !["OWNER", "ADMIN", "SERVICE"].includes(membership.role)) throw new Error("SERVICE_ACCESS_REQUIRED");
    const payload = await req.json();
    if (
      typeof payload?.externalOrderId !== "string"
      || typeof payload?.externalEventId !== "string"
      || (payload?.previousStatus !== null && typeof payload?.previousStatus !== "string")
      || !STATUSES.has(payload?.newStatus)
      || (payload?.reason !== null && typeof payload?.reason !== "string")
      || typeof payload?.occurredAt !== "string"
    ) throw new Error("INVALID_ORDER_STATUS");
    // Completion stamps mag_orders and archives only the order's linked profiles.
    const { data, error } = await admin.rpc("mag_sync_order_status", {
      p_external_order_id: payload.externalOrderId,
      p_external_event_id: payload.externalEventId,
      p_previous_status: payload.previousStatus,
      p_new_status: payload.newStatus,
      p_reason: payload.reason,
      p_actor_id: actorId,
      p_occurred_at: payload.occurredAt,
    });
    if (error) throw new Error(error.message);
    if (!data?.eventId || data.paymentStatus !== payload.newStatus) throw new Error("ORDER_STATUS_SYNC_FAILED");
    return json(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const code = ORDER_CODES.has(message) ? message : safeErrorCode(error, "ORDER_STATUS_SYNC_FAILED");
    return json({ error: code }, code === "AUTH_REQUIRED" ? 401 : code === "SERVICE_ACCESS_REQUIRED" ? 403 : code === "ORDER_NOT_FOUND" ? 404 : code === "ORDER_STATUS_SYNC_FAILED" ? 500 : 400);
  }
});
