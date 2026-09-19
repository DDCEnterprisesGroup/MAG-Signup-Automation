import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scripts = [
  "src/shared/constants.js", "src/data/initial-profiles.js", "src/core/normalize.js",
  "src/shared/dynamic-registry.js",
  "src/adapters/site-adapters.js", "src/core/field-detector.js", "src/core/field-classifier.js",
  "src/core/profile-mapper.js", "src/core/autofill-engine.js"
];

async function startServer() {
  const server = createServer(async (request, response) => {
    try {
      const requestPath = new URL(request.url || "/", "http://127.0.0.1").pathname;
      const name = path.basename(requestPath === "/" ? "/index.html" : requestPath);
      if (!/^[a-z0-9-]+\.(?:html|css)$/i.test(name)) throw new Error("not found");
      const body = await readFile(path.join(root, "fixtures", name));
      response.setHeader("content-type", name.endsWith(".css") ? "text/css" : "text/html; charset=utf-8");
      response.end(body);
    } catch {
      response.statusCode = 404;
      response.end("not found");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return { server, baseUrl: `http://127.0.0.1:${address.port}/mag-fixtures` };
}

async function load(page, baseUrl, fixture) {
  await page.goto(`${baseUrl}/${fixture}`);
  await page.evaluate(() => {
    window.__magSubmitCount = 0;
    document.querySelector("form")?.addEventListener("submit", (event) => {
      window.__magSubmitCount += 1;
      event.preventDefault();
    });
  });
  for (const script of scripts) await page.addScriptTag({ path: path.join(root, script) });
}

test("browser fixtures exercise detection, mapping, review, reset, switching, and no-submit", async (context) => {
  let browser;
  try { browser = await chromium.launch({ channel: "chrome", headless: true }); }
  catch {
    try { browser = await chromium.launch({ headless: true }); }
    catch { context.skip("No compatible Chrome or Playwright Chromium browser is available"); return; }
  }
  const { server, baseUrl } = await startServer();
  const page = await browser.newPage();
  try {
    await context.test("event form fills approved high-confidence fields and never submits", async () => {
      await load(page, baseUrl, "event-calendar.html");
      const result = await page.evaluate(() => {
        const profile = MAG.INITIAL_PROFILES.find((item) => item.id === "christmas-at-the-magical-midway-2026");
        return MAG.AutofillEngine.autofill(profile, MAG.DEFAULT_SETTINGS);
      });
      assert.equal(await page.locator('[name="event_title"]').inputValue(), "Christmas At The Magical Midway");
      assert.equal(await page.locator('[name="event_date"]').inputValue(), "2026-12-12");
      assert.equal(await page.locator('[name="start_time"]').inputValue(), "12:00");
      assert.equal(await page.locator('[name="state"]').inputValue(), "FL");
      assert.ok(result.filled >= 7);
      assert.equal(await page.evaluate(() => window.__magSubmitCount), 0);
      assert.equal(new URL(page.url()).hash, "");
    });

    await context.test("maxlength chooses an approved variant and refuses unsafe truncation", async () => {
      await load(page, baseUrl, "character-limits.html");
      const result = await page.evaluate(() => {
        const profile = MAG.INITIAL_PROFILES.find((item) => item.id === "christmas-at-the-magical-midway-2026");
        return MAG.AutofillEngine.autofill(profile, MAG.DEFAULT_SETTINGS);
      });
      const fit = await page.locator("#fits-short").inputValue();
      assert.ok(fit.length <= 150 && fit.endsWith("Florida."));
      assert.equal(await page.locator("#too-short").inputValue(), "");
      assert.equal(result.items.find((item) => item.label.includes("40 characters")).status, "REVIEW");
      assert.match(result.items.find((item) => item.label.includes("40 characters")).reason, /exceeds/);
      assert.equal(await page.evaluate(() => window.__magSubmitCount), 0);
    });

    await context.test("consent, certification, radio, and signature controls remain human-controlled", async () => {
      await load(page, baseUrl, "consent.html");
      const result = await page.evaluate(() => {
        const profile = MAG.INITIAL_PROFILES.find((item) => item.id === "altaire-financial-group");
        return MAG.AutofillEngine.autofill(profile, MAG.DEFAULT_SETTINGS);
      });
      assert.equal(await page.locator("#certify").isChecked(), false);
      assert.equal(await page.locator("#terms").isChecked(), false);
      assert.equal(await page.locator("#choice-a").isChecked(), false);
      assert.equal(await page.locator("#signature").inputValue(), "");
      assert.equal(await page.locator("#captcha").inputValue(), "");
      assert.ok(result.items.filter((item) => item.reason.startsWith("Human-controlled")).length >= 5);
      assert.equal(await page.evaluate(() => window.__magSubmitCount), 0);
    });

    await context.test("unknown required values remain missing while safe contenteditable fields work", async () => {
      await load(page, baseUrl, "unknown.html");
      const result = await page.evaluate(() => {
        const profile = MAG.INITIAL_PROFILES.find((item) => item.id === "magical-dream-builders");
        return MAG.AutofillEngine.autofill(profile, MAG.DEFAULT_SETTINGS);
      });
      assert.equal(await page.locator('[name="orbital_preference"]').inputValue(), "");
      assert.equal(await page.locator('[name="access_code"]').inputValue(), "");
      assert.equal(await page.locator('[contenteditable="true"]').textContent(), "Magical Dream Builders is a nonprofit organization that presents the annual Operation Winter Wonderland community event.");
      assert.ok(result.missing >= 1);
      assert.equal(await page.evaluate(() => window.__magSubmitCount), 0);
    });

    await context.test("restricted fields remain blank while the AAL2 acceptance gate is closed", async () => {
      await load(page, baseUrl, "restricted.html");
      const analyzed = await page.evaluate(() => {
        MAG.DynamicRegistry.setDefinitions([{ canonical_key: "ssn", semantic_type: "SOCIAL_SECURITY_NUMBER", display_name: "Social Security Number", aliases: ["SSN"], security_class: "RESTRICTED", cache_policy: "NONE", autofill_policy: "EXPLICIT_UNLOCK", active: true }]);
        return MAG.AutofillEngine.autofill({ id: "supabase:test", label: "Restricted test", dynamicFields: {}, sync: { source: "SUPABASE", remoteId: "test" } }, MAG.DEFAULT_SETTINGS);
      });
      const item = analyzed.items.find((candidate) => candidate.canonicalKey === "ssn");
      assert.equal(await page.locator("#ssn").inputValue(), "");
      assert.equal(item.restricted, true);
      await page.evaluate(({ fieldId }) => MAG.AutofillEngine.fillRestricted(fieldId, "restricted-probe-value"), { fieldId: item.fieldId });
      assert.equal(await page.locator("#ssn").inputValue(), "");
      assert.equal(await page.evaluate(() => window.__magSubmitCount), 0);
    });

    await context.test("contact, nonprofit, press/media, and ambiguous fixtures fail closed", async () => {
      await load(page, baseUrl, "nonprofit-submission.html");
      let result = await page.evaluate(() => {
        const profile = MAG.INITIAL_PROFILES.find((item) => item.id === "magical-dream-builders");
        return MAG.AutofillEngine.autofill(profile, MAG.DEFAULT_SETTINGS);
      });
      assert.equal(await page.locator('[name="nonprofit_name"]').inputValue(), "Magical Dream Builders");
      assert.equal(await page.locator('[name="mission"]').inputValue(), "");
      assert.ok(result.missing >= 1);
      assert.equal(await page.evaluate(() => window.__magSubmitCount), 0);

      await load(page, baseUrl, "press-media.html");
      result = await page.evaluate(() => {
        const profile = MAG.INITIAL_PROFILES.find((item) => item.id === "dandre-d-combs-jr");
        return MAG.AutofillEngine.autofill(profile, MAG.DEFAULT_SETTINGS);
      });
      assert.equal(await page.locator('[name="submitter_name"]').inputValue(), "D’Andre D. Combs Jr.");
      assert.equal(await page.locator('[name="contact_email"]').inputValue(), "");
      assert.equal(await page.locator('[name="attachment"]').inputValue(), "");
      assert.ok(result.missing >= 2);
      assert.equal(await page.evaluate(() => window.__magSubmitCount), 0);

      await load(page, baseUrl, "ambiguous.html");
      result = await page.evaluate(() => {
        const profile = MAG.INITIAL_PROFILES.find((item) => item.id === "christmas-at-the-magical-midway-2026");
        return MAG.AutofillEngine.autofill(profile, MAG.DEFAULT_SETTINGS);
      });
      assert.equal(await page.locator('[name="description"]').inputValue(), "");
      assert.equal(await page.locator('[name="url"]').inputValue(), "");
      assert.ok(result.missing >= 1);
      assert.equal(await page.evaluate(() => window.__magSubmitCount), 0);
    });

    await context.test("reset is reversible, profile switching clears MAG values, and manual edits remain editable", async () => {
      await load(page, baseUrl, "simple-contact.html");
      await page.evaluate(() => {
        const profile = MAG.INITIAL_PROFILES.find((item) => item.id === "altaire-financial-group");
        MAG.AutofillEngine.autofill(profile, MAG.DEFAULT_SETTINGS);
      });
      assert.equal(await page.locator('[name="email"]').inputValue(), "dandre.combs@altairefinancial.com");
      await page.locator('[name="organization"]').fill("Manual correction");
      assert.equal(await page.locator('[name="organization"]').inputValue(), "Manual correction");
      await page.evaluate(() => MAG.AutofillEngine.reset());
      assert.equal(await page.locator('[name="email"]').inputValue(), "");
      assert.equal(await page.locator('[name="organization"]').inputValue(), "Manual correction");
      await page.locator('[name="organization"]').fill("");
      await page.evaluate(() => {
        const profile = MAG.INITIAL_PROFILES.find((item) => item.id === "altaire-financial-group");
        MAG.AutofillEngine.autofill(profile, MAG.DEFAULT_SETTINGS);
      });
      await page.evaluate(() => {
        const profile = MAG.INITIAL_PROFILES.find((item) => item.id === "christmas-at-the-magical-midway-2026");
        MAG.AutofillEngine.autofill(profile, MAG.DEFAULT_SETTINGS);
      });
      assert.equal(await page.locator('[name="organization"]').inputValue(), "Magical Dream Builders");
      assert.equal(await page.locator('[name="email"]').inputValue(), "");
      assert.equal(await page.evaluate(() => window.__magSubmitCount), 0);
    });
  } finally {
    await page.close();
    await browser.close();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
