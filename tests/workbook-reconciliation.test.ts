import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WorkbookStore } from "../src/excel/workbook-store.js";
import { loadFieldRegistry } from "../src/fields/field-registry.js";
import { createFixtureWorkbook, PEOPLE_HEADERS } from "./helpers/workbook-fixture.js";

test("reconciles new people, sites, defaults, duplicates, and workbook fields without resetting history", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "mag-reconcile-"));
  const workbookPath = path.join(tempDir, "control.xlsx");
  const statePath = path.join(tempDir, "config", "reconciliation-state.json");
  const peopleHeaders = [...PEOPLE_HEADERS, "FAVORITE COLOR", "SSN", "PROFESSION", "PREFERRED LANGUAGE"];
  await createFixtureWorkbook(workbookPath, {
    sites: [
      ["S0001", "Canonical", "https://www.example.invalid/signup/", "YES", "", "", "", ""],
      ["", "Duplicate", "https://example.invalid/signup", "", "", "", "", ""],
      ["", "New Site", "https://new.example.invalid/register", "", "", "", "", ""],
    ],
    peopleHeaders,
    people: [
      ["", "New", "Person", "5555550100", "new@example.invalid", "1 Test Way", "Testville", "FL", "32606", "01/02/1990", "", "85000", "[REDACTED_TEST_PASSWORD]", "", "", "", "Blue", "", "Architect", "English"],
    ],
  });
  const registry = structuredClone(await loadFieldRegistry(path.resolve("config/field-registry.json")));
  registry.fields["FAVORITE COLOR"] = {
    profileField: "favoriteColor",
    aliases: ["favorite color", "preferred color"],
    autofill: true,
    sensitivity: "normal",
    transform: "text",
  };
  const store = new WorkbookStore(workbookPath);
  try {
    await store.open();
    const report = await store.reconcile(registry, statePath);
    assert.equal(report.peopleAssigned.length, 1);
    assert.equal(report.sitesAssigned.length, 2);
    assert.deepEqual(report.peopleDefaultedPending, report.peopleAssigned);
    assert.ok(report.sitesDefaultedActive.length >= 2);
    assert.equal(report.duplicateSites.length, 1);
    assert.ok(report.knownFields.includes("DOB"));
    assert.ok(report.knownFields.includes("PROFESSION"));
    assert.ok(report.knownFields.includes("FAVORITE COLOR"));
    assert.deepEqual(report.unknownFields, ["PREFERRED LANGUAGE"]);
    assert.deepEqual(report.restrictedFields, ["SSN"]);
    const person = store.getPeople()[0];
    assert.ok(person);
    assert.match(person.id, /^P\d{4}$/);
    assert.equal(person.status, "PENDING");
    assert.equal(person.dob, "01/02/1990");
    assert.equal(person.occupation, "Architect");
    assert.equal(person.annualIncome, "85000");
    assert.equal(person.password, "[REDACTED_TEST_PASSWORD]");
    assert.equal(person.dynamicFields.favoriteColor, "Blue");
    const duplicate = store.getSites().find((site) => site.status === "DUPLICATE");
    assert.ok(duplicate);
    assert.equal(duplicate.active, false);

    const canonical = store.getSites().find((site) => site.id === "S0001");
    const newSite = store.getSites().find((site) => site.name === "New Site");
    assert.ok(canonical && newSite);
    const attempt = await store.beginOrResumeAttempt(person, canonical);
    await store.updateAttempt(attempt, { status: "COMPLETED", retryEligible: "NO" });
    const progress = store.getPersonProgress(person, [canonical, newSite]);
    assert.equal(progress.completed, 1);
    assert.equal(progress.remaining, 1);
    assert.equal(store.getLatestAttempt(person.id, canonical.id)?.status, "COMPLETED");
  } finally {
    await store.release();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("rejects invalid durable IDs instead of silently replacing them", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "mag-invalid-id-"));
  const workbookPath = path.join(tempDir, "control.xlsx");
  await createFixtureWorkbook(workbookPath, {
    people: [["PERSON-ONE", "Bad", "ID", "", "", "", "", "", "", "", "", "", "", "", "", ""]],
  });
  const store = new WorkbookStore(workbookPath);
  try {
    await store.open();
    const registry = await loadFieldRegistry(path.resolve("config/field-registry.json"));
    await assert.rejects(store.reconcile(registry), /Invalid Person ID/);
  } finally {
    await store.release();
    await rm(tempDir, { recursive: true, force: true });
  }
});
