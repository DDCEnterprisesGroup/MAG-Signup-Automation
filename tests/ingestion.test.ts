import assert from "node:assert/strict";
import test from "node:test";
import { parseIngestionFile, validateIngestionRecord } from "../src/operations/ingestion.js";

test("structured ingestion normalizes JSON arrays and CSV aliases", () => {
  const json = parseIngestionFile(JSON.stringify([{ request_id: "R1", first_name: " Ada ", last_name: "Lovelace", email: "ADA@EXAMPLE.COM" }]), ".json");
  assert.deepEqual(json.records[0], { requestId: "R1", firstName: "Ada", lastName: "Lovelace", email: "ada@example.com" });
  const csv = parseIngestionFile('requestId,first,last,email,source\nR2,"Grace",Hopper,GRACE@example.com,research\n', ".csv");
  assert.equal(csv.records[0]?.source, "research");
  assert.deepEqual(validateIngestionRecord(csv.records[0]!), []);
});

test("structured ingestion quarantines malformed records without profile data", () => {
  assert.deepEqual(validateIngestionRecord({ requestId: "R3", firstName: "Bad", lastName: "Email", email: "invalid" }), ["email is invalid"]);
});
