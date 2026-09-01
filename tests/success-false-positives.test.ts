import assert from "node:assert/strict";
import test from "node:test";
import { chromeAvailable, makeHarness, ScriptedControl } from "./helpers/engine-harness.js";

// TEST I — a success-looking page that MAG reached WITHOUT sending a submit this
// attempt must never auto-complete. It is routed to human confirmation.
const CASES: Array<{ name: string; body: string; expect: "AWAITING CONFIRMATION" | "not-completed" }> = [
  { name: "marketing thank-you", body: "<h1>Thank you for signing up!</h1><p>Check out our other products.</p>", expect: "AWAITING CONFIRMATION" },
  { name: "stale persistent account state", body: "<h1>Your account has been created</h1><p>You are signed in.</p>", expect: "AWAITING CONFIRMATION" },
  { name: "generic welcome page", body: "<h1>Welcome</h1><p>Successfully registered.</p>", expect: "AWAITING CONFIRMATION" },
  { name: "already-authenticated dashboard", body: "<h1>Welcome back, Dana</h1><nav><a href='/account'>My account</a> <a href='/logout'>Sign out</a></nav><p>Your dashboard.</p>", expect: "not-completed" },
];

for (const testCase of CASES) {
  test(`I: "${testCase.name}" is never auto-COMPLETED without a current-attempt submit`, async (context) => {
    if (!(await chromeAvailable())) return context.skip("No Chrome");
    const h = await makeHarness((route, _req, res) => {
      if (route === "/signup") return void res.end(`<html><body>${testCase.body}</body></html>`);
    });
    try {
      const r1 = await h.run(new ScriptedControl(), "run1");
      assert.notEqual(r1.status, "COMPLETED", `${testCase.name} must not become COMPLETED`);
      if (testCase.expect === "AWAITING CONFIRMATION") {
        assert.equal(r1.status, "AWAITING CONFIRMATION", `${testCase.name} routes to human confirmation`);
      }
    } finally {
      await h.dispose();
    }
  });
}

// Control: a real registration completed via a submit THIS attempt does complete.
test("I: a genuine registration with a submit this attempt still completes", async (context) => {
  if (!(await chromeAvailable())) return context.skip("No Chrome");
  const email = "dana.okafor@example.invalid";
  const h = await makeHarness((route, _req, res) => {
    if (route === "/signup") {
      return void res.end(
        `<h1>Create your account</h1><form action="/done" method="get">
           <label>Email <input type="email" name="email" value="${email}" required></label>
           <label>First name <input name="first_name" value="Dana" required></label>
           <label>Last name <input name="last_name" value="Okafor" required></label>
           <button>Sign Up</button></form>`,
      );
    }
    if (route === "/done") return void res.end("<h1>Registration complete</h1><p>Your account has been created.</p>");
  });
  try {
    const r1 = await h.run(new ScriptedControl(), "run1");
    assert.equal(r1.status, "COMPLETED");
  } finally {
    await h.dispose();
  }
});
