import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { OPERATOR_RESUME_MARKER } from "../src/types/models.js";
import { appendNote } from "../src/utils/text.js";
import { WorkbookStore } from "../src/excel/workbook-store.js";
import { chromeAvailable, makeHarness, ScriptedControl } from "./helpers/engine-harness.js";

/**
 * Count how many times the engine logged a given `action` across every run's
 * JSONL log under `logsDir`. Used to assert on MAG's OWN dispatch (how many
 * final-submit clicks MAG issued), independently of how many times the browser's
 * transport layer re-issued a single broken navigation.
 */
async function countLogAction(logsDir: string, action: string): Promise<number> {
  let hits = 0;
  const needle = `"action":"${action}"`;
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith(".jsonl")) {
        const text = await readFile(full, "utf8").catch(() => "");
        for (const line of text.split("\n")) if (line.includes(needle)) hits += 1;
      }
    }
  };
  await walk(logsDir);
  return hits;
}

const REG_FORM = (action: string, email: string): string =>
  `<h1>Create your account</h1><form action="${action}" method="post">
     <label>Email <input type="email" name="email" value="${email}" required></label>
     <label>First name <input name="first_name" value="Dana" required></label>
     <label>Last name <input name="last_name" value="Okafor" required></label>
     <button type="submit">Sign Up</button></form>`;

async function releasePair(wbPath: string): Promise<void> {
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

// TEST A — worker stops right after the durable submit checkpoint + click, before the
// confirmation resolves. On restart: submission count stays 1, no return to the form.
test("A: stop after the submit checkpoint leaves AWAITING CONFIRMATION and never resubmits", async (context) => {
  if (!(await chromeAvailable())) return context.skip("No Chrome");
  const email = "dana.okafor@example.invalid";
  const h = await makeHarness((route, _req, res) => {
    if (route === "/signup") return void res.end(REG_FORM("/done", email));
    if (route === "/done") {
      res.writeHead(200);
      res.write("<html><body>");
      setTimeout(() => res.end("<h1>Registration complete</h1></body></html>"), 8_000);
      return;
    }
  });
  try {
    // stopAt: the checkpoint at the top of the re-check loop iteration that
    // follows the submit click -> the run ends with the durable state on disk.
    const r1 = await h.run(new ScriptedControl({ stopAt: 5 }), "run1");
    assert.ok(h.requests.filter((x) => x === "/done").length >= 1, "the submit reached the server once");
    assert.equal(h.requests.filter((x) => x === "/signup").length, 1);
    assert.equal(r1.status, "AWAITING CONFIRMATION");
    assert.equal(r1.retry, "NO");

    const before = h.requests.length;
    const r2 = await h.run(new ScriptedControl(), "run2-restart");
    assert.equal(h.requests.slice(before).length, 0, "a normal restart makes no requests — the pair is parked");
    assert.equal(r2.status, "AWAITING CONFIRMATION");

    await releasePair(h.wbPath);
    const beforeResume = h.requests.length;
    const r3 = await h.run(new ScriptedControl(), "run3-release");
    assert.equal(h.requests.slice(beforeResume).filter((x) => x === "/signup").length, 0);
    assert.equal(h.requests.filter((x) => x === "/signup").length, 1, "entry URL requested exactly once, ever");
    assert.equal(r3.status, "COMPLETED");
  } finally {
    await h.dispose();
  }
});

// TEST B1 — the server accepts the final submit and then returns a full HTTP 500.
// Exactly one server hit; MAG quarantines the attempt (AWAITING CONFIRMATION),
// never a retryable failure, and a normal restart does not retry.
test("B1: submit followed by HTTP 500 stays submission-uncertain, no defer/temp-failure, no retry", async (context) => {
  if (!(await chromeAvailable())) return context.skip("No Chrome");
  const email = "dana.okafor@example.invalid";
  let doneHits = 0;
  const h = await makeHarness((route, _req, res) => {
    if (route === "/signup") return void res.end(REG_FORM("/done", email));
    if (route === "/done") {
      doneHits += 1;
      res.writeHead(500, { "content-type": "text/html" });
      res.end("<h1>Server error</h1>");
    }
  });
  try {
    const r1 = await h.run(new ScriptedControl(), "run1");
    assert.equal(doneHits, 1, "submission reached the server exactly once");
    assert.equal(await countLogAction(h.config.logsDir, "click_final"), 1, "MAG dispatched exactly one final-submit click");
    assert.equal(r1.status, "AWAITING CONFIRMATION");
    assert.equal(r1.retry, "NO");
    assert.notEqual(r1.status, "OPERATOR_DEFERRED");
    assert.notEqual(r1.status, "TEMP FAILURE");

    const before = h.requests.length;
    await h.run(new ScriptedControl(), "run2");
    assert.equal(h.requests.slice(before).length, 0, "parked — no retry");
    assert.equal(doneHits, 1, "still exactly one submission");
  } finally {
    await h.dispose();
  }
});

// TEST B2 — the confirmation navigation's connection drops mid-response. Chrome's
// transport layer may transparently re-issue that ONE dropped navigation (an
// idempotent-retry heuristic MAG cannot suppress), so the raw server hit count is
// not the invariant here. The invariant is on MAG's OWN behavior: it dispatched
// exactly one final-submit click, recorded exactly one durable submission intent,
// never re-entered the submit boundary, and parked the attempt.
test("B2: a dropped post-submit navigation — MAG dispatches one submit, never re-enters the boundary", async (context) => {
  if (!(await chromeAvailable())) return context.skip("No Chrome");
  const email = "dana.okafor@example.invalid";
  const h = await makeHarness((route, _req, res) => {
    if (route === "/signup") return void res.end(REG_FORM("/done", email));
    if (route === "/done") {
      res.writeHead(200, { "content-type": "text/html", "content-length": "9999" });
      res.write("<html><body>processing your registration");
      res.socket?.destroy();
    }
  });
  try {
    const r1 = await h.run(new ScriptedControl(), "run1");
    assert.equal(await countLogAction(h.config.logsDir, "final_submit_intent"), 1, "exactly one durable submission intent recorded");
    assert.equal(await countLogAction(h.config.logsDir, "click_final"), 1, "MAG dispatched exactly one final-submit click");
    assert.equal(r1.status, "AWAITING CONFIRMATION");
    assert.equal(r1.retry, "NO");
    assert.notEqual(r1.status, "OPERATOR_DEFERRED");
    assert.notEqual(r1.status, "TEMP FAILURE");

    const before = h.requests.length;
    await h.run(new ScriptedControl(), "run2");
    assert.equal(h.requests.slice(before).length, 0, "parked — no retry");
    assert.equal(await countLogAction(h.config.logsDir, "click_final"), 1, "still exactly one final-submit click after a restart");
  } finally {
    await h.dispose();
  }
});

// TEST D (subset) — after durable submission intent, adverse conditions on the pinned
// confirmation URL cannot erase the quarantine or return to the entry form.
test("D: released re-check hitting HTTP 403 / another form / SPACE all stay AWAITING CONFIRMATION", async (context) => {
  if (!(await chromeAvailable())) return context.skip("No Chrome");
  const email = "dana.okafor@example.invalid";
  let confirmMode: "403" | "form" | "ok" = "403";
  const h = await makeHarness((route, _req, res) => {
    if (route === "/signup") return void res.end(REG_FORM("/done", email));
    if (route === "/done") {
      if (confirmMode === "403") {
        res.statusCode = 403;
        return void res.end("forbidden");
      }
      if (confirmMode === "form") return void res.end(REG_FORM("/done", email));
      return void res.end("<h1>Registration complete</h1>");
    }
  });
  try {
    const r1 = await h.run(new ScriptedControl(), "submit");
    assert.equal(r1.status, "AWAITING CONFIRMATION");

    // release -> re-check hits 403
    await releasePair(h.wbPath);
    let before = h.requests.length;
    const r403 = await h.run(new ScriptedControl(), "recheck-403");
    assert.equal(h.requests.slice(before).filter((x) => x === "/signup").length, 0);
    assert.equal(r403.status, "AWAITING CONFIRMATION", "403 on the confirmation URL never becomes a fresh failure");

    // release -> re-check lands on another submit form
    confirmMode = "form";
    await releasePair(h.wbPath);
    before = h.requests.length;
    const rForm = await h.run(new ScriptedControl(), "recheck-form");
    assert.equal(h.requests.slice(before).filter((x) => x === "/signup").length, 0);
    assert.equal(rForm.status, "AWAITING CONFIRMATION", "another submit control is never auto-clicked");

    // release -> re-check + SPACE
    await releasePair(h.wbPath);
    confirmMode = "403";
    before = h.requests.length;
    const rSpace = await h.run(new ScriptedControl({ emitAt: 3, emit: "defer" }), "recheck-space");
    assert.equal(h.requests.slice(before).filter((x) => x === "/signup").length, 0);
    assert.equal(rSpace.status, "AWAITING CONFIRMATION");

    // finally a clean re-check completes
    confirmMode = "ok";
    await releasePair(h.wbPath);
    const rOk = await h.run(new ScriptedControl(), "recheck-ok");
    assert.equal(rOk.status, "COMPLETED");
    assert.equal(h.requests.filter((x) => x === "/signup").length, 1, "entry URL never re-requested");
  } finally {
    await h.dispose();
  }
});
