export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Cache-Control": "no-store",
  "Pragma": "no-cache",
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

export function safeErrorCode(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : "";
  const publicCodes = new Set([
    "AUTH_REQUIRED", "SERVICE_ACCESS_REQUIRED", "INVALID_INTAKE", "ORDER_IDENTITY_CONFLICT",
    "PROFILE_ARCHIVED", "ADMIN_REQUIRED", "MFA_REQUIRED", "PROFILE_NOT_READY",
    "PROFILE_VALIDATION_FAILED", "RECENT_MFA_REQUIRED", "INVALID_REQUEST",
    "RESTRICTED_VALUE_UNAVAILABLE",
  ]);
  return publicCodes.has(message) ? message : fallback;
}

export function bearer(req: Request): string {
  const value = req.headers.get("Authorization") || "";
  if (!value.startsWith("Bearer ")) throw new Error("AUTH_REQUIRED");
  return value.slice(7);
}

export function jwtPayload(token: string): Record<string, unknown> {
  const part = token.split(".")[1];
  if (!part) throw new Error("INVALID_TOKEN");
  return JSON.parse(atob(part.replaceAll("-", "+").replaceAll("_", "/")));
}
