import assert from "node:assert/strict";
import test from "node:test";
import { launchCompatibleBrowser } from "../src/browser/browser-launch.js";
import { scanAndFillPage } from "../src/forms/form-handler.js";
import type { PersonProfile } from "../src/types/models.js";

const person: PersonProfile = {
  rowNumber: 2,
  id: "PTEST",
  firstName: "Dana",
  lastName: "Okafor",
  phone: "5555550100",
  email: "dana.okafor@example.invalid",
  address: "1 Test Way",
  city: "Testville",
  state: "FL",
  zip: "32606",
  dob: "01/02/1990",
  occupation: "Engineer",
  annualIncome: "$85,000",
  password: "[REDACTED_TEST_PASSWORD]",
  dynamicFields: {},
  status: "PENDING",
  currentSiteId: "",
  lastUpdated: "",
};

test("auto-submit gates: prefilled data, partial forms, and blocking challenges", async (context) => {
  let browser;
  try {
    browser = (await launchCompatibleBrowser("chrome")).browser;
  } catch {
    context.skip("No compatible Chrome or Playwright Chromium browser is available");
    return;
  }
  try {
    await context.test("a fully prefilled, client-consistent registration form is a safe final submit", async () => {
      const page = await browser.newPage();
      await page.setContent(
        `<h1>Create your account</h1><form>
           <label>Email <input type="email" name="email" value="dana.okafor@example.invalid" required></label>
           <label>First name <input name="first_name" value="Dana" required></label>
           <label>Last name <input name="last_name" value="Okafor" required></label>
           <button type="submit">Create account</button>
         </form>`,
      );
      const scan = await scanAndFillPage(page, person);
      assert.equal(scan.humanHandoff, undefined);
      assert.equal(scan.action?.kind, "final");
      assert.ok((scan.identityFieldsSeen ?? []).includes("email"));
      await page.close();
    });

    await context.test("a partially filled form keeps filling the empty fields", async () => {
      const page = await browser.newPage();
      await page.setContent(
        `<h1>Register</h1><form>
           <label>Email <input type="email" name="email" value="dana.okafor@example.invalid" required></label>
           <label>First name <input name="first_name" required></label>
           <button type="submit">Register</button>
         </form>`,
      );
      const scan = await scanAndFillPage(page, person);
      assert.equal(scan.humanHandoff, undefined);
      assert.ok(scan.filledFields.includes("firstName"));
      assert.equal(await page.locator('input[name="first_name"]').inputValue(), "Dana");
      await page.close();
    });

    await context.test("a form prefilled with a different client's data is not submitted", async () => {
      const page = await browser.newPage();
      await page.setContent(
        `<h1>Create your account</h1><form>
           <label>Email <input type="email" name="email" value="stranger@evil.invalid" required></label>
           <label>First name <input name="first_name" value="Dana" required></label>
           <button type="submit">Create account</button>
         </form>`,
      );
      const scan = await scanAndFillPage(page, person);
      assert.equal(scan.humanHandoff?.category, "REQUIRED_MANUAL_FIELD");
      assert.match(scan.humanHandoff?.reason ?? "", /does not match the active client/);
      assert.notEqual(scan.action?.kind, "final");
      await page.close();
    });

    await context.test("a CAPTCHA challenge blocks auto-submit", async () => {
      const page = await browser.newPage();
      await page.setContent(
        `<h1>Create account</h1><form><label>Email <input type="email" required></label>
         <iframe title="reCAPTCHA challenge" src="https://www.google.com/recaptcha/api2/anchor"></iframe>
         <button type="submit">Register</button></form>`,
      );
      const scan = await scanAndFillPage(page, person);
      assert.equal(scan.humanHandoff?.category, "CAPTCHA");
      await page.close();
    });

    await context.test("an OTP / verification-code field blocks auto-submit", async () => {
      const page = await browser.newPage();
      await page.setContent(
        `<h1>Verify it's you</h1><form><label>Enter the one time code we sent you
         <input name="otp" autocomplete="one-time-code" required></label>
         <button type="submit">Verify</button></form>`,
      );
      const scan = await scanAndFillPage(page, person);
      assert.ok(["SMS_VERIFICATION", "EMAIL_VERIFICATION", "REQUIRED_MANUAL_FIELD"].includes(scan.humanHandoff?.category ?? ""));
      await page.close();
    });

    await context.test("a payment-card field blocks auto-submit", async () => {
      const page = await browser.newPage();
      await page.setContent(
        `<h1>Create account</h1><form><label>Email <input type="email" required></label>
         <label>Card number <input name="cc-number" autocomplete="cc-number" required></label>
         <button type="submit">Register</button></form>`,
      );
      const scan = await scanAndFillPage(page, person);
      assert.equal(scan.humanHandoff?.category, "REQUIRED_MANUAL_FIELD");
      await page.close();
    });

    await context.test("ambiguous consent language keeps the submit control out of auto-submit", async () => {
      const page = await browser.newPage();
      await page.setContent(
        `<h1>Create your account</h1><form>
           <label>Email <input type="email" name="email" value="dana.okafor@example.invalid" required></label>
           <p>By clicking Create account you agree to the terms and consent to arbitration.</p>
           <button type="submit">Create account</button>
         </form>`,
      );
      const scan = await scanAndFillPage(page, person);
      assert.notEqual(scan.action?.kind, "final");
      await page.close();
    });

    await context.test("a required legal-certification checkbox blocks auto-submit", async () => {
      const page = await browser.newPage();
      await page.setContent(
        `<h1>Create account</h1><form>
           <label>Email <input type="email" required></label>
           <label><input type="checkbox" required> I certify under penalty of perjury that the information is accurate.</label>
           <button type="submit">Register</button>
         </form>`,
      );
      const scan = await scanAndFillPage(page, person);
      assert.equal(scan.humanHandoff?.category, "HUMAN_CONSENT");
      await page.close();
    });
  } finally {
    await browser.close();
  }
});
