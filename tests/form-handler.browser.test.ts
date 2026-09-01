import assert from "node:assert/strict";
import test from "node:test";
import { launchCompatibleBrowser } from "../src/browser/browser-launch.js";
import { scanAndFillPage } from "../src/forms/form-handler.js";
import type { PersonProfile } from "../src/types/models.js";

const person: PersonProfile = {
  rowNumber: 2,
  id: "PTEST",
  firstName: "TestFirst",
  lastName: "TestLast",
  phone: "5555550100",
  email: "test@example.invalid",
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

test("form mapping, password policy, DOB interfaces, consent, and auto-submit gates", async (context) => {
  let browser;
  try {
    browser = (await launchCompatibleBrowser("chrome")).browser;
  } catch {
    context.skip("No compatible Chrome or Playwright Chromium browser is available");
    return;
  }
  try {
    await context.test("fills approved fields and recognizes a safe next action", async () => {
      const page = await browser.newPage();
      await page.setContent('<h1>Create account</h1><form><label>First Name <input name="first_name" required></label><label>Last Name <input autocomplete="family-name" required></label><button type="submit">Next</button></form>');
      const scan = await scanAndFillPage(page, person);
      assert.deepEqual(new Set(scan.filledFields), new Set(["firstName", "lastName"]));
      assert.equal(scan.action?.kind, "next");
      await page.close();
    });

    await context.test("registration password and confirmation use the approved workbook value", async () => {
      const page = await browser.newPage();
      await page.setContent('<h1>Create Account</h1><form><label>Create Password <input id="password" type="password" autocomplete="new-password" required></label><label>Confirm Password <input id="confirm" type="password" required></label><button type="submit">Create Account</button></form>');
      const scan = await scanAndFillPage(page, person);
      assert.equal(scan.accountFlow, "registration");
      assert.equal(await page.locator("#password").inputValue(), person.password);
      assert.equal(await page.locator("#confirm").inputValue(), person.password);
      assert.deepEqual(scan.filledFields, ["password", "password"]);
      assert.equal(scan.action?.kind, "final");
      await page.close();
    });

    await context.test("password is not entered on a login page", async () => {
      const page = await browser.newPage();
      await page.setContent('<h1>Sign in</h1><form><label>Email <input type="email" required></label><label>Password <input id="login-password" type="password" autocomplete="current-password" required></label><button type="submit">Log in</button></form>');
      const scan = await scanAndFillPage(page, person);
      assert.equal(scan.accountFlow, "login");
      assert.equal(scan.humanHandoff?.category, "REQUIRED_MANUAL_FIELD");
      assert.equal(await page.locator("#login-password").inputValue(), "");
      await page.close();
    });

    await context.test("fills DOB text and date inputs with normalized formats", async () => {
      const page = await browser.newPage();
      await page.setContent('<h1>Register</h1><form><label>Date of Birth <input id="dob-text" placeholder="MM/DD/YYYY"></label><label>Birthdate <input id="dob-date" type="date"></label><button type="submit">Next</button></form>');
      const scan = await scanAndFillPage(page, person);
      assert.equal(await page.locator("#dob-text").inputValue(), "01/02/1990");
      assert.equal(await page.locator("#dob-date").inputValue(), "1990-01-02");
      assert.equal(scan.action?.kind, "next");
      await page.close();
    });

    await context.test("fills separate DOB month day and year selectors", async () => {
      const page = await browser.newPage();
      await page.setContent('<h1>Register</h1><form><fieldset><legend>Date of Birth</legend><label>Month <select id="month"><option></option><option value="1">January</option></select></label><label>Day <select id="day"><option></option><option value="2">2</option></select></label><label>Year <select id="year"><option></option><option value="1990">1990</option></select></label></fieldset><button type="submit">Next</button></form>');
      const scan = await scanAndFillPage(page, person);
      assert.equal(await page.locator("#month").inputValue(), "1");
      assert.equal(await page.locator("#day").inputValue(), "2");
      assert.equal(await page.locator("#year").inputValue(), "1990");
      assert.deepEqual(scan.filledFields, ["dobMonth", "dobDay", "dobYear"]);
      await page.close();
    });

    await context.test("fills occupation and annual income but never monthly income", async () => {
      const page = await browser.newPage();
      await page.setContent('<h1>Sign Up</h1><form><label>Current Occupation <input id="occupation"></label><label>Gross Annual Income <input id="annual"></label><label>Monthly Income <input id="monthly" required></label><button type="submit">Register</button></form>');
      const scan = await scanAndFillPage(page, person);
      assert.equal(await page.locator("#occupation").inputValue(), "Engineer");
      assert.equal(await page.locator("#annual").inputValue(), "85000");
      assert.equal(await page.locator("#monthly").inputValue(), "");
      assert.equal(scan.humanHandoff?.category, "REQUIRED_MANUAL_FIELD");
      await page.close();
    });

    await context.test("safe fields are filled before an SSN handoff even with conflicting attributes", async () => {
      const page = await browser.newPage();
      await page.setContent('<h1>Register</h1><form><label>Mobile Phone <input id="safe-phone" type="tel" required></label><label>Social Security Number <input id="ssn" type="tel" name="phone" autocomplete="tel" required></label><button type="submit">Next</button></form>');
      const scan = await scanAndFillPage(page, person);
      assert.equal(scan.humanHandoff?.category, "REQUIRED_MANUAL_FIELD");
      assert.match(scan.humanHandoff?.reason ?? "", /Social Security/);
      assert.equal(await page.locator("#ssn").inputValue(), "");
      assert.equal(await page.locator("#safe-phone").inputValue(), person.phone);
      assert.deepEqual(scan.filledFields, ["phone"]);
      assert.equal(scan.action, undefined);
      await page.close();
    });

    await context.test("SSN before visible safe fields still allows every safe field to fill before handoff", async () => {
      const page = await browser.newPage();
      await page.setContent('<h1>Register</h1><form><label>SSN <input id="ssn" required></label><label>First Name <input id="first" name="first_name" required></label><label>Email <input id="email" type="email" required></label><button type="submit">Next</button></form>');
      const scan = await scanAndFillPage(page, person);
      assert.equal(await page.locator("#ssn").inputValue(), "");
      assert.equal(await page.locator("#first").inputValue(), person.firstName);
      assert.equal(await page.locator("#email").inputValue(), person.email);
      assert.deepEqual(new Set(scan.filledFields), new Set(["firstName", "email"]));
      assert.match(scan.humanHandoff?.reason ?? "", /Social Security/);
      await page.close();
    });

    await context.test("operator-entered SSN releases the handoff and the next page is rescanned and filled", async () => {
      const page = await browser.newPage();
      await page.setContent('<h1>Register</h1><form><label>SSN <input id="ssn" required></label><button type="submit">Next</button></form>');
      const blocked = await scanAndFillPage(page, person);
      assert.match(blocked.humanHandoff?.reason ?? "", /Social Security/);

      await page.locator("#ssn").fill("operator-entered-value");
      const resumed = await scanAndFillPage(page, person);
      assert.equal(resumed.humanHandoff, undefined);
      assert.equal(resumed.action?.kind, "next");

      await page.setContent('<h1>Register - Contact</h1><form><label>First Name <input id="first" name="first_name" required></label><label>Email <input id="email" type="email" required></label><button type="submit">Next</button></form>');
      const nextPage = await scanAndFillPage(page, person);
      assert.equal(await page.locator("#first").inputValue(), person.firstName);
      assert.equal(await page.locator("#email").inputValue(), person.email);
      assert.deepEqual(new Set(nextPage.filledFields), new Set(["firstName", "email"]));
      await page.close();
    });

    await context.test("multiple restricted fields remain untouched while safe fields around them fill", async () => {
      const page = await browser.newPage();
      await page.setContent('<h1>Register</h1><form><label>SSN <input id="ssn" required></label><label>First Name <input id="first" name="first_name" required></label><label>Passport Number <input id="passport" required></label><label>Phone <input id="phone" type="tel" required></label><button type="submit">Next</button></form>');
      const scan = await scanAndFillPage(page, person);
      assert.equal(await page.locator("#ssn").inputValue(), "");
      assert.equal(await page.locator("#passport").inputValue(), "");
      assert.equal(await page.locator("#first").inputValue(), person.firstName);
      assert.equal(await page.locator("#phone").inputValue(), person.phone);
      assert.deepEqual(new Set(scan.filledFields), new Set(["firstName", "phone"]));
      assert.match(scan.humanHandoff?.reason ?? "", /Social Security/);
      assert.match(scan.humanHandoff?.reason ?? "", /government identity/);
      await page.close();
    });

    await context.test("manual edits during restricted handoff are revalidated and rescan never submits", async () => {
      const page = await browser.newPage();
      let submitCount = 0;
      await page.setContent('<h1>Create Account</h1><form id="form"><label>Email <input id="email" type="email" required></label><label>SSN <input id="ssn" required></label><button type="submit">Create Account</button></form>');
      await page.locator("#form").evaluate((form) => form.addEventListener("submit", (event) => event.preventDefault()));
      page.on("console", () => undefined);
      await page.exposeFunction("recordSubmit", () => { submitCount += 1; });
      await page.locator("#form").evaluate((form) => form.addEventListener("submit", () => void (window as unknown as { recordSubmit: () => void }).recordSubmit()));

      const blocked = await scanAndFillPage(page, person);
      assert.equal(await page.locator("#email").inputValue(), person.email);
      assert.match(blocked.humanHandoff?.reason ?? "", /Social Security/);
      assert.equal(submitCount, 0);

      await page.locator("#email").fill("different.person@example.invalid");
      await page.locator("#ssn").fill("operator-entered-value");
      const rescanned = await scanAndFillPage(page, person);
      assert.match(rescanned.humanHandoff?.reason ?? "", /does not match the active client/);
      assert.equal(rescanned.action, undefined);
      assert.equal(submitCount, 0);
      await page.close();
    });

    await context.test("generic numeric is not phone while Mobile Phone is filled", async () => {
      const page = await browser.newPage();
      await page.setContent('<h1>Register</h1><form><label>Member Number <input id="generic-number" type="number" maxlength="10"></label><label>Mobile Phone <input id="mobile-phone" type="tel" required></label><button type="submit">Next</button></form>');
      const scan = await scanAndFillPage(page, person);
      assert.equal(await page.locator("#generic-number").inputValue(), "");
      assert.equal(await page.locator("#mobile-phone").inputValue(), person.phone);
      assert.deepEqual(scan.filledFields, ["phone"]);
      await page.close();
    });

    await context.test("complete safe registration exposes final auto-submit action and leaves optional marketing unchecked", async () => {
      const page = await browser.newPage();
      await page.setContent('<h1>Create account</h1><form><label>Email <input type="email" required></label><label><input id="marketing" type="checkbox"> Send me marketing emails</label><button type="submit">Finish</button></form>');
      const scan = await scanAndFillPage(page, person);
      assert.equal(scan.action?.kind, "final");
      assert.equal(await page.locator("#marketing").isChecked(), false);
      await page.close();
    });

    await context.test("unsafe or ambiguous states prevent final auto-submit", async () => {
      const cases = [
        { html: '<h1>Register</h1><form><label>Employer <input required></label><button>Register</button></form>', category: "REQUIRED_MANUAL_FIELD" },
        { html: '<h1>Register</h1><p>Verify you are human CAPTCHA</p><form><label>Email <input type="email"></label><button>Register</button></form>', category: "CAPTCHA" },
        { html: '<h1>Register</h1><form><div role="alert">Invalid email, try again</div><label>Email <input type="email"></label><button>Register</button></form>', category: "REQUIRED_MANUAL_FIELD" },
        { html: '<h1>Register</h1><form><label>Passport Number <input required></label><button>Register</button></form>', category: "REQUIRED_MANUAL_FIELD" },
        { html: '<h1>Register</h1><form><label>Email <input type="email"></label><p>By clicking Sign Up, I agree to the terms.</p><button>Sign Up</button></form>', action: "ambiguous" },
      ] as const;
      for (const item of cases) {
        const page = await browser.newPage();
        await page.setContent(item.html);
        const scan = await scanAndFillPage(page, person);
        assert.equal(scan.humanHandoff?.category, "category" in item ? item.category : undefined);
        assert.equal(scan.action?.kind, "action" in item ? item.action : undefined);
        assert.notEqual(scan.action?.kind, "final");
        await page.close();
      }
    });
  } finally {
    await browser.close();
  }
});
