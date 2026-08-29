import { loadConfig } from "../config.js";
import { WorkbookStore } from "../excel/workbook-store.js";
import { ensureFieldRegistry } from "../fields/field-registry.js";

const config = await loadConfig();
const workbook = new WorkbookStore(config.workbookPath);
await workbook.open();
try {
  const registry = await ensureFieldRegistry(config.projectRoot, config.fieldRegistryPath);
  const report = await workbook.reconcile(registry, config.reconciliationStatePath);
  console.log(JSON.stringify({ peopleAssigned: report.peopleAssigned.length, sitesAssigned: report.sitesAssigned.length,
    peopleDefaultedPending: report.peopleDefaultedPending.length, sitesDefaultedActive: report.sitesDefaultedActive.length,
    highConfidenceDuplicates: report.duplicateSites.length, unknownFields: report.unknownFields,
    restrictedFields: report.restrictedFields, changedPeople: report.changedPersonIds.length, changedSites: report.changedSiteIds.length }, null, 2));
} finally {
  await workbook.release();
}
