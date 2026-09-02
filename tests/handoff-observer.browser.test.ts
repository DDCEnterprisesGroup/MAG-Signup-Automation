import assert from "node:assert/strict";
import test from "node:test";
import { launchCompatibleBrowser } from "../src/browser/browser-launch.js";
import { scanAndFillPage } from "../src/forms/form-handler.js";
import type { AttemptRecord, PersonProfile, Site } from "../src/types/models.js";
import { captureHandoffSnapshot, observeHandoffPage } from "../src/workflow/handoff-observer.js";
import { waitForOperator } from "../src/workflow/human-handoff.js";
import type { OperatorControl, OperatorRequest } from "../src/workflow/operator-console.js";

const person: PersonProfile = {
  rowNumber: 2,
  id: "PTEST",
  firstName: "Test",
  lastName: "Operator",
  phone: "5555550100",
  email: "test@example.invalid",
  address: "1 Test Way",
  city: "Testville",
  state: "FL",
  zip: "32606",
  dob: "01/02/1990",
  occupation: "Engineer",
  annualIncome: "85000",
  password: "[REDACTED_TEST_PASSWORD]",
  dynamicFields: {},
  status: "PENDING",
  currentSiteId: "",
  lastUpdated: "",
};

const site = { id: "S-TEST", name: "Test Site" } as Site;
const attempt = { attemptId: "A-TEST", formStep: 1 } as AttemptRecord;

function scriptedControl(requests: OperatorRequest[]): OperatorControl {
  return {
    stopRequested: false,
    async checkpoint() { return requests.shift() ?? null; },
    suspendInput() {}, resumeInput() {}, setStatus() {}, progress() {}, note() {},
    countCompleted() {}, countFailed() {}, countDeferred() {}, countHandoff() {}, close() {},
  };
}

test("human-handoff page observation regressions", async (context) => {
  let browser;
  try {
    browser = (await launchCompatibleBrowser("chrome")).browser;
  } catch {
    context.skip("No compatible Chrome or Playwright Chromium browser is available");
    return;
  }

  try {
    await context.test("manual Submit to confirmation page is automatically classified COMPLETED", async () => {
      const page = await browser.newPage();
      await page.setContent(`
        <form id="signup">
          <label>PIN <input id="pin"></label>
          <button id="submit" type="button">Submit</button>
        </form>
        <script>
          submit.onclick = () => {
            history.pushState({}, "", "#confirmed");
            document.body.innerHTML = "<h1>Registration complete</h1><p>Your account has been created.</p>";
          };
        </script>
      `);
      const baseline = await captureHandoffSnapshot(page);
      const observed = observeHandoffPage(page, baseline, { pollIntervalMs: 25 });
      await page.fill("#pin", "1234");
      await page.click("#submit");
      const result = await observed;
      assert.equal(result.kind, "completed");
      await page.close();
    });

    await context.test("manual Next to a subsequent form page automatically resumes automation", async () => {
      const page = await browser.newPage();
      await page.setContent(`
        <form id="step-one">
          <label>Security Answer <input id="answer"></label>
          <button id="next" type="button">Next</button>
        </form>
        <script>
          next.onclick = () => {
            history.pushState({}, "", "#step-2");
            document.body.innerHTML = '<h1>Contact details</h1><form id="step-two"><label>Mobile Phone <input id="phone" type="tel"></label><button>Continue</button></form>';
          };
        </script>
      `);
      const baseline = await captureHandoffSnapshot(page);
      const observed = observeHandoffPage(page, baseline, { pollIntervalMs: 25 });
      await page.fill("#answer", "operator controlled");
      await page.click("#next");
      const result = await observed;
      assert.equal(result.kind, "progressed");
      assert.equal(await page.locator("#phone").count(), 1);
      const resumed = await scanAndFillPage(page, person);
      assert.equal(await page.locator("#phone").inputValue(), person.phone);
      assert.deepEqual(resumed.filledFields, ["phone"]);
      await page.close();
    });

    await context.test("manual Submit with validation errors is not completed", async () => {
      const page = await browser.newPage();
      await page.setContent(`
        <form>
          <label>Email <input id="email"></label>
          <button id="submit" type="button">Submit</button>
        </form>
        <script>
          submit.onclick = () => {
            email.setAttribute("aria-invalid", "true");
            const error = document.createElement("div");
            error.setAttribute("role", "alert");
            error.textContent = "A valid email is required";
            document.querySelector("form").prepend(error);
          };
        </script>
      `);
      const baseline = await captureHandoffSnapshot(page);
      const observed = observeHandoffPage(page, baseline, { pollIntervalMs: 25 });
      await page.click("#submit");
      const result = await observed;
      assert.equal(result.kind, "validation_error");
      assert.notEqual(result.kind, "completed");
      const rescanned = await scanAndFillPage(page, person);
      assert.equal(rescanned.success, false);
      await page.close();
    });

    await context.test("permanent-skip hotkey remains actionable during human handoff", async () => {
      const page = await browser.newPage();
      await page.setContent('<form><label>SSN <input name="ssn"></label></form>');
      const decision = await waitForOperator(
        person, site, attempt,
        { category: "REQUIRED_MANUAL_FIELD", reason: "Restricted field" },
        page,
        scriptedControl(["skip"]),
      );
      assert.deepEqual(decision, { kind: "control", request: "skip" });
      await page.close();
    });

    await context.test("ambiguous manual page changes automatically request a rescan", async () => {
      const page = await browser.newPage();
      await page.setContent('<form><label>SSN <input name="ssn"></label><button id="next" type="button">Next</button></form><script>next.onclick=()=>{history.pushState({},"","#next");document.body.innerHTML="<h1>Review details</h1>"}</script>');
      const waiting = waitForOperator(
        person, site, attempt,
        { category: "REQUIRED_MANUAL_FIELD", reason: "Restricted field" },
        page,
        scriptedControl([]),
      );
      await page.click("#next");
      const decision = await waiting;
      assert.equal(decision.kind, "resume");
      if (decision.kind === "resume") assert.equal(decision.source, "automatic");
      await page.close();
    });

    await context.test("redirect to an ambiguous page remains WAITING_FOR_HUMAN", async () => {
      const page = await browser.newPage();
      await page.setContent(`
        <form>
          <label>Passport Number <input id="passport"></label>
          <button id="submit" type="button">Submit</button>
        </form>
        <script>
          submit.onclick = () => {
            history.pushState({}, "", "#redirected");
            document.body.innerHTML = "<h1>Partner portal</h1><p>Continue with the instructions shown here.</p>";
          };
        </script>
      `);
      const baseline = await captureHandoffSnapshot(page);
      const observed = observeHandoffPage(page, baseline, { pollIntervalMs: 25 });
      await page.fill("#passport", "operator controlled");
      await page.click("#submit");
      const result = await observed;
      assert.equal(result.kind, "ambiguous");
      assert.notEqual(result.kind, "completed");
      await page.close();
    });

    await context.test("no operator action remains paused and does not advance", async () => {
      const page = await browser.newPage();
      await page.setContent('<form><label>PIN <input id="pin"></label><button type="button">Submit</button></form>');
      const baseline = await captureHandoffSnapshot(page);
      const controller = new AbortController();
      let settled = false;
      const observed = observeHandoffPage(page, baseline, { pollIntervalMs: 25, signal: controller.signal }).finally(() => {
        settled = true;
      });
      await page.waitForTimeout(250);
      assert.equal(settled, false);
      assert.equal(page.url(), baseline.url);
      controller.abort();
      await assert.rejects(observed, (error: Error) => error.name === "AbortError");
      await page.close();
    });
  } finally {
    await browser.close();
  }
});
