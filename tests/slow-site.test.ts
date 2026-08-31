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
import { createFixtureWorkbook } from "./helpers/workbook-fixture.js";

async function chromeAvailable(): Promise<boolean> {
  try {
    const probe = (await launchCompatibleBrowser("chrome")).browser;
    await probe.close();
    return true;
  } catch {
    return false;
  }
}

interface Behaviour {
  mode: "ok" | "slow-once" | "always-hang";
}

async function withEngine(
  behaviour: Behaviour,
  overrides: Partial<Awaited<ReturnType<typeof loadConfig>>>,
  run: (context: {
    config: Awaited<ReturnType<typeof loadConfig>>;
    workbook: WorkbookStore;
    tempDir: string;
    hits: () => number;
  }) => Promise<void>,
): Promise<void> {
  let requestCount = 0;
  const server: Server = createServer((request, response) => {
    requestCount += 1;
    const requestPath = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const isFirst = requestCount === 1;
    response.setHeader("content-type", "text/html; charset=utf-8");
    const body = `<h1>Create your account</h1><form action="/done" method="get"><label>Email <input type="email" name="email" required></label><button>Register</button></form>`;
    if (requestPath === "/done") {
      response.end("<h1>Registration complete</h1><p>Your account has been created.</p>");
      return;
    }
    if (behaviour.mode === "always-hang") {
      // Send headers + a scrap of markup so a document context exists, then never
      // finish: navigation keeps timing out without the page ever being usable.
      response.writeHead(200, { "content-type": "text/html" });
      response.write("<html><body>loading");
      return;
    }
    if (behaviour.mode === "slow-once" && isFirst) {
      // First hit stalls (headers + a scrap, never finished); the retry is a
      // fresh request that gets the full page.
      response.writeHead(200, { "content-type": "text/html" });
      response.write("<html><body>still loading");
      return;
    }
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "mag-slow-"));
  const workbookPath = path.join(tempDir, "fixture.xlsx");
  await createFixtureWorkbook(workbookPath, {
    sites: [["S0001", "Slow Site", `${baseUrl}/signup`, "YES", "ACTIVE", "", "", ""]],
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
    retryDelayMs: 0,
    logsDir: path.join(tempDir, "logs"),
    screenshotsDir: path.join(tempDir, "screenshots"),
    runtimeDir: path.join(tempDir, "runtime"),
    dryRun: false,
    ...overrides,
  };
  const workbook = new WorkbookStore(workbookPath);
  await workbook.open();
  try {
    await run({ config, workbook, tempDir, hits: () => requestCount });
  } finally {
    await workbook.release();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(tempDir, { recursive: true, force: true });
  }
}

test("a fast site loads and completes normally", async (context) => {
  if (!(await chromeAvailable())) return context.skip("No Chrome");
  await withEngine({ mode: "ok" }, { navigationTimeoutMs: 8_000, navigationRetryTimeoutMs: 12_000 }, async ({ config, workbook }) => {
    const logger = await Logger.create(config.logsDir);
    const stats = await new WorkflowEngine(config, workbook, logger).run(new Set(["P0001"]));
    assert.equal(stats.completed, 1);
    assert.equal(workbook.getLatestAttempt("P0001", "S0001")?.status, "COMPLETED");
  });
});

test("a site that is slow on the first attempt succeeds on the extended retry (not marked INVALID)", async (context) => {
  if (!(await chromeAvailable())) return context.skip("No Chrome");
  await withEngine(
    { mode: "slow-once" },
    { navigationTimeoutMs: 1_000, navigationRetryTimeoutMs: 12_000, navigationRetries: 2 },
    async ({ config, workbook }) => {
      const logger = await Logger.create(config.logsDir);
      const stats = await new WorkflowEngine(config, workbook, logger).run(new Set(["P0001"]));
      assert.equal(stats.completed, 1);
      const attempt = workbook.getLatestAttempt("P0001", "S0001");
      assert.equal(attempt?.status, "COMPLETED");
      assert.notEqual(attempt?.status, "SITE INVALID");
    },
  );
});

test("repeated total timeouts defer the site (retryable) instead of failing it permanently", async (context) => {
  if (!(await chromeAvailable())) return context.skip("No Chrome");
  await withEngine(
    { mode: "always-hang" },
    { navigationTimeoutMs: 500, navigationRetryTimeoutMs: 700, navigationRetries: 1, retryCount: 2, maxAutoDeferrals: 3 },
    async ({ config, workbook }) => {
      const logger = await Logger.create(config.logsDir);
      const stats = await new WorkflowEngine(config, workbook, logger).run(new Set(["P0001"]));

      assert.equal(stats.deferred, 1);
      const attempt = workbook.getLatestAttempt("P0001", "S0001");
      assert.equal(attempt?.status, "OPERATOR_DEFERRED");
      assert.equal(attempt?.retryEligible, "YES");
      assert.equal(attempt?.errorType, "NETWORK_TIMEOUT");
      assert.notEqual(attempt?.status, "FAILED");
      assert.notEqual(attempt?.status, "SITE INVALID");

      // Still processable on the next run.
      const logger2 = await Logger.create(path.join(config.logsDir, "..", "logs2"));
      await new WorkflowEngine(config, workbook, logger2).run(new Set(["P0001"]));
      assert.equal(workbook.getLatestAttempt("P0001", "S0001")?.status, "OPERATOR_DEFERRED");
      assert.equal(workbook.getAttemptCount("P0001", "S0001"), 2);
    },
  );
});

test("a chronically dead site stops looping once the defer ceiling is exhausted", async (context) => {
  if (!(await chromeAvailable())) return context.skip("No Chrome");
  await withEngine(
    { mode: "always-hang" },
    { navigationTimeoutMs: 400, navigationRetryTimeoutMs: 500, navigationRetries: 0, retryCount: 1, maxAutoDeferrals: 1 },
    async ({ config, workbook, tempDir }) => {
      // ceiling = retryCount + maxAutoDeferrals + 1 = 3 attempts before permanent FAILED.
      let runs = 0;
      let last = workbook.getLatestAttempt("P0001", "S0001");
      while ((!last || last.status === "OPERATOR_DEFERRED") && runs < 6) {
        runs += 1;
        const logger = await Logger.create(path.join(tempDir, `logs-${runs}`));
        await new WorkflowEngine(config, workbook, logger).run(new Set(["P0001"]));
        last = workbook.getLatestAttempt("P0001", "S0001");
      }
      assert.equal(last?.status, "FAILED");
      assert.equal(last?.retryEligible, "NO");
      assert.equal(runs, 3);
      // It never became a permanent SITE INVALID.
      assert.equal(
        workbook.getAttempts().some((a) => a.siteId === "S0001" && a.status === "SITE INVALID"),
        false,
      );
    },
  );
});
