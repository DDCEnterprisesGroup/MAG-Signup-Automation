import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WorkbookStore } from "../src/excel/workbook-store.js";
import type { AttemptRecord, AttemptStatus } from "../src/types/models.js";
import { eligibilityConfig, isDeferredForThisPass, isSiteProcessable } from "../src/workflow/eligibility.js";
import { createFixtureWorkbook } from "./helpers/workbook-fixture.js";

const config = eligibilityConfig({ retryCount: 2, maxAutoDeferrals: 4 });

function attempt(status: AttemptStatus, overrides: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    rowNumber: 2,
    attemptId: "A-TEST",
    personId: "P0001",
    siteId: "S0001",
    attemptedAt: new Date().toISOString(),
    status,
    formStep: 0,
    lastUrl: "https://example.invalid/signup",
    errorType: "",
    retryEligible: "YES",
    notes: "",
    ...overrides,
  };
}

test("a combination with no prior attempt is processable", () => {
  assert.equal(isSiteProcessable({ latest: undefined, attemptCount: 0, deferralCount: 0 }, config), true);
});

test("completed work is never reprocessed regardless of attempt count or retry flag", () => {
  assert.equal(
    isSiteProcessable({ latest: attempt("COMPLETED", { retryEligible: "YES" }), attemptCount: 1, deferralCount: 0 }, config),
    false,
  );
  assert.equal(
    isSiteProcessable({ latest: attempt("COMPLETED", { retryEligible: "NO" }), attemptCount: 5, deferralCount: 3 }, config),
    false,
  );
});

test("SITE INVALID is a permanent classification and is not reprocessed", () => {
  // Preserved production behaviour: SITE INVALID and COMPLETED are checked before
  // the manual-reset override, so clearing one requires an explicit workbook edit
  // that changes the latest status (not just a note).
  assert.equal(isSiteProcessable({ latest: attempt("SITE INVALID"), attemptCount: 1, deferralCount: 0 }, config), false);
  assert.equal(
    isSiteProcessable(
      { latest: attempt("SITE INVALID", { notes: "Manual reset authorized 2026-08-31" }), attemptCount: 1, deferralCount: 0 },
      config,
    ),
    false,
  );
});

test("a manual reset note rescues an otherwise exhausted retryable failure", () => {
  assert.equal(
    isSiteProcessable(
      { latest: attempt("FAILED", { retryEligible: "NO", notes: "Manual reset authorized 2026-08-31" }), attemptCount: 9, deferralCount: 0 },
      config,
    ),
    true,
  );
});

test("resume states stay processable", () => {
  for (const status of ["IN PROGRESS", "WAITING FOR HUMAN"] as const) {
    assert.equal(isSiteProcessable({ latest: attempt(status), attemptCount: 9, deferralCount: 0 }, config), true);
  }
});

test("temporary failures are retryable until the normal budget is spent", () => {
  assert.equal(isSiteProcessable({ latest: attempt("TEMP FAILURE"), attemptCount: 2, deferralCount: 0 }, config), true);
  assert.equal(isSiteProcessable({ latest: attempt("TEMP FAILURE"), attemptCount: 3, deferralCount: 0 }, config), false);
  assert.equal(
    isSiteProcessable({ latest: attempt("FAILED", { retryEligible: "NO" }), attemptCount: 3, deferralCount: 0 }, config),
    false,
  );
});

test("operator deferrals remain retryable across runs but are bounded", () => {
  // Still under the defer ceiling (retryCount + maxAutoDeferrals = 6).
  assert.equal(
    isSiteProcessable({ latest: attempt("OPERATOR_DEFERRED"), attemptCount: 3, deferralCount: 3 }, config),
    true,
  );
  // Defer ceiling reached: falls through to the wider attempt budget, still true here.
  assert.equal(
    isSiteProcessable({ latest: attempt("OPERATOR_DEFERRED"), attemptCount: 6, deferralCount: 7 }, config),
    true,
  );
  // Defer ceiling and wider attempt budget both exhausted: stops looping.
  assert.equal(
    isSiteProcessable({ latest: attempt("OPERATOR_DEFERRED"), attemptCount: 7, deferralCount: 8 }, config),
    false,
  );
  // An operator who explicitly makes a deferral non-retryable stops it immediately.
  assert.equal(
    isSiteProcessable({ latest: attempt("OPERATOR_DEFERRED", { retryEligible: "NO" }), attemptCount: 1, deferralCount: 1 }, config),
    false,
  );
});

test("a deferred site is not re-attempted within the same pass", () => {
  assert.equal(isDeferredForThisPass(attempt("OPERATOR_DEFERRED")), true);
  assert.equal(isDeferredForThisPass(attempt("TEMP FAILURE")), false);
  assert.equal(isDeferredForThisPass(undefined), false);
});

test("the workbook lock prevents a second store from opening the same production file", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "mag-lock-"));
  const target = path.join(tempDir, "book.xlsx");
  await createFixtureWorkbook(target, {
    sites: [["S0001", "Example", "https://example.invalid/signup", "YES", "NOT CHECKED", "", "", ""]],
    people: [["P0001", "Test", "Person", "", "test@example.invalid", "", "", "", "", "", "", "", "", "PENDING", "", ""]],
  });
  const first = new WorkbookStore(target);
  await first.open();
  try {
    const second = new WorkbookStore(target);
    await assert.rejects(second.open(), /already in use/i);
  } finally {
    await first.release();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("getDeferralCount only counts OPERATOR_DEFERRED rows for the exact pair", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "mag-defercount-"));
  const target = path.join(tempDir, "book.xlsx");
  await createFixtureWorkbook(target, {
    sites: [["S0001", "Example", "https://example.invalid/signup", "YES", "NOT CHECKED", "", "", ""]],
    people: [["P0001", "Test", "Person", "", "test@example.invalid", "", "", "", "", "", "", "", "", "PENDING", "", ""]],
  });
  const store = new WorkbookStore(target);
  await store.open();
  try {
    const person = store.getPeople()[0]!;
    const site = store.getSites()[0]!;
    const first = await store.beginOrResumeAttempt(person, site);
    await store.updateAttempt(first, { status: "OPERATOR_DEFERRED", errorType: "OPERATOR_DEFERRED", notes: "Deferred once" });
    assert.equal(store.getDeferralCount(person.id, site.id), 1);
    assert.equal(store.getDeferralCount(person.id, "S9999"), 0);
  } finally {
    await store.release();
    await rm(tempDir, { recursive: true, force: true });
  }
});
