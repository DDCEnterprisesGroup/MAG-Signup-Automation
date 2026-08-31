import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { launchCompatibleBrowser } from "../src/browser/browser-launch.js";
import { loadConfig } from "../src/config.js";
import { WorkbookStore } from "../src/excel/workbook-store.js";
import { Logger } from "../src/logging/logger.js";
import { WorkflowEngine } from "../src/workflow/engine.js";
import type { LiveStatus, OperatorControl, OperatorRequest } from "../src/workflow/operator-console.js";
import { createFixtureWorkbook } from "./helpers/workbook-fixture.js";

interface Rule {
  site: string;
  request: Exclude<OperatorRequest, null>;
  needPhase?: string;
}

/** Fires a hotkey request once, when the engine reaches the target site/phase. */
class ScriptedControl implements OperatorControl {
  readonly stopRequested = false;
  handoffs = 0;
  deferred = 0;
  private current: LiveStatus = {};
  private readonly fired = new Set<string>();

  constructor(private readonly rules: Rule[] = []) {}

  async checkpoint(): Promise<OperatorRequest> {
    for (const rule of this.rules) {
      const key = `${rule.site}:${rule.request}`;
      if (this.fired.has(key)) continue;
      if (this.current.siteId !== rule.site) continue;
      if (rule.needPhase && !(this.current.phase ?? "").includes(rule.needPhase)) continue;
      this.fired.add(key);
      return rule.request;
    }
    return null;
  }
  suspendInput(): void {}
  resumeInput(): void {}
  setStatus(patch: LiveStatus): void {
    this.current = { ...this.current, ...patch };
  }
  note(): void {}
  countCompleted(): void {}
  countFailed(): void {}
  countDeferred(): void {
    this.deferred += 1;
  }
  countHandoff(): void {
    this.handoffs += 1;
  }
  close(): void {}
}

async function withFixture(
  run: (context: {
    baseUrl: string;
    requests: string[];
    workbook: WorkbookStore;
    config: Awaited<ReturnType<typeof loadConfig>>;
    tempDir: string;
  }) => Promise<void>,
): Promise<void> {
  const requests: string[] = [];
  const server: Server = createServer((request, response) => {
    const requestPath = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    requests.push(requestPath);
    response.setHeader("content-type", "text/html; charset=utf-8");
    if (requestPath === "/site1" || requestPath === "/site2") {
      response.end(
        `<h1>Create your account</h1><form action="${requestPath}/confirmed"><label>Email <input type="email" name="email" required></label><button>Register</button></form>`,
      );
      return;
    }
    if (requestPath === "/site1/confirmed" || requestPath === "/site2/confirmed") {
      response.end("<h1>Registration complete</h1><p>Your account has been created.</p>");
      return;
    }
    response.statusCode = 404;
    response.end("Not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "mag-hotkeys-"));
  const workbookPath = path.join(tempDir, "fixture.xlsx");
  await createFixtureWorkbook(workbookPath, {
    sites: [
      ["S0001", "Site One", `${baseUrl}/site1`, "YES", "ACTIVE", "", "", ""],
      ["S0002", "Site Two", `${baseUrl}/site2`, "YES", "ACTIVE", "", "", ""],
    ],
    people: [
      ["P0001", "Test", "Operator", "5555550100", "op@example.invalid", "1 Way", "Town", "FL", "32606", "01/02/1990", "Engineer", "85000", "x", "PENDING", "", ""],
    ],
  });
  const config = {
    ...(await loadConfig()),
    workbookPath,
    headless: true,
    browserChannel: "chrome",
    siteDelayMinMs: 0,
    siteDelayMaxMs: 0,
    navigationTimeoutMs: 10_000,
    logsDir: path.join(tempDir, "logs"),
    screenshotsDir: path.join(tempDir, "screenshots"),
    runtimeDir: path.join(tempDir, "runtime"),
    dryRun: false,
  };
  const workbook = new WorkbookStore(workbookPath);
  await workbook.open();
  try {
    await run({ baseUrl, requests, workbook, config, tempDir });
  } finally {
    await workbook.release();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function chromeAvailable(): Promise<boolean> {
  try {
    const probe = (await launchCompatibleBrowser("chrome")).browser;
    await probe.close();
    return true;
  } catch {
    return false;
  }
}

test("SPACE defers the current site: not completed, not permanently failed, still retryable next run", async (context) => {
  if (!(await chromeAvailable())) return context.skip("No compatible Chrome/Chromium");
  await withFixture(async ({ config, workbook, tempDir }) => {
    const logger = await Logger.create(config.logsDir);
    const control = new ScriptedControl([{ site: "S0001", request: "defer", needPhase: "scanning" }]);
    const stats = await new WorkflowEngine(config, workbook, logger, undefined, control).run(new Set(["P0001"]));

    assert.equal(stats.deferred, 1);
    assert.equal(control.deferred, 1);
    const deferred = workbook.getLatestAttempt("P0001", "S0001");
    assert.equal(deferred?.status, "OPERATOR_DEFERRED");
    assert.equal(deferred?.retryEligible, "YES");
    assert.notEqual(deferred?.status, "COMPLETED");
    assert.equal(workbook.getLatestAttempt("P0001", "S0002")?.status, "COMPLETED", "the run advanced to the next site");

    // A fresh run (no operator) must pick the deferred site back up and finish it.
    const resumeLogger = await Logger.create(path.join(tempDir, "logs2"));
    await new WorkflowEngine(config, workbook, resumeLogger).run(new Set(["P0001"]));
    assert.equal(workbook.getLatestAttempt("P0001", "S0001")?.status, "COMPLETED");
  });
});

test("S permanently skips exactly the current person/site and nothing else", async (context) => {
  if (!(await chromeAvailable())) return context.skip("No compatible Chrome/Chromium");
  await withFixture(async ({ config, workbook, tempDir }) => {
    const logger = await Logger.create(config.logsDir);
    const control = new ScriptedControl([{ site: "S0001", request: "skip", needPhase: "scanning" }]);
    await new WorkflowEngine(config, workbook, logger, undefined, control).run(new Set(["P0001"]));

    const skipped = workbook.getLatestAttempt("P0001", "S0001");
    assert.equal(skipped?.status, "FAILED");
    assert.equal(skipped?.retryEligible, "NO");
    assert.equal(workbook.getLatestAttempt("P0001", "S0002")?.status, "COMPLETED");

    // A fresh run must NOT reprocess the permanently skipped pair.
    const resumeLogger = await Logger.create(path.join(tempDir, "logs2"));
    await new WorkflowEngine(config, workbook, resumeLogger).run(new Set(["P0001"]));
    assert.equal(workbook.getLatestAttempt("P0001", "S0001")?.attemptId, skipped?.attemptId);
    assert.equal(workbook.getLatestAttempt("P0001", "S0001")?.status, "FAILED");
  });
});

test("R retries the current site from the top and it still completes", async (context) => {
  if (!(await chromeAvailable())) return context.skip("No compatible Chrome/Chromium");
  await withFixture(async ({ config, workbook, requests }) => {
    const logger = await Logger.create(config.logsDir);
    const control = new ScriptedControl([{ site: "S0001", request: "retry", needPhase: "scanning" }]);
    await new WorkflowEngine(config, workbook, logger, undefined, control).run(new Set(["P0001"]));

    assert.ok(requests.filter((p) => p === "/site1").length >= 2, "site1 was navigated at least twice");
    assert.equal(workbook.getLatestAttempt("P0001", "S0001")?.status, "COMPLETED");
  });
});

test("hotkey activity leaves the workbook valid and reopenable", async (context) => {
  if (!(await chromeAvailable())) return context.skip("No compatible Chrome/Chromium");
  await withFixture(async ({ config, workbook }) => {
    const logger = await Logger.create(config.logsDir);
    const control = new ScriptedControl([{ site: "S0001", request: "defer", needPhase: "scanning" }]);
    await new WorkflowEngine(config, workbook, logger, undefined, control).run(new Set(["P0001"]));
    await workbook.release();

    const reopened = new WorkbookStore(config.workbookPath);
    await reopened.open();
    try {
      assert.equal(reopened.getPeople().length, 1);
      assert.equal(reopened.getAttempts().every((a) => a.attemptId), true);
    } finally {
      await reopened.release();
    }
    await workbook.open();
  });
});
