import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { MagSupabaseIntakeClient } from "../integrations/order-bot/mag-supabase-client.mjs";

const VALID_INTAKE = JSON.parse(readFileSync(new URL("./fixtures/mag-intake-valid.json", import.meta.url), "utf8"));
const INVALID_INTAKE = JSON.parse(readFileSync(new URL("./fixtures/mag-intake-invalid.json", import.meta.url), "utf8"));

test("order bot authenticates without a privileged key and sends intake to the guarded function", async () => {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), init });
    if (String(url).includes("/auth/v1/token")) return new Response(JSON.stringify({ access_token: "<test-access-token>" }), { status: 200 });
    return new Response(JSON.stringify({ profileId: "p1", status: "READY_FOR_REVIEW" }), { status: 200 });
  };
  const client = new MagSupabaseIntakeClient({ url: "https://project.invalid", publishableKey: "publishable", email: "service@example.invalid", password: "<test-password>", fetchImpl });
  const result = await client.submitIntake({ ...VALID_INTAKE, profile: { ...VALID_INTAKE.profile, fields: { Birthday: "2000-01-01" } } }) as { status: string };
  assert.equal(result.status, "READY_FOR_REVIEW");
  assert.equal(calls.length, 2);
  assert.match(String(calls[1]?.init?.headers && JSON.stringify(calls[1].init.headers)), /Bearer <test-access-token>/);
  assert.doesNotMatch(JSON.stringify(calls[1]), /test-password/);
});

test("a 401 on intake re-authenticates once and retries, matching the Python order-bot adapter", async () => {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  let tokenCalls = 0;
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), init });
    if (String(url).includes("/auth/v1/token")) {
      tokenCalls += 1;
      return new Response(JSON.stringify({ access_token: `<test-access-token-${tokenCalls}>` }), { status: 200 });
    }
    const authHeader = (init?.headers as Record<string, string> | undefined)?.Authorization;
    if (authHeader === "Bearer <test-access-token-1>") return new Response(JSON.stringify({ error: "SERVICE_AUTH_EXPIRED" }), { status: 401 });
    return new Response(JSON.stringify({ profileId: "p1", status: "READY_FOR_REVIEW" }), { status: 200 });
  };
  const client = new MagSupabaseIntakeClient({ url: "https://project.invalid", publishableKey: "publishable", email: "service@example.invalid", password: "<test-password>", fetchImpl });
  const result = await client.submitIntake(VALID_INTAKE) as { status: string };
  assert.equal(result.status, "READY_FOR_REVIEW");
  assert.equal(tokenCalls, 2, "expected one initial auth plus one re-auth after the 401");
  const intakeCalls = calls.filter((call) => call.url.includes("/functions/v1/mag-order-intake"));
  assert.equal(intakeCalls.length, 2, "expected the failed attempt plus exactly one retry, not an unbounded loop");
});

test("a second consecutive 401 fails instead of retrying forever", async () => {
  const fetchImpl = async (url: string | URL | Request): Promise<Response> => {
    if (String(url).includes("/auth/v1/token")) return new Response(JSON.stringify({ access_token: "<test-access-token>" }), { status: 200 });
    return new Response(JSON.stringify({ error: "SERVICE_ACCESS_REQUIRED" }), { status: 401 });
  };
  const client = new MagSupabaseIntakeClient({ url: "https://project.invalid", publishableKey: "publishable", email: "service@example.invalid", password: "<test-password>", fetchImpl });
  await assert.rejects(() => client.submitIntake(VALID_INTAKE), /SERVICE_ACCESS_REQUIRED/);
});

test("invalid intake is rejected before authentication and remote error bodies are redacted", async () => {
  let calls = 0;
  const fetchImpl = async (url: string | URL | Request): Promise<Response> => {
    calls += 1;
    if (String(url).includes("/auth/v1/token")) return new Response(JSON.stringify({ access_token: "<test-access-token>" }), { status: 200 });
    return new Response(JSON.stringify({ error: "private customer value" }), { status: 400 });
  };
  const client = new MagSupabaseIntakeClient({ url: "https://project.invalid", publishableKey: "publishable", email: "service@example.invalid", password: "<test-password>", fetchImpl });
  await assert.rejects(() => client.submitIntake(INVALID_INTAKE), /INVALID_INTAKE/);
  assert.equal(calls, 0);
  await assert.rejects(() => client.submitIntake(VALID_INTAKE), /REMOTE_SYNC_FAILED/);
});
