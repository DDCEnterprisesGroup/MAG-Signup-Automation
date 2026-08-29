import assert from "node:assert/strict";
import { createServer } from "node:http";
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

test("manual handoff submission completes and automatically advances to the next eligible site", async (context) => {
  let probe;
  try {
    probe = (await launchCompatibleBrowser("chrome")).browser;
  } catch {
    context.skip("No compatible Chrome or Playwright Chromium browser is available");
    return;
  } finally {
    await probe?.close();
  }

  const requests: string[] = [];
  const server = createServer((request, response) => {
    const requestUrl = request.url ?? "/";
    const requestPath = new URL(requestUrl, "http://127.0.0.1").pathname;
    requests.push(requestPath);
    response.setHeader("content-type", "text/html; charset=utf-8");
    if (requestPath === "/site1") {
      response.end(`
        <form action="/site1/confirmed">
          <label>PIN <input id="pin" name="pin" required></label>
          <button id="submit" type="submit">Submit</button>
        </form>
        <script>
          setTimeout(() => {
            pin.value = "operator-controlled";
            submit.click();
          }, 5000);
        </script>
      `);
      return;
    }
    if (requestPath === "/site1/confirmed") {
      response.end("<h1>Registration complete</h1><p>Your account has been created.</p>");
      return;
    }
    if (requestPath === "/site2") {
      response.end(`
        <form action="/site2/confirmed">
          <label>Email <input type="email" name="email" required></label>
          <button type="submit">Sign Up</button>
        </form>
      `);
      return;
    }
    if (requestPath === "/site2/confirmed") {
      response.end("<h1>Successfully registered</h1><p>Registration is complete.</p>");
      return;
    }
    response.statusCode = 404;
    response.end("Not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "mag-handoff-workflow-"));
  const workbookPath = path.join(tempDir, "fixture.xlsx");
  await createFixtureWorkbook(workbookPath, {
    sites: [
      ["S0001", "Manual Handoff Site", `${baseUrl}/site1`, "YES", "NOT CHECKED", "", "", ""],
      ["S0002", "Next Eligible Site", `${baseUrl}/site2`, "YES", "NOT CHECKED", "", "", ""],
    ],
    people: [
      ["P0001", "Test", "Operator", "5555550100", "test@example.invalid", "1 Test Way", "Testville", "FL", "32606", "01/02/1990", "Engineer", "85000", "[REDACTED_TEST_PASSWORD]", "PENDING", "", ""],
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
  const logger = await Logger.create(config.logsDir);
  const workbook = new WorkbookStore(workbookPath);
  try {
    await workbook.open();
    const engine = new WorkflowEngine(config, workbook, logger);
    const stats = await engine.run();
    assert.equal(stats.completed, 2);
    assert.ok(requests.includes("/site1/confirmed"));
    assert.ok(requests.includes("/site2"));
    assert.ok(requests.indexOf("/site1/confirmed") < requests.indexOf("/site2"));
    assert.equal(workbook.getLatestAttempt("P0001", "S0001")?.status, "COMPLETED");
    assert.equal(workbook.getLatestAttempt("P0001", "S0002")?.status, "COMPLETED");
  } finally {
    await workbook.release();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("a previously completed person receives only a newly added Site ID", async (context) => {
  let probe;
  try {
    probe = (await launchCompatibleBrowser("chrome")).browser;
  } catch {
    context.skip("No compatible Chrome or Playwright Chromium browser is available");
    return;
  } finally {
    await probe?.close();
  }
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const requestPath = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    requests.push(requestPath);
    response.setHeader("content-type", "text/html; charset=utf-8");
    if (requestPath === "/old") {
      response.end("<h1>This completed site must not run</h1>");
      return;
    }
    if (requestPath === "/new") {
      response.end('<h1>Create account</h1><form action="/new/confirmed"><label>Email <input type="email" required></label><button>Register</button></form>');
      return;
    }
    if (requestPath === "/new/confirmed") {
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
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "mag-new-site-"));
  const workbookPath = path.join(tempDir, "fixture.xlsx");
  await createFixtureWorkbook(workbookPath, {
    sites: [
      ["S0001", "Old Site", `${baseUrl}/old`, "YES", "ACTIVE", "", "", ""],
      ["S0002", "New Site", `${baseUrl}/new`, "YES", "ACTIVE", "", "", ""],
    ],
    people: [
      ["P0001", "Test", "Operator", "", "test@example.invalid", "", "", "", "", "", "", "", "", "COMPLETED", "", ""],
    ],
    results: [
      ["P0001", "Test Operator", new Date().toISOString(), "1", "1", "0", "0", "", "", "A-OLD", "P0001", "S0001", new Date().toISOString(), "COMPLETED", "1", `${baseUrl}/old/confirmed`, "", "NO", "Existing completion"],
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
  const logger = await Logger.create(config.logsDir);
  const workbook = new WorkbookStore(workbookPath);
  try {
    await workbook.open();
    const engine = new WorkflowEngine(config, workbook, logger);
    const stats = await engine.run(new Set(["P0001"]));
    assert.equal(stats.completed, 1);
    assert.equal(requests.includes("/old"), false);
    assert.equal(requests.includes("/new"), true);
    assert.equal(workbook.getLatestAttempt("P0001", "S0001")?.attemptId, "A-OLD");
    assert.equal(workbook.getLatestAttempt("P0001", "S0002")?.status, "COMPLETED");
  } finally {
    await workbook.release();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await rm(tempDir, { recursive: true, force: true });
  }
});
