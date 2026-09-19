import assert from "node:assert/strict";
import test from "node:test";
import { runOrderIntake } from "../supabase/functions/_shared/order-intake.js";

interface Call { table: string; op: string; args: unknown[] }

/** Minimal fake of the subset of the supabase-js chainable builder that
 * order-intake.ts actually calls, driven by a small in-memory store keyed
 * by table name so upserts/inserts/selects behave consistently across a
 * single test's calls without needing a real Postgres. */
function fakeAdmin(options: { fieldDefinitions?: Record<string, unknown>[] } = {}) {
  const calls: Call[] = [];
  const store: Record<string, Record<string, unknown>[]> = {
    mag_customers: [], mag_orders: [], mag_profiles: [],
    mag_field_definitions: options.fieldDefinitions ? [...options.fieldDefinitions] : [],
    mag_profile_field_values: [], mag_audit_events: [],
  };
  let nextId = 1;

  function builder(table: string) {
    return {
      upsert(row: Record<string, unknown>, opts: { onConflict: string }) {
        calls.push({ table, op: "upsert", args: [row, opts] });
        const keys = opts.onConflict.split(",");
        const rows = store[table] ?? [];
        const existing = rows.find((r) => keys.every((k) => r[k] === row[k]));
        const saved = existing ? Object.assign(existing, row) : Object.assign({ id: `${table}-${nextId++}` }, row);
        if (!existing) rows.push(saved);
        store[table] = rows;
        return {
          select: () => ({ single: async () => ({ data: saved, error: null }) }),
        };
      },
      insert(row: Record<string, unknown>) {
        calls.push({ table, op: "insert", args: [row] });
        const saved = Object.assign({ id: `${table}-${nextId++}` }, row);
        const rows = store[table] ?? [];
        rows.push(saved);
        store[table] = rows;
        return { select: () => ({ single: async () => ({ data: saved, error: null }) }) };
      },
      select(cols = "*") {
        calls.push({ table, op: "select", args: [cols] });
        return Promise.resolve({ data: store[table] ?? [], error: null }) as unknown as { data: unknown; error: null; eq: (c: string, v: unknown) => unknown };
      },
      update(patch: Record<string, unknown>) {
        calls.push({ table, op: "update", args: [patch] });
        return {
          eq: async (col: string, value: unknown) => {
            const row = (store[table] ?? []).find((r) => r[col] === value);
            if (row) Object.assign(row, patch);
            return { data: row, error: null };
          },
        };
      },
    };
  }

  return {
    calls,
    store,
    from: (table: string) => builder(table),
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ table: name, op: "rpc", args: [args] });
      store.mag_profile_field_values!.push({ rpc: name, ...args });
      return { data: null, error: null };
    },
  };
}

const basePayload = {
  externalOrderId: "o1",
  customer: { name: "Test Customer", email: "t@example.invalid" },
  serviceType: "PR500",
  profile: { type: "PERSON", label: "Test Customer", fields: {} },
};

test("creates customer, order, and profile with the expected upsert conflict targets", async () => {
  const admin = fakeAdmin();
  const result = await runOrderIntake(admin, "actor-1", basePayload);
  assert.equal(result.status, "READY_FOR_REVIEW");
  const upserts = admin.calls.filter((c) => c.op === "upsert");
  assert.deepEqual(upserts.map((c) => c.table), ["mag_customers", "mag_orders", "mag_profiles"]);
  assert.equal((upserts[0]!.args[1] as { onConflict: string }).onConflict, "scope,normalized_name");
  assert.equal((upserts[1]!.args[1] as { onConflict: string }).onConflict, "source,external_order_id");
  assert.equal((upserts[2]!.args[1] as { onConflict: string }).onConflict, "customer_id,profile_type,label");
});

test("a credential-shaped field key is rejected and never reaches the database", async () => {
  const admin = fakeAdmin();
  const result = await runOrderIntake(admin, "actor-1", { ...basePayload, profile: { ...basePayload.profile, fields: { "API Key": "secret", "Full Name": "ok" } } });
  assert.deepEqual(result.rejectedFields, ["API Key"]);
  const insertedValues = JSON.stringify(admin.calls);
  assert.doesNotMatch(insertedValues, /secret/);
});

test("an unregistered field creates an inactive UNCLASSIFIED/QUARANTINE definition and marks the profile INCOMPLETE", async () => {
  const admin = fakeAdmin();
  const result = await runOrderIntake(admin, "actor-1", { ...basePayload, profile: { ...basePayload.profile, fields: { "Shoe Size": "10" } } });
  assert.equal(result.status, "INCOMPLETE");
  const created = admin.store.mag_field_definitions!.find((d) => d.canonical_key === "shoe_size");
  assert.ok(created);
  assert.equal(created?.active, false);
  assert.equal(created?.security_class, "UNCLASSIFIED");
  assert.equal(created?.storage_policy, "QUARANTINE");
});

test("a STANDARD field is validated and stored via mag_profile_field_values, not the restricted-value RPC", async () => {
  const admin = fakeAdmin({ fieldDefinitions: [{ id: "def-1", canonical_key: "email", aliases: [], security_class: "STANDARD", storage_policy: "PROFILE", data_type: "EMAIL" }] });
  const result = await runOrderIntake(admin, "actor-1", { ...basePayload, profile: { ...basePayload.profile, fields: { Email: "not-an-email" } } });
  assert.equal(result.status, "INCOMPLETE");
  const stored = admin.store.mag_profile_field_values![0]!;
  assert.equal(stored.validation_status, "INVALID");
  assert.deepEqual(stored.validation_errors, ["INVALID_EMAIL"]);
});

test("a non-STANDARD (e.g. SENSITIVE) field goes through mag_store_protected_value, never the plain values table", async () => {
  const admin = fakeAdmin({ fieldDefinitions: [{ id: "def-2", canonical_key: "date_of_birth", aliases: ["dob", "birthday"], security_class: "SENSITIVE", storage_policy: "VAULT" }] });
  await runOrderIntake(admin, "actor-1", { ...basePayload, profile: { ...basePayload.profile, fields: { Birthday: "2000-01-01" } } });
  assert.equal(admin.store.mag_profile_field_values!.length, 1);
  const rpcCall = admin.calls.find((c) => c.op === "rpc");
  assert.equal(rpcCall?.table, "mag_store_protected_value");
  assert.equal((rpcCall?.args[0] as { p_canonical_key: string }).p_canonical_key, "date_of_birth");
});

test("a CREDENTIAL-classed or FORBIDDEN-storage definition is rejected even if the field key looks benign", async () => {
  const admin = fakeAdmin({ fieldDefinitions: [{ id: "def-3", canonical_key: "vault_pin", aliases: ["pin"], security_class: "CREDENTIAL", storage_policy: "FORBIDDEN" }] });
  const result = await runOrderIntake(admin, "actor-1", { ...basePayload, profile: { ...basePayload.profile, fields: { PIN: "1234" } } });
  assert.deepEqual(result.rejectedFields, ["PIN"]);
});

test("throws INVALID_INTAKE for a missing required field instead of partially writing", async () => {
  const admin = fakeAdmin();
  await assert.rejects(() => runOrderIntake(admin, "actor-1", { ...basePayload, customer: { name: "" } }), /INVALID_INTAKE/);
  assert.equal(admin.calls.length, 0);
});

test("records a BOT_INTAKE_CREATED audit event with counts but no field values", async () => {
  const admin = fakeAdmin();
  await runOrderIntake(admin, "actor-1", { ...basePayload, profile: { ...basePayload.profile, fields: { "Full Name": "Jane Q" } } });
  const audit = admin.store.mag_audit_events![0]!;
  assert.equal(audit.action, "BOT_INTAKE_CREATED");
  assert.doesNotMatch(JSON.stringify(audit), /Jane Q/);
});
