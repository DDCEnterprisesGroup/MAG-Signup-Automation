import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scripts = ["src/shared/constants.js", "src/core/normalize.js", "src/shared/dynamic-registry.js", "src/adapters/site-adapters.js",
  "src/core/field-detector.js", "src/core/field-classifier.js", "src/core/profile-mapper.js", "src/core/autofill-engine.js"];
// The production registry definition for DOB (SENSITIVE, VAULT, never cached).
const DOB_DEFINITION = { canonical_key: "date_of_birth", semantic_type: "DATE_OF_BIRTH", display_name: "Date of birth", aliases: ["DOB", "Date of Birth", "Birth date", "Birthday"], data_type: "DATE", security_class: "SENSITIVE", cache_policy: "NONE", autofill_policy: "REVIEW_REQUIRED", review_requirement: "ADMIN_REQUIRED", active: true };
const PROFILE = { id: "supabase:test", label: "Test", person: { fullName: "Rico Test", phone: "(402) 487-6702" } };

async function withPage(run) {
  const server = createServer(async (request, response) => {
    try { response.setHeader("content-type", "text/html"); response.end(await readFile(path.join(root, "fixtures", "dob-phone.html"))); }
    catch { response.statusCode = 404; response.end(); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ channel: "chromium", headless: true });
  const page = await browser.newPage();
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}/dob-phone.html`);
    await page.evaluate(() => { window.__submits = 0; document.querySelector("form").addEventListener("submit", (event) => { window.__submits += 1; event.preventDefault(); }); });
    for (const script of scripts) await page.addScriptTag({ path: path.join(root, script) });
    await page.evaluate((definition) => MAG.DynamicRegistry.setDefinitions([definition]), DOB_DEFINITION);
    await run(page);
    assert.equal(await page.evaluate(() => window.__submits), 0, "never submits");
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}
const autofill = (page, authorizedValues = {}) => page.evaluate(([profile, values]) => MAG.AutofillEngine.autofill(profile, MAG.DEFAULT_SETTINGS, values), [PROFILE, authorizedValues]);
const item = (summary, name) => summary.items.find((entry) => entry.fieldId === summary.byName[name]);
async function summaryWithNames(page, summary) {
  const byName = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll("input")].map((input) => [input.name, input.dataset.magFieldId])));
  return { ...summary, byName };
}

test("T1/T2 DOB fills on explicit Autofill in the format each field expects", async () => {
  await withPage(async (page) => {
    const analyzed = await summaryWithNames(page, await page.evaluate((profile) => MAG.AutofillEngine.analyze(profile, MAG.DEFAULT_SETTINGS), PROFILE));
    assert.equal(await page.locator('[name="dob_text"]').inputValue(), "", "Analyze alone never fills DOB");
    assert.match(item(analyzed, "dob_text").reason, /Human-controlled/);
    const result = await summaryWithNames(page, await autofill(page, { date_of_birth: "1985-03-07" }));
    assert.equal(await page.locator('[name="dob_text"]').inputValue(), "03/07/1985", "T1 text field gets MM/DD/YYYY");
    assert.equal(await page.locator('[name="dob_native"]').inputValue(), "1985-03-07", "T2 native date gets YYYY-MM-DD");
    assert.equal(item(result, "dob_text").value, "", "protected value never echoed back in the summary");
  });
});

test("T1 DOB stored as MM/DD/YYYY is normalized for both field types", async () => {
  await withPage(async (page) => {
    await autofill(page, { date_of_birth: "3/7/1985" });
    assert.equal(await page.locator('[name="dob_text"]').inputValue(), "03/07/1985");
    assert.equal(await page.locator('[name="dob_native"]').inputValue(), "1985-03-07");
  });
});

test("T4 an unreadable stored DOB is never filled and is left for review", async () => {
  for (const bad of ["13/45/1985", "02/30/1990", "1985-3", "not a date", "01/01/2999"]) {
    await withPage(async (page) => {
      const result = await summaryWithNames(page, await autofill(page, { date_of_birth: bad }));
      assert.equal(await page.locator('[name="dob_text"]').inputValue(), "", `${bad} not filled`);
      assert.equal(await page.locator('[name="dob_native"]').inputValue(), "", `${bad} not filled (native)`);
      assert.equal(item(result, "dob_text").status, "REVIEW");
      assert.match(item(result, "dob_text").reason, /could not be read safely/);
    });
  }
});

test("T5/T6/T7 existing phone values: equivalent ones count as filled, different ones are preserved", async () => {
  await withPage(async (page) => {
    const result = await summaryWithNames(page, await autofill(page));
    assert.equal(item(result, "phone_digits").status, "FILLED", "T5 4024876702 equals (402) 487-6702");
    assert.equal(item(result, "phone_country").status, "FILLED", "T6 +1 402 487 6702 equals (402) 487-6702");
    assert.doesNotMatch(item(result, "phone_digits").reason, /Manually edited|preserved/);
    assert.equal(await page.locator('[name="phone_digits"]').inputValue(), "4024876702", "equivalent value not reformatted");
    assert.equal(await page.locator('[name="phone_country"]').inputValue(), "+1 402 487 6702");
    assert.equal(item(result, "phone_other").status, "REVIEW", "T7 a different number keeps review");
    assert.match(item(result, "phone_other").reason, /preserved for human review/);
    assert.equal(await page.locator('[name="phone_other"]').inputValue(), "(305) 555-0100", "T7 page value preserved");
    assert.equal(await page.locator('[name="phone_empty"]').inputValue(), "(402) 487-6702", "empty field is filled");
  });
});

test("T5/T7 retyping the same phone is not a manual edit; typing a different one is", async () => {
  await withPage(async (page) => {
    await autofill(page);
    const status = (name) => page.evaluate((field) => { const input = document.querySelector(`[name="${field}"]`); return { status: input.dataset.magStatus }; }, name);
    await page.locator('[name="phone_empty"]').fill("402.487.6702");
    assert.equal((await status("phone_empty")).status, "FILLED", "equivalent retype stays satisfied");
    await page.locator('[name="phone_empty"]').fill("(305) 555-0100");
    assert.equal((await status("phone_empty")).status, "REVIEW", "a different number is a manual edit");
    assert.equal(await page.locator('[name="phone_empty"]').inputValue(), "(305) 555-0100", "manual value kept");
  });
});

test("phone equivalence is strict: no substring or loose international matching", async () => {
  await withPage(async (page) => {
    const eq = (a, b) => page.evaluate(([x, y]) => MAG.Normalize.equivalentValue("PHONE", x, y), [a, b]);
    assert.equal(await eq("402-487-6702", "(402) 487-6702"), true);
    assert.equal(await eq("402 487 6702", "(402) 487-6702"), true);
    assert.equal(await eq("487-6702", "(402) 487-6702"), false, "no partial/substring match");
    assert.equal(await eq("+44 402 487 6702", "(402) 487-6702"), false, "other country codes are not stripped");
    assert.equal(await eq("24024876702", "(402) 487-6702"), false, "only a leading 1 is a country code");
    assert.equal(await eq("", "(402) 487-6702"), false);
  });
});
