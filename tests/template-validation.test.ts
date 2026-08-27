import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { validateCleanTemplate } from "../src/cli/validate-template.js";
import { WorkbookStore } from "../src/excel/workbook-store.js";
import { createFixtureWorkbook, PEOPLE_HEADERS } from "./helpers/workbook-fixture.js";

test("clean template validator enforces exact sheets and v1.1 People columns", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mag-template-validation-"));
  try {
    const valid = path.join(root, "valid.xlsx");
    await createFixtureWorkbook(valid);
    await validateCleanTemplate(valid);
    const invalid = path.join(root, "invalid.xlsx");
    await createFixtureWorkbook(invalid, { peopleHeaders: PEOPLE_HEADERS.filter((header) => header !== "PASSWORD") });
    await assert.rejects(validateCleanTemplate(invalid), /People headers must be exactly/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tracked clean template opens without materializing preformatted blank rows", async () => {
  const template = path.join(process.cwd(), "templates", "MAG_Signup_Automation_Clean_Template.xlsx");
  const store = new WorkbookStore(template);
  try {
    await store.open();
    assert.equal(store.getPeople().length, 0);
    assert.equal(store.getSites().length, 0);
    assert.equal(store.getAttempts().length, 0);
  } finally {
    await store.release();
  }
});
