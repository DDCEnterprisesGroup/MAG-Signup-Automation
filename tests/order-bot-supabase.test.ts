import assert from "node:assert/strict";
import test from "node:test";
import { MagSupabaseIntakeClient } from "../integrations/order-bot/mag-supabase-client.mjs";

test("order bot authenticates without a privileged key and sends intake to the guarded function", async () => {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), init });
    if (String(url).includes("/auth/v1/token")) return new Response(JSON.stringify({ access_token: "<test-access-token>" }), { status: 200 });
    return new Response(JSON.stringify({ profileId: "p1", status: "READY_FOR_REVIEW" }), { status: 200 });
  };
  const client = new MagSupabaseIntakeClient({ url: "https://project.invalid", publishableKey: "publishable", email: "service@example.invalid", password: "<test-password>", fetchImpl });
  const result = await client.submitIntake({ externalOrderId: "o1", profile: { fields: { Birthday: "2000-01-01" } } }) as { status: string };
  assert.equal(result.status, "READY_FOR_REVIEW");
  assert.equal(calls.length, 2);
  assert.match(String(calls[1]?.init?.headers && JSON.stringify(calls[1].init.headers)), /Bearer <test-access-token>/);
  assert.doesNotMatch(JSON.stringify(calls[1]), /test-password/);
});
