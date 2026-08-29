import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WorkbookStore } from "../src/excel/workbook-store.js";
import { buildOperationsStatus } from "../src/operations/status.js";
import type { AttemptRecord, PersonProfile, Site } from "../src/types/models.js";
import { createFixtureWorkbook } from "./helpers/workbook-fixture.js";

const person: PersonProfile = {
  rowNumber: 2, id: "P0001", firstName: "Test", lastName: "Person", phone: "", email: "test@example.invalid",
  address: "", city: "", state: "", zip: "", dob: "", occupation: "", annualIncome: "", password: "",
  dynamicFields: {}, status: "IN PROGRESS", currentSiteId: "S0001", lastUpdated: "",
};
const site: Site = {
  rowNumber: 2, id: "S0001", name: "Test", signupUrl: "https://example.invalid/signup", active: true,
  status: "", lastChecked: "", finalUrl: "", notes: "",
};

test("operations status exposes queues, stale work, retries, handoffs, and reconciliation drift", () => {
  const attempts: AttemptRecord[] = [
    { rowNumber: 2, attemptId: "A1", personId: "P0001", siteId: "S0001", attemptedAt: "2026-08-20T00:00:00Z", status: "IN PROGRESS", formStep: 1, lastUrl: "", errorType: "", retryEligible: "YES", notes: "" },
    { rowNumber: 3, attemptId: "A2", personId: "P0002", siteId: "S0001", attemptedAt: "2026-08-28T00:00:00Z", status: "WAITING FOR HUMAN", formStep: 1, lastUrl: "", errorType: "CAPTCHA", retryEligible: "YES", notes: "" },
    { rowNumber: 4, attemptId: "A3", personId: "P0003", siteId: "S0001", attemptedAt: "2026-08-28T00:00:00Z", status: "TEMP FAILURE", formStep: 1, lastUrl: "", errorType: "NETWORK_TIMEOUT", retryEligible: "YES", notes: "" },
  ];
  const status = buildOperationsStatus([person], [site], attempts, [], () => ({ personId: "P0001", name: "Test", attemptedAt: "", sitesAttempted: 1, passed: 1, failed: 0, humanReview: 0 }), Date.parse("2026-08-28T12:00:00Z"));
  assert.equal(status.staleInProgress, 1);
  assert.equal(status.humanHandoffs, 1);
  assert.equal(status.retryQueue, 1);
  assert.equal(status.profiles.failed, 0);
  assert.equal(status.reconciliation.unreconciled, 1);
  assert.deepEqual(status.reconciliationIssues, ["summary mismatch: P0001"]);
});

test("signup intake creates one durable profile and replays safely by email", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mag-ingest-"));
  const workbookPath = path.join(root, "workbook.xlsx");
  await createFixtureWorkbook(workbookPath);
  const workbook = new WorkbookStore(workbookPath);
  try {
    await workbook.open();
    const input = { requestId: "signup-1", firstName: "New", lastName: "Person", email: "NEW@EXAMPLE.INVALID" };
    const created = await workbook.ingestPerson(input);
    const replay = await workbook.ingestPerson(input);
    assert.equal(created.created, true);
    assert.match(created.person.id, /^P\d{4}$/);
    assert.equal(replay.created, false);
    assert.equal(replay.person.id, created.person.id);
    assert.equal(workbook.getPeople().length, 1);
  } finally {
    await workbook.release();
    await rm(root, { recursive: true, force: true });
  }
});
