import assert from "node:assert/strict";
import test from "node:test";
import { chromeAvailable, makeHarness, ScriptedControl } from "./helpers/engine-harness.js";

// TEST C — the operator (fixture: page JS) submits the form immediately before MAG
// would click. The server must receive EXACTLY ONE submission.
test("C: a manual submit in the race window results in exactly one server-side submission", async (context) => {
  if (!(await chromeAvailable())) return context.skip("No Chrome");
  const email = "dana.okafor@example.invalid";
  let doneHits = 0;
  const h = await makeHarness((route, _req, res) => {
    if (route === "/signup") {
      return void res.end(
        `<h1>Create your account</h1>
         <form id="f" action="/done" method="get">
           <label>Email <input type="email" name="email" value="${email}" required></label>
           <label>First name <input name="first_name" value="Dana" required></label>
           <label>Last name <input name="last_name" value="Okafor" required></label>
           <button type="submit">Sign Up</button>
         </form>
         <script>setTimeout(function(){ document.getElementById('f').submit(); }, 40);</script>`,
      );
    }
    if (route === "/done") {
      doneHits += 1;
      return void res.end("<h1>Registration complete</h1>");
    }
  });
  try {
    const r1 = await h.run(new ScriptedControl(), "race");
    assert.equal(doneHits, 1, `exactly one submission reached the server (got ${doneHits})`);
    // Because MAG could not prove it was its own click, the pair is quarantined.
    assert.ok(
      r1.status === "AWAITING CONFIRMATION" || r1.status === "COMPLETED",
      `race outcome must be submission-uncertain or a confirmed completion, got ${r1.status}`,
    );
    assert.notEqual(r1.status, "OPERATOR_DEFERRED");
    assert.notEqual(r1.status, "TEMP FAILURE");

    const before = h.requests.length;
    await h.run(new ScriptedControl(), "after");
    if (r1.status === "AWAITING CONFIRMATION") {
      assert.equal(h.requests.slice(before).length, 0, "parked — no retry");
    }
    assert.equal(doneHits, 1, "still exactly one submission after a restart");
  } finally {
    await h.dispose();
  }
});
