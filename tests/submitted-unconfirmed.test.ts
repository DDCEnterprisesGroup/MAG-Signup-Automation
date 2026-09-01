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
import { OPERATOR_RESUME_MARKER } from "../src/types/models.js";
import { appendNote } from "../src/utils/text.js";
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
    assert.ok(requests.filter((x) => x === "/done").length >= 1, "run 1 submitted the form (GET /done)");
    assert.equal(requests.filter((x) => x === "/signup").length, 1, "run 1 loaded the entry form exactly once");
    assert.equal(r1.status, "AWAITING CONFIRMATION", "submission-uncertain — durable typed state, not a note");
    assert.equal(r1.retry, "NO");
    assert.match(r1.lastUrl, /\/done$/, "pinned to the confirmation URL");
    assert.doesNotMatch(r1.notes, new RegExp(OPERATOR_RESUME_MARKER), "not yet operator-released");

    // Run 2: ordinary `mag start`. The pair is PARKED — nothing is requested.
    const before = requests.length;
    const r2 = await run(new SpaceAt(0), "run2");
    assert.equal(requests.slice(before).length, 0, "run 2 makes no HTTP requests — the pair is quarantined");
    assert.equal(r2.status, "AWAITING CONFIRMATION", "still parked after a normal restart");

    // Explicit operator release (equivalent of `mag handoff resume`): stamp the marker.
    {
      const wb = new WorkbookStore(wbPath);
      await wb.open();
      try {
        const attempt = wb.getAttempts().find((a) => a.personId === "P0001" && a.siteId === "S0001");
        assert.ok(attempt);
        await wb.updateAttempt(attempt, { notes: appendNote(attempt.notes, `${OPERATOR_RESUME_MARKER} re-check`) });
      } finally {
        await wb.release();
      }
    }

    const beforeResume = requests.length;
    const r3 = await run(new SpaceAt(0), "run3");
    const resumeReqs = requests.slice(beforeResume);
    assert.equal(resumeReqs.filter((x) => x === "/signup").length, 0, "release re-checks the confirmation URL, never the entry form");
    assert.equal(requests.filter((x) => x === "/signup").length, 1, "signup entry URL requested exactly once across all runs");
    assert.equal(r3.status, "COMPLETED", "the confirmation page now shows success");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  }
});
