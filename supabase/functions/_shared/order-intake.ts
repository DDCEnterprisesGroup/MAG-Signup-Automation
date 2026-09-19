/** Shared MAG order-intake logic. Used by both mag-order-intake/index.ts
 * (the HTTP endpoint order-bot adapters call) and mag-telegram-webhook
 * (which needs the same behavior at the customer's DRAFT ->
 * AWAITING_PAYMENT moment, without an internal HTTP hop to itself).
 * Takes an already-constructed admin (service-role) Supabase client rather
 * than importing/constructing one, so this module has no Deno-specific
 * imports and can be unit tested under Node. */

const canonicalize = (value: string) => value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 63);
const credentialPattern = /password|passcode|recovery.?code|auth(?:entication)?.?code|api.?key|private.?token|card.?security|cvv|cvc/i;

export interface OrderIntakePayload {
  externalOrderId: string;
  customer: { externalId: string; name: string; email?: string | null; phone?: string | null };
  serviceType: string;
  projectName?: string | null;
  profile: { externalId: string; type?: string; label: string; fields?: Record<string, unknown> };
}

export interface OrderIntakeResult {
  customerId: string;
  orderId: string;
  profileId: string;
  status: string;
  acceptedFields: string[];
  rejectedFields: string[];
}

function validateField(definition: Record<string, unknown>, value: unknown): { status: string; errors: string[] } {
  const text = typeof value === "string" ? value.trim() : "";
  const errors: string[] = [];
  if (definition.data_type === "EMAIL" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) errors.push("INVALID_EMAIL");
  if (definition.data_type === "URL") {
    try { const parsed = new URL(text); if (!["http:", "https:"].includes(parsed.protocol)) errors.push("INVALID_URL_PROTOCOL"); }
    catch { errors.push("INVALID_URL"); }
  }
  if (definition.data_type === "PHONE" && text.replace(/\D/g, "").length < 10) errors.push("INVALID_PHONE");
  if (definition.data_type === "DATE" && !/^\d{4}-\d{2}-\d{2}$/.test(text)) errors.push("INVALID_DATE");
  return { status: errors.length ? "INVALID" : "VALID", errors };
}

/* eslint-disable @typescript-eslint/no-explicit-any -- admin is a supabase-js client; typing its full chainable surface here would duplicate the SDK's own types for no safety benefit in an Edge Function. */
export async function runOrderIntake(admin: any, actorId: string, payload: OrderIntakePayload): Promise<OrderIntakeResult> {
  const required = [payload?.externalOrderId, payload?.customer?.externalId, payload?.customer?.name, payload?.serviceType, payload?.profile?.externalId, payload?.profile?.label];
  if (required.some((value) => typeof value !== "string" || !value.trim() || value.length > 254)
      || !["ORGANIZATION", "PERSON", "EVENT", "PRODUCT", "OTHER"].includes(payload.profile.type || "OTHER")
      || (payload.profile.fields !== undefined && (typeof payload.profile.fields !== "object" || payload.profile.fields === null || Array.isArray(payload.profile.fields)))) {
    throw new Error("INVALID_INTAKE");
  }
  const externalOrderId = payload.externalOrderId.trim();
  const externalCustomerId = payload.customer.externalId.trim();
  const externalProfileId = payload.profile.externalId.trim();
  const { data: priorOrder, error: priorOrderError } = await admin.from("mag_orders")
    .select("id,customer_id,status").eq("source", "ORDER_BOT").eq("external_order_id", externalOrderId).maybeSingle();
  if (priorOrderError) throw priorOrderError;
  const { data: knownCustomer, error: knownCustomerError } = await admin.from("mag_customers")
    .select("id").eq("scope", "CUSTOMER").eq("external_customer_id", externalCustomerId).maybeSingle();
  if (knownCustomerError) throw knownCustomerError;
  if (priorOrder && priorOrder.customer_id !== knownCustomer?.id) throw new Error("ORDER_IDENTITY_CONFLICT");
  const normalizedName = String(payload.customer.name).trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const { data: customer, error: customerError } = await admin.from("mag_customers").upsert({
    scope: "CUSTOMER", external_customer_id: externalCustomerId, display_name: String(payload.customer.name).trim(), normalized_name: normalizedName,
    primary_email: payload.customer.email || null, primary_phone: payload.customer.phone || null, created_by: actorId,
  }, { onConflict: "scope,external_customer_id" }).select().single();
  if (customerError) throw customerError;

  const { data: order, error: orderError } = await admin.from("mag_orders").upsert({
    customer_id: customer.id, external_order_id: externalOrderId, service_type: String(payload.serviceType),
    source: "ORDER_BOT", status: priorOrder?.status || "READY_FOR_REVIEW", project_name: payload.projectName || null,
    submitted_at: new Date().toISOString(), created_by: actorId,
  }, { onConflict: "source,external_order_id" }).select().single();
  if (orderError) throw orderError;

  const { data: priorProfile, error: priorProfileError } = await admin.from("mag_profiles")
    .select("id,status").eq("order_id", order.id).eq("external_profile_id", externalProfileId).maybeSingle();
  if (priorProfileError) throw priorProfileError;
  if (priorProfile?.status === "ARCHIVED") throw new Error("PROFILE_ARCHIVED");
  if (priorProfile?.status === "ACTIVE") {
    return { customerId: customer.id, orderId: order.id, profileId: priorProfile.id, status: "ACTIVE", acceptedFields: [], rejectedFields: [] };
  }
  const { data: profile, error: profileError } = await admin.from("mag_profiles").upsert({
    customer_id: customer.id, order_id: order.id, external_profile_id: externalProfileId, profile_type: payload.profile.type || "OTHER", profile_scope: "CUSTOMER",
    label: String(payload.profile.label), status: "DRAFT", created_by: actorId,
  }, { onConflict: "order_id,external_profile_id" }).select().single();
  if (profileError) throw profileError;

  let hasUnknown = false;
  let hasInvalid = false;
  const accepted: string[] = [];
  const rejected: string[] = [];
  const { data: registeredDefinitions, error: definitionsError } = await admin.from("mag_field_definitions").select("*");
  if (definitionsError) throw definitionsError;
  for (const [rawKey, value] of Object.entries(payload.profile.fields || {})) {
    if (credentialPattern.test(rawKey)) { rejected.push(rawKey); continue; }
    const key = canonicalize(rawKey);
    let definition = registeredDefinitions?.find((candidate: Record<string, unknown>) => candidate.canonical_key === key || ((candidate.aliases as string[]) || []).some((alias) => canonicalize(alias) === key));
    if (!definition) {
      hasUnknown = true;
      const created = await admin.from("mag_field_definitions").insert({ canonical_key: key, semantic_type: "OTHER", display_name: rawKey, aliases: [rawKey], security_class: "UNCLASSIFIED", storage_policy: "QUARANTINE", cache_policy: "NONE", autofill_policy: "NEVER", review_requirement: "ADMIN_REQUIRED", active: false, created_by: actorId }).select().single();
      if (created.error) throw created.error;
      definition = created.data;
      registeredDefinitions?.push(definition);
    }
    if (definition.security_class === "CREDENTIAL" || definition.storage_policy === "FORBIDDEN") { rejected.push(rawKey); continue; }
    if (definition.security_class === "STANDARD") {
      const result = validateField(definition, value);
      hasInvalid ||= result.status === "INVALID";
      const { error } = await admin.from("mag_profile_field_values").upsert({ profile_id: profile.id, field_definition_id: definition.id, value, validation_status: result.status, validation_errors: result.errors, source: "ORDER_BOT" }, { onConflict: "profile_id,field_definition_id" });
      if (error) throw error;
    } else {
      const { error } = await admin.rpc("mag_store_protected_value", { p_profile_id: profile.id, p_canonical_key: definition.canonical_key, p_plaintext: String(value), p_source: "ORDER_BOT" });
      if (error) throw error;
    }
    accepted.push(key);
  }
  const status = hasUnknown || hasInvalid ? "INCOMPLETE" : "READY_FOR_REVIEW";
  const { error: statusError } = await admin.from("mag_profiles").update({ status }).eq("id", profile.id);
  if (statusError) throw statusError;
  const { error: auditError } = await admin.from("mag_audit_events").insert({ actor_id: actorId, action: "BOT_INTAKE_CREATED", entity_type: "PROFILE", entity_id: profile.id, success: true, metadata: { accepted_field_count: accepted.length, rejected_field_count: rejected.length, status } });
  if (auditError) throw auditError;
  return { customerId: customer.id, orderId: order.id, profileId: profile.id, status, acceptedFields: accepted, rejectedFields: rejected };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
