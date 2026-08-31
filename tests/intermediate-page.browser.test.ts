import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { launchCompatibleBrowser } from "../src/browser/browser-launch.js";
import { loadConfig } from "../src/config.js";
import { WorkbookStore } from "../src/excel/workbook-store.js";
import { scanAndFillPage } from "../src/forms/form-handler.js";
import { Logger } from "../src/logging/logger.js";
import { WorkflowEngine } from "../src/workflow/engine.js";
import { createFixtureWorkbook } from "./helpers/workbook-fixture.js";

const person = {
  rowNumber: 2, id: "P0001", firstName: "Test", lastName: "Operator", phone: "5555550100",
  email: "test@example.invalid", address: "1 Way", city: "Town", state: "FL", zip: "32606",
  dob: "01/02/1990", occupation: "Engineer", annualIncome: "85000", password: "[REDACTED_TEST_PASSWORD]",
  dynamicFields: {}, status: "PENDING", currentSiteId: "", lastUpdated: "",
} as const;

test("landing and intermediate pages are distinct from registration/final form steps", async (context) => {
  let browser;
  try { browser = (await launchCompatibleBrowser("chrome")).browser; }
  catch { return context.skip("No compatible Chrome/Chromium"); }
  try {
    const page = await browser.newPage();
    await page.setContent('<h1>Welcome</h1><button>Sign Up</button>');
    const landing = await scanAndFillPage(page, person);
    assert.equal(landing.phase, "LANDING_OR_INTERMEDIATE");
    assert.equal(landing.action?.kind, "signup");
    assert.equal(landing.recognizedFieldCount, 0);

    await page.setContent('<h1>Create account</h1><form><label>Email <input type="email" required></label><button>Register</button></form>');
    const registration = await scanAndFillPage(page, person);
    assert.equal(registration.phase, "FINAL_REGISTRATION_STEP");
    assert.equal(registration.action?.kind, "final");
    await page.close();
  } finally { await browser.close(); }
});

test("automatic signup entry and manual DOM transition both rescan and complete", async (context) => {
  let probe;
  try { probe = (await launchCompatibleBrowser("chrome")).browser; await probe.close(); }
  catch { return context.skip("No compatible Chrome/Chromium"); }
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const route = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    requests.push(route);
    response.setHeader("content-type", "text/html; charset=utf-8");
    if (route === "/auto") return void response.end('<h1>Welcome</h1><a href="/auto/register">Join Now</a>');
    if (route === "/auto/register") return void response.end('<h1>Register</h1><form action="/done"><label>Email <input type="email" required></label><button>Register</button></form>');
    if (route === "/manual") return void response.end(`<h1>Welcome</h1><button id="more">Learn more</button><div id="slot"></div><script>setTimeout(()=>more.click(),300);more.onclick=()=>setTimeout(()=>slot.innerHTML='<h2>Create account</h2><form action="/done"><label>Email <input type="email" required></label><button>Register</button></form>',300)</script>`);
    if (route === "/done") return void response.end("<h1>Registration complete</h1><p>Your account has been created.</p>");
    response.statusCode = 404; response.end("Not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const dir = await mkdtemp(path.join(os.tmpdir(), "mag-intermediate-"));
  const workbookPath = path.join(dir, "workbook.xlsx");
  await createFixtureWorkbook(workbookPath, {
    sites: [["S0001", "Auto", `${base}/auto`, "YES", "ACTIVE", "", "", ""], ["S0002", "Manual", `${base}/manual`, "YES", "ACTIVE", "", "", ""]],
    people: [[person.id, person.firstName, person.lastName, person.phone, person.email, person.address, person.city, person.state, person.zip, person.dob, person.occupation, person.annualIncome, person.password, "PENDING", "", ""]],
  });
  const config = { ...(await loadConfig()), workbookPath, headless: true, browserChannel: "chrome", siteDelayMinMs: 0, siteDelayMaxMs: 0,
    navigationTimeoutMs: 10_000, operatorAssistTimeoutMs: 2_000, logsDir: path.join(dir,"logs"), screenshotsDir: path.join(dir,"shots"), runtimeDir: path.join(dir,"runtime"), dryRun: false };
  const workbook = new WorkbookStore(workbookPath);
  try {
    await workbook.open();
    const logger = await Logger.create(config.logsDir);
    const stats = await new WorkflowEngine(config, workbook, logger).run(new Set([person.id]));
    assert.equal(stats.completed, 2);
    assert.ok(requests.includes("/auto/register"));
    assert.equal(workbook.getLatestAttempt(person.id, "S0001")?.status, "COMPLETED");
    assert.equal(workbook.getLatestAttempt(person.id, "S0002")?.status, "COMPLETED");
  } finally {
    await workbook.release(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await rm(dir, { recursive: true, force: true });
  }
});

test("an unchanged content page times out to retryable defer, never SITE INVALID", async (context) => {
  let probe;
  try { probe = (await launchCompatibleBrowser("chrome")).browser; await probe.close(); }
  catch { return context.skip("No compatible Chrome/Chromium"); }
  const server = createServer((_request, response) => response.end("<h1>Information only</h1><p>No account controls here.</p>"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const dir = await mkdtemp(path.join(os.tmpdir(), "mag-no-form-")); const workbookPath = path.join(dir, "workbook.xlsx");
  await createFixtureWorkbook(workbookPath, { sites: [["S0001", "No form", `http://127.0.0.1:${address.port}`, "YES", "ACTIVE", "", "", ""]], people: [[person.id, person.firstName, person.lastName, "", person.email, "", "", "", "", "", "", "", "", "PENDING", "", ""]] });
  const config = { ...(await loadConfig()), workbookPath, headless: true, browserChannel: "chrome", siteDelayMinMs: 0, siteDelayMaxMs: 0, operatorAssistTimeoutMs: 500, logsDir:path.join(dir,"logs"), screenshotsDir:path.join(dir,"s"), runtimeDir:path.join(dir,"r") };
  const workbook = new WorkbookStore(workbookPath);
  try { await workbook.open(); const logger = await Logger.create(config.logsDir); await new WorkflowEngine(config, workbook, logger).run(new Set([person.id])); const attempt=workbook.getLatestAttempt(person.id,"S0001"); assert.equal(attempt?.status,"OPERATOR_DEFERRED"); assert.equal(attempt?.retryEligible,"YES"); }
  finally { await workbook.release(); server.closeAllConnections(); await new Promise<void>((resolve)=>server.close(()=>resolve())); await rm(dir,{recursive:true,force:true}); }
});
