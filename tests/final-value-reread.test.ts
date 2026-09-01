import assert from "node:assert/strict";
import test from "node:test";
import { launchCompatibleBrowser } from "../src/browser/browser-launch.js";
import { revalidateFinalSubmit } from "../src/forms/form-handler.js";
import type { PersonProfile } from "../src/types/models.js";

const person: PersonProfile = {
  rowNumber: 2, id: "P0001", firstName: "Dana", lastName: "Okafor", phone: "5555550100",
  email: "dana.okafor@example.invalid", address: "1 Way", city: "Town", state: "FL", zip: "32606",
  dob: "01/02/1990", occupation: "Eng", annualIncome: "85000", password: "[REDACTED_TEST_PASSWORD]",
  dynamicFields: {}, status: "PENDING", currentSiteId: "", lastUpdated: "",
};

// TEST F — the final-submit boundary re-reads live form state; it never trusts the
// earlier scan's approved values.
test("F: revalidateFinalSubmit blocks on values mutated after the scan", async (context) => {
  let browser;
  try {
    browser = (await launchCompatibleBrowser("chrome")).browser;
  } catch {
    return context.skip("No compatible Chrome/Chromium");
  }
  try {
    const okForm = `<h1>Create your account</h1><form>
      <label>Email <input type="email" id="email" name="email" value="dana.okafor@example.invalid" required></label>
      <label>First name <input id="first" name="first_name" value="Dana" required></label>
      <label>Last name <input name="last_name" value="Okafor" required></label>
      <label><input type="checkbox" id="tos"> I agree</label>
      <button type="submit">Sign Up</button></form>`;

    await context.test("clean form passes", async () => {
      const page = await browser.newPage();
      await page.setContent(okForm);
      assert.deepEqual(await revalidateFinalSubmit(page, person), { ok: true });
      await page.close();
    });

    await context.test("email changed to another person -> blocked", async () => {
      const page = await browser.newPage();
      await page.setContent(okForm);
      await page.fill("#email", "stranger@evil.invalid");
      const r = await revalidateFinalSubmit(page, person);
      assert.equal(r.ok, false);
      assert.match(r.reason ?? "", /email/i);
      await page.close();
    });

    await context.test("required field cleared -> blocked", async () => {
      const page = await browser.newPage();
      await page.setContent(okForm);
      await page.fill("#first", "");
      const r = await revalidateFinalSubmit(page, person);
      assert.equal(r.ok, false);
      await page.close();
    });

    await context.test("a payment iframe appearing -> blocked", async () => {
      const page = await browser.newPage();
      await page.setContent(okForm);
      await page.evaluate(() => {
        const f = document.createElement("iframe");
        f.src = "https://js.stripe.com/v3/elements-inner-card.html";
        f.title = "Secure card number input frame";
        document.body.appendChild(f);
      });
      const r = await revalidateFinalSubmit(page, person);
      assert.equal(r.ok, false);
      assert.match(r.reason ?? "", /payment|card/i);
      await page.close();
    });
  } finally {
    await browser.close();
  }
});
