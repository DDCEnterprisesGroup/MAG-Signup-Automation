import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../config.js";
import { WorkbookStore } from "../excel/workbook-store.js";
import { buildSiteInventory } from "../operations/site-inventory.js";

const config = await loadConfig();
const workbook = new WorkbookStore(config.workbookPath);
await workbook.open();
try {
  const sites = workbook.getSitesIncludingReserved();
  const report = buildSiteInventory(sites, Math.max(1, ...sites.map((site) => site.rowNumber)));
  const reportPath = path.join(config.runtimeDir, "site-inventory-report.json");
  await mkdir(config.runtimeDir, { recursive: true, mode: 0o700 });
  const staging = `${reportPath}.${process.pid}.tmp`;
  await writeFile(staging, JSON.stringify(report, null, 2), { encoding: "utf8", mode: 0o600 });
  await rename(staging, reportPath);
  const { rows: _rows, ...summary } = report;
  console.log(JSON.stringify({ ...summary, reportPath }, null, 2));
} finally { await workbook.release(); }
