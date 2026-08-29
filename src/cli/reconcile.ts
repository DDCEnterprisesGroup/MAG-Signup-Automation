import { loadConfig } from "../config.js";
import { WorkbookStore } from "../excel/workbook-store.js";
import { ensureFieldRegistry } from "../fields/field-registry.js";

const config = await loadConfig();
const workbook = new WorkbookStore(config.workbookPath);
await workbook.open();
try {
  const registry = await ensureFieldRegistry(config.projectRoot, config.fieldRegistryPath);
  console.log(JSON.stringify(await workbook.reconcile(registry, config.reconciliationStatePath), null, 2));
} finally {
  await workbook.release();
}
