import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WorkbookStore } from "../src/excel/workbook-store.js";
import { createFixtureWorkbook } from "./helpers/workbook-fixture.js";

test("checkpoints ledger, summary, person status, and site issues into a reopenable workbook", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "mag-workbook-test-"));
  const target = path.join(tempDir, "test.xlsx");
  await createFixtureWorkbook(target, {
    sites: [["S0001", "Example", "https://example.invalid/signup", "YES", "NOT CHECKED", "", "", ""]],
    people: [["P0001", "Test", "Person", "5555550100", "test@example.invalid", "1 Test Way", "Testville", "FL", "32606", "01/02/1990", "Engineer", "85000", "[REDACTED_TEST_PASSWORD]", "PENDING", "", ""]],
  });
  let testAttemptId = "";
  let retryableAttemptId = "";
  let testPersonId = "";
  const store = new WorkbookStore(target);
  try {
    await store.open();
    const person = store.getPeople()[0];
    const site = store.getSites().find((candidate) => candidate.active && candidate.status.toUpperCase() !== "DUPLICATE");
    assert.ok(person);
    assert.ok(site);
    const attempt = await store.beginOrResumeAttempt(person, site);
    testAttemptId = attempt.attemptId;
    testPersonId = person.id;
    await store.updateAttempt(attempt, {
      status: "COMPLETED",
      formStep: 2,
      lastUrl: "https://example.invalid/success?token=redacted",
      retryEligible: "NO",
      notes: "Integration test completion",
    });
    await store.updatePersonSummary(person);
    await store.updatePerson(person, "COMPLETED");
    await store.recordSiteIssue({
      siteId: site.id,
      siteName: site.name,
      url: site.signupUrl,
      dateChecked: new Date().toISOString(),
      issueType: "REDIRECT",
      httpStatus: 301,
      redirectUrl: "https://example.invalid/register",
      globalStatus: "REDIRECTED",
      notes: "Integration test",
    });
    const retryable = await store.beginOrResumeAttempt(person, site);
    retryableAttemptId = retryable.attemptId;
    await store.updateAttempt(retryable, {
      status: "TEMP FAILURE",
      errorType: "NETWORK_TIMEOUT",
      retryEligible: "YES",
      notes: "Temporary timeout remains retryable",
    });
  } finally {
    await store.release();
  }

  try {
    const reopened = new WorkbookStore(target);
    await reopened.open();
    try {
      const firstPerson = reopened.getPeople()[0];
      assert.ok(firstPerson);
      const testAttempt = reopened.getAttempts().find((attempt) => attempt.attemptId === testAttemptId);
      assert.ok(testAttempt);
      assert.equal(testAttempt.status, "COMPLETED");
      assert.equal(testAttempt.lastUrl, "https://example.invalid/success");
      const retryableAttempt = reopened.getAttempts().find((attempt) => attempt.attemptId === retryableAttemptId);
      assert.equal(retryableAttempt?.status, "TEMP FAILURE");
      assert.equal(retryableAttempt?.retryEligible, "YES");
      assert.ok((reopened.getPersonSummary(testPersonId)?.passed ?? 0) >= 1);
      assert.equal(firstPerson.status, "COMPLETED");
      assert.equal(reopened.getSiteIssues().find((issue) => issue.notes === "Integration test")?.issueType, "REDIRECT");
    } finally {
      await reopened.release();
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
