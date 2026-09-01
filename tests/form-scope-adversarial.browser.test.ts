import assert from "node:assert/strict";
import test from "node:test";
import { launchCompatibleBrowser } from "../src/browser/browser-launch.js";
import { scanAndFillPage } from "../src/forms/form-handler.js";
import type { PersonProfile } from "../src/types/models.js";

const person: PersonProfile = {
  rowNumber: 2, id: "P0001", firstName: "Dana", lastName: "Okafor", phone: "5555550100",
  email: "dana.okafor@example.invalid", address: "1 Way", city: "Town", state: "FL", zip: "32606",
  dob: "01/02/1990", occupation: "Eng", annualIncome: "85000", password: "[REDACTED_TEST_PASSWORD]",
  dynamicFields: {}, status: "PENDING", currentSiteId: "", lastUpdated: "",
};

// TEST G — only a genuine, form-scoped registration may auto-submit.
test("G: newsletter / contact / login / generic-submit / payment forms never become a final auto-submit", async (context) => {
  let browser;
  try {
    browser = (await launchCompatibleBrowser("chrome")).browser;
  } catch {
    return context.skip("No compatible Chrome/Chromium");
  }

  const notFinal = async (name: string, html: string): Promise<void> => {
    await context.test(name, async () => {
      const page = await browser.newPage();
      await page.setContent(html);
      const scan = await scanAndFillPage(page, person);
      assert.notEqual(scan.action?.kind, "final", `${name}: must not be a final auto-submit`);
      await page.close();
    });
  };

  try {
    await notFinal(
      "newsletter",
      `<h1>Sign up for our newsletter and never miss a deal</h1>
       <form><label>Email <input type="email" name="email"></label><button>Subscribe</button></form>`,
    );
    await notFinal(
      "contact form",
      `<h1>Contact us</h1><form>
        <label>Name <input name="name"></label>
        <label>Email <input type="email" name="email"></label>
        <label>Message <textarea name="message"></textarea></label>
        <button>Send</button></form>`,
    );
    await notFinal(
      "login",
      `<h1>Sign in to your account</h1><form>
        <label>Email <input type="email" name="email"></label>
        <label>Password <input type="password" name="password"></label>
        <button>Log in</button></form>`,
    );
    await notFinal(
      "generic Submit with registration words only elsewhere on the page",
      `<header><a href="/register">Create an account</a></header>
       <h1>Join our mailing list</h1>
       <form><label>Email <input type="email" name="email"></label><button>Submit</button></form>`,
    );
    await notFinal(
      "payment-adjacent form",
      `<h1>Create your account</h1>
       <form>
         <label>Email <input type="email" name="email" value="dana.okafor@example.invalid"></label>
         <label>Name <input name="first_name" value="Dana"></label>
         <button>Sign Up</button>
       </form>
       <iframe src="https://js.stripe.com/v3/" title="Secure payment input frame"></iframe>`,
    );

    await context.test("a genuine registration form DOES auto-submit", async () => {
      const page = await browser.newPage();
      await page.setContent(
        `<h1>Create your account</h1>
         <form>
           <p>Create an account to get started.</p>
           <label>Email <input type="email" name="email" value="dana.okafor@example.invalid" required></label>
           <label>First name <input name="first_name" value="Dana" required></label>
           <label>Last name <input name="last_name" value="Okafor" required></label>
           <button>Sign Up</button>
         </form>`,
      );
      const scan = await scanAndFillPage(page, person);
      assert.equal(scan.action?.kind, "final");
      await page.close();
    });
  } finally {
    await browser.close();
  }
});
