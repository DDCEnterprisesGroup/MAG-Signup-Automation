import assert from "node:assert/strict";
import test from "node:test";
import { buildSiteInventory, siteRowClass } from "../src/operations/site-inventory.js";
import type { Site } from "../src/types/models.js";

const site = (rowNumber: number, id: string, signupUrl: string, active = true, name = ""): Site => ({
  rowNumber, id, name, signupUrl, active, status: signupUrl ? "NOT CHECKED" : "NOT CHECKED",
  lastChecked: "", finalUrl: "", notes: "",
});

test("inventory excludes reserved formatted rows and preserves distinct same-domain programs", () => {
  const sites = [site(2, "S0001", "https://brand.example/rewards?utm_source=a"),
    site(3, "S0002", "http://brand.example/rewards/?utm_source=b"),
    site(4, "S0003", "https://brand.example/newsletter"), site(5, "S0004", "", false)];
  assert.equal(siteRowClass(sites[3]!), "RESERVED");
  const report = buildSiteInventory(sites, 5);
  assert.equal(report.actualSites, 3);
  assert.equal(report.reservedRows, 1);
  assert.equal(report.highConfidenceDuplicates, 1);
  assert.equal(report.distinctSameDomainPrograms, 2);
});
