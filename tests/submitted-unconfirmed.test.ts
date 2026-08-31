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
import type { LiveStatus, OperatorControl, OperatorRequest } from "../src/workflow/operator-console.js";
import { createFixtureWorkbook } from "./helpers/workbook-fixture.js";

/** Presses SPACE (defer) exactly once, on the Nth engine checkpoint. */
class SpaceAt implements OperatorControl {
  readonly stopRequested = false;
  private calls = 0;
  constructor(private readonly at: number) {}
  async checkpoint(): Promise<OperatorRequest> {
    this.calls += 1;
    return this.calls === this.at ? "defer" : null;
  }
  suspendInput(): void {}
  resumeInput(): void {}
  setStatus(_p: LiveStatus): void {}
  progress(_m: string): void {}
  note(_m: string): void {}
  countCompleted(): void {}
  countFailed(): void {}
  countDeferred(): void {}
  countHandoff(): void {}
  close(): void {}
}

test("SPACE after an auto-submit (slow confirmation) does not restart the flow and never resubmits", async (context) => {
  let probe;
  try {
    probe = (await launchCompatibleBrowser("chrome")).browser;
    await probe.close();
  } catch {
    return context.skip("No compatible Chrome/Chromium");
  }

  const email = "dana.okafor@example.invalid";
  const requests: string[] = [];
  const server = createServer((req, res) => {
    const p = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    requests.push(p);
    res.setHeader("content-type", "text/html; charset=utf-8");
    if (p === "/signup") {
      res.end(`<h1>Create your account</h1><form action="/done" method="get">
        <label>Email <input type="email" name="email" value="${email}" required></label>
        <label>First name <input name="first_name" value="Dana" required></label>
        <label>Last name <input name="last_name" value="Okafor" required></label>
        <button type="submit">Sign Up</button></form>`);
      return;
    }
    if (p === "/done") {
      // Confirmation loads slowly: headers now, success body after 6s.
      res.writeHead(200, { "content-type": "text/html" });
      res.write("<html><body>");
      setTimeout(() => res.end("<h1>Registration complete</h1><p>Your account has been created.</p></body></html>"), 6000);
      return;
    }
    res.statusCode = 404;
    res.end("no");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const dir = await mkdtemp(path.join(os.tmpdir(), "mag-submitted-unconfirmed-"));
  const wbPath = path.join(dir, "wb.xlsx");
  await createFixtureWorkbook(wbPath, {
    sites: [["S0001", "Repro", `${base}/signup`, "YES", "ACTIVE", "", "", ""]],
    people: [["P0001", "Dana", "Okafor", "5555550100", email, "1 Way", "Town", "FL", "32606", "01/02/1990", "Eng", "85000", "x", "PENDING", "", ""]],
  });
  const cfg = {
    ...(await loadConfig()),
    workbookPath: wbPath,
    headless: true,
    browserChannel: "chrome",
    siteDelayMinMs: 0,
    siteDelayMaxMs: 0,
    navigationTimeoutMs: 15_000,
    navigationRetryTimeoutMs: 20_000,
    logsDir: path.join(dir, "logs"),
    screenshotsDir: path.join(dir, "s"),
    runtimeDir: path.join(dir, "r"),
    dryRun: false,
  };

  async function run(control: OperatorControl, label: string) {
    const wb = new WorkbookStore(wbPath);
    await wb.open();
    try {
      const logger = await Logger.create(path.join(cfg.logsDir, label));
      await new WorkflowEngine(cfg, wb, logger, undefined, control).run(new Set(["P0001"]));
      const attempt = wb.getLatestAttempt("P0001", "S0001");
      return { status: attempt?.status, retry: attempt?.retryEligible, notes: attempt?.notes ?? "", lastUrl: attempt?.lastUrl ?? "" };
    } finally {
      await wb.release();
    }
  }

  try {
    // Checkpoint #5 lands right after the final "Sign Up" click, while /done is loading.
    const r1 = await run(new SpaceAt(5), "run1");
    const submitCount = requests.filter((x) => x === "/done").length;
    const entryCountRun1 = requests.filter((x) => x === "/signup").length;

    assert.ok(submitCount >= 1, "run 1 should have submitted the form (GET /done)");
    assert.equal(entryCountRun1, 1, "run 1 loaded the entry form exactly once");
    assert.notEqual(r1.status, "OPERATOR_DEFERRED", "a submitted form must not be deferred as retryable-from-scratch");
    assert.equal(r1.status, "WAITING FOR HUMAN");
    assert.equal(r1.retry, "YES");
    assert.match(r1.lastUrl, /\/done$/, "run 1 attempt is pinned to the confirmation URL");
    assert.match(r1.notes, /does not resubmit/);

    // Run 2: no operator. Must resume the confirmation URL, never the entry form.
    const before = requests.length;
    const r2 = await run(new SpaceAt(0), "run2");
    const run2Requests = requests.slice(before);

    assert.equal(run2Requests.filter((x) => x === "/signup").length, 0, "run 2 must not re-navigate the signup entry URL");
    assert.equal(requests.filter((x) => x === "/signup").length, 1, "the signup entry URL was requested exactly once across both runs");
    assert.equal(r2.status, "COMPLETED", "run 2 resumes at the confirmation page and confirms completion");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  }
});
