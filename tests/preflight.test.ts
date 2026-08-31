import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig, type AppConfig } from "../src/config.js";
import { WorkbookStore } from "../src/excel/workbook-store.js";
import { runPreflight } from "../src/operations/preflight.js";
import { createFixtureWorkbook, type WorkbookFixture } from "./helpers/workbook-fixture.js";

const NOW = new Date().toISOString();
const OLD = new Date(Date.now() - 90 * 60 * 1000).toISOString();

async function setup(fixture: WorkbookFixture): Promise<{ config: AppConfig; workbookPath: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mag-preflight-"));
  const workbookPath = path.join(dir, "book.xlsx");
  await createFixtureWorkbook(workbookPath, fixture);
  const base = await loadConfig();
  const config: AppConfig = {
    ...base,
    workbookPath,
    fieldRegistryPath: path.join(dir, "field-registry.json"),
    reconciliationStatePath: path.join(dir, "reconciliation-state.json"),
    backupsDir: path.join(dir, "backups"),
    dryRun: true,
  };
  return { config, workbookPath, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

const PERSON = (id: string, status = "PENDING") =>
  [id, "Test", "Person", "5555550100", `${id.toLowerCase()}@example.invalid`, "1 Way", "Town", "FL", "32606", "", "", "", "", status, "", ""];
const SITE = (id: string, url: string) => [id, `Site ${id}`, url, "YES", "ACTIVE", "", "", ""];
const attemptRow = (aId: string, pId: string, sId: string, status: string, when = NOW, retry = "NO", notes = "n") =>
  ["", "", "", "", "", "", "", "", "", aId, pId, sId, when, status, "1", "https://example.invalid/x", "", retry, notes];
const summaryRow = (pId: string, passed: number) => [pId, "Test Person", NOW, String(passed), String(passed), "0", "0"];

test("clean workbook passes with no changes and does not block startup", async () => {
  const { config, cleanup } = await setup({
    sites: [SITE("S0001", "https://example.invalid/a")],
    people: [PERSON("P0001")],
  });
  try {
    const result = await runPreflight(config);
    assert.equal(result.blocked, false);
    assert.ok(result.lines.some((line) => line.includes("Reconciling... PASS")));
    assert.ok(result.lines.some((line) => line.includes("No reconciliation changes required.")));
  } finally {
    await cleanup();
  }
});

test("a deterministic gap (blank ID / STATUS) is repaired as a safe update", async () => {
  const { config, workbookPath, cleanup } = await setup({
    sites: [SITE("S0001", "https://example.invalid/a")],
    people: [["", "New", "Person", "", "new@example.invalid", "", "", "", "", "", "", "", "", "", "", ""]],
  });
  try {
    const result = await runPreflight(config);
    assert.equal(result.blocked, false);
    assert.ok(result.deterministicUpdates >= 1);
    assert.ok(result.lines.some((line) => /safe update/.test(line)));
    const store = new WorkbookStore(workbookPath);
    await store.open();
    try {
      assert.match(store.getPeople()[0]!.id, /^P\d{4}$/);
      assert.equal(store.getPeople()[0]!.status, "PENDING");
    } finally {
      await store.release();
    }
  } finally {
    await cleanup();
  }
});

test("a duplicate ATTEMPT ID blocks startup", async () => {
  const { config, cleanup } = await setup({
    sites: [SITE("S0001", "https://example.invalid/a"), SITE("S0002", "https://example.invalid/b")],
    people: [PERSON("P0001")],
    results: [attemptRow("A-DUP", "P0001", "S0001", "TEMP FAILURE"), attemptRow("A-DUP", "P0001", "S0002", "TEMP FAILURE")],
  });
  try {
    const result = await runPreflight(config);
    assert.equal(result.blocked, true);
    assert.ok(result.critical.some((item) => /duplicate attempt id/i.test(item)));
    assert.ok(result.lines.some((line) => line.includes("Worker NOT started.")));
  } finally {
    await cleanup();
  }
});

test("a summary claiming more completions than the ledger supports blocks startup", async () => {
  const { config, cleanup } = await setup({
    sites: [SITE("S0001", "https://example.invalid/a")],
    people: [PERSON("P0001")],
    results: [summaryRow("P0001", 3), attemptRow("A-1", "P0001", "S0001", "COMPLETED")],
  });
  try {
    const result = await runPreflight(config);
    assert.equal(result.blocked, true);
    assert.ok(result.critical.some((item) => /summary reports 3/.test(item)));
  } finally {
    await cleanup();
  }
});

test("a COMPLETED Results row referencing an unknown Site ID blocks startup", async () => {
  const { config, cleanup } = await setup({
    sites: [SITE("S0001", "https://example.invalid/a")],
    people: [PERSON("P0001")],
    results: [attemptRow("A-1", "P0001", "S0404", "COMPLETED")],
  });
  try {
    const result = await runPreflight(config);
    assert.equal(result.blocked, true);
    assert.ok(result.critical.some((item) => /unknown Site ID S0404/.test(item)));
  } finally {
    await cleanup();
  }
});

test("a terminal Results row referencing a missing site is safely closed, not blocked", async () => {
  const { config, workbookPath, cleanup } = await setup({
    sites: [SITE("S0001", "https://example.invalid/a")],
    people: [PERSON("P0001", "WAITING FOR HUMAN")],
    results: [attemptRow("A-ORPH", "P0001", "S0404", "WAITING FOR HUMAN", NOW, "YES", "No safe navigation action")],
  });
  try {
    const result = await runPreflight(config);
    assert.equal(result.blocked, false);
    assert.ok(result.safeRepairs.some((item) => /orphaned attempt/i.test(item)));
    const store = new WorkbookStore(workbookPath);
    await store.open();
    try {
      const attempt = store.getAttempts().find((a) => a.attemptId === "A-ORPH");
      assert.equal(attempt?.status, "FAILED");
      assert.equal(attempt?.retryEligible, "NO");
    } finally {
      await store.release();
    }
  } finally {
    await cleanup();
  }
});

test("reconciliation preserves completed, deferred, handoff, and permanent-skip history", async () => {
  const { config, workbookPath, cleanup } = await setup({
    sites: ["S0001", "S0002", "S0003", "S0004"].map((id) => SITE(id, `https://example.invalid/${id}`)),
    people: [PERSON("P0001", "IN PROGRESS")],
    results: [
      attemptRow("A-DONE", "P0001", "S0001", "COMPLETED", NOW, "NO", "Signup completed"),
      attemptRow("A-DEFER", "P0001", "S0002", "OPERATOR_DEFERRED", NOW, "YES", "Deferred: SPACE"),
      attemptRow("A-HUMAN", "P0001", "S0003", "WAITING FOR HUMAN", NOW, "YES", "CAPTCHA"),
      attemptRow("A-SKIP", "P0001", "S0004", "FAILED", NOW, "NO", "Operator permanent skip"),
    ],
  });
  try {
    const result = await runPreflight(config);
    assert.equal(result.blocked, false);
    const store = new WorkbookStore(workbookPath);
    await store.open();
    try {
      assert.equal(store.getLatestAttempt("P0001", "S0001")?.status, "COMPLETED");
      assert.equal(store.getLatestAttempt("P0001", "S0001")?.attemptId, "A-DONE");
      assert.equal(store.getLatestAttempt("P0001", "S0002")?.status, "OPERATOR_DEFERRED");
      assert.equal(store.getLatestAttempt("P0001", "S0003")?.status, "WAITING FOR HUMAN");
      assert.equal(store.getLatestAttempt("P0001", "S0004")?.status, "FAILED");
      assert.equal(store.getLatestAttempt("P0001", "S0004")?.retryEligible, "NO");
    } finally {
      await store.release();
    }
  } finally {
    await cleanup();
  }
});

test("a live workbook lock held by this process blocks startup", async () => {
  const { config, workbookPath, cleanup } = await setup({
    sites: [SITE("S0001", "https://example.invalid/a")],
    people: [PERSON("P0001")],
  });
  try {
    await writeFile(`${workbookPath}.lock`, JSON.stringify({ pid: process.pid, startedAt: NOW }));
    const result = await runPreflight(config);
    assert.equal(result.blocked, true);
    assert.equal(result.lockState, "held");
    assert.ok(result.critical.some((item) => /already running/i.test(item)));
  } finally {
    await rm(`${workbookPath}.lock`, { force: true });
    await cleanup();
  }
});

test("a stale in-progress attempt is routed to human review as a safe repair, not blocked or retried", async () => {
  const { config, workbookPath, cleanup } = await setup({
    sites: [SITE("S0001", "https://example.invalid/a")],
    people: [PERSON("P0001", "IN PROGRESS")],
    results: [attemptRow("A-STALE", "P0001", "S0001", "IN PROGRESS", OLD, "YES", "Scanning page 2")],
  });
  try {
    const result = await runPreflight(config);
    assert.equal(result.blocked, false);
    assert.ok(result.safeRepairs.some((item) => /human review/i.test(item)));
    const store = new WorkbookStore(workbookPath);
    await store.open();
    try {
      const attempt = store.getLatestAttempt("P0001", "S0001");
      assert.equal(attempt?.status, "WAITING FOR HUMAN");
      assert.match(attempt?.notes ?? "", /confirm whether the external submission completed/);
    } finally {
      await store.release();
    }
  } finally {
    await cleanup();
  }
});

test("a recent in-progress attempt (fresh crash window) is left untouched", async () => {
  const { config, workbookPath, cleanup } = await setup({
    sites: [SITE("S0001", "https://example.invalid/a")],
    people: [PERSON("P0001", "IN PROGRESS")],
    results: [attemptRow("A-FRESH", "P0001", "S0001", "IN PROGRESS", NOW, "YES", "Scanning page 1")],
  });
  try {
    const result = await runPreflight(config);
    assert.equal(result.blocked, false);
    const store = new WorkbookStore(workbookPath);
    await store.open();
    try {
      assert.equal(store.getLatestAttempt("P0001", "S0001")?.status, "IN PROGRESS");
    } finally {
      await store.release();
    }
  } finally {
    await cleanup();
  }
});
