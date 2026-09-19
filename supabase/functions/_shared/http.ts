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
