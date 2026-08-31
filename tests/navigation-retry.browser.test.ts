import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AppConfig } from "../src/config.js";
import { BrowserSession } from "../src/browser/browser-session.js";
import { Logger } from "../src/logging/logger.js";
import type { PersonProfile } from "../src/types/models.js";

const person: PersonProfile = {
  rowNumber: 2,
  id: "P0001",
  firstName: "Test",
  lastName: "Person",
  phone: "",
  email: "test@example.invalid",
  address: "",
  city: "",
  state: "",
  zip: "",
  dob: "",
  occupation: "",
  annualIncome: "",
  password: "",
  dynamicFields: {},
  status: "PENDING",
  currentSiteId: "",
  lastUpdated: "",
};

function config(root: string): AppConfig {
  return {
    projectRoot: process.cwd(),
    dataDir: root,
    workbookPath: path.join(root, "book.xlsx"),
    fieldRegistryPath: path.join(root, "field-registry.json"),
    reconciliationStatePath: path.join(root, "reconciliation.json"),
    headless: true,
    browserChannel: "chrome",
    workerCount: 1,
    navigationTimeoutMs: 100,
    navigationRetryTimeoutMs: 3_000,
    navigationRetries: 1,
    retryDelayMs: 0,
    siteDelayMinMs: 0,
    siteDelayMaxMs: 0,
    maxFormSteps: 12,
    maxRepeatedPageState: 2,
    screenshotOnError: false,
    retryCount: 2,
    maxAutoDeferrals: 4,
    dryRun: true,
    logsDir: path.join(root, "logs"),
    screenshotsDir: path.join(root, "screenshots"),
    runtimeDir: path.join(root, "runtime"),
    backupsDir: path.join(root, "backups"),
  };
}

test("navigation retries a timeout and accepts a usable DOM despite timeout without false INVALID classification", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mag-navigation-"));
  let requests = 0;
  const server = createServer((request, response) => {
    requests += 1;
    if (request.url === "/retry" && requests === 1) {
      setTimeout(() => response.end("<html><body>late first response</body></html>"), 300);
      return;
    }
    if (request.url === "/usable") {
      response.writeHead(200, { "content-type": "text/html" });
      response.write('<html><body><h1>Create account</h1><form><label>Email <input type="email"></label></form><p>' + "usable ".repeat(40) + "</p>");
      setTimeout(() => response.end("</body></html>"), 500);
      return;
    }
    response.end('<html><body><h1>Create account</h1><form><label>Email <input type="email"></label></form></body></html>');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const logger = await Logger.create(path.join(root, "logs"));
  const browser = new BrowserSession(config(root), logger, person);
  try {
    await browser.open();
  } catch {
    context.skip("Installed Chrome is unavailable in this environment");
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
    return;
  }
  try {
    const retry = await browser.navigate(`http://127.0.0.1:${address.port}/retry`);
    assert.equal(retry.attempts, 2);
    assert.ok(retry.status === 200 || retry.timedOutButUsable);
    assert.match(await browser.page.locator("body").innerText({ timeout: 3_000 }), /Create account/);

    const usable = await browser.navigate(`http://127.0.0.1:${address.port}/usable`);
    assert.equal(usable.timedOutButUsable, true);
    assert.equal(usable.status, null);
    assert.match(await browser.page.locator("body").innerText({ timeout: 3_000 }), /Create account/);
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
