import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AppConfig } from "../src/config.js";
import { WorkbookStore } from "../src/excel/workbook-store.js";
import { createOperationalBackup, inspectBackup, restoreOperationalBackup } from "../src/operations/backup-restore.js";
import { createFixtureWorkbook } from "./helpers/workbook-fixture.js";

function config(projectRoot: string, dataDir: string): AppConfig {
  return {
    projectRoot,
    dataDir,
    workbookPath: path.join(dataDir, "MAG_Workbook_Automation_Ready.xlsx"),
    fieldRegistryPath: path.join(dataDir, "config", "field-registry.json"),
    reconciliationStatePath: path.join(dataDir, "config", "reconciliation-state.json"),
    headless: true,
    browserChannel: "chrome",
    workerCount: 1,
    navigationTimeoutMs: 30_000,
    navigationRetryTimeoutMs: 60_000,
    navigationRetries: 2,
    retryDelayMs: 0,
    siteDelayMinMs: 0,
    siteDelayMaxMs: 0,
    maxFormSteps: 12,
    maxRepeatedPageState: 2,
    screenshotOnError: false,
    retryCount: 2,
    maxAutoDeferrals: 4,
    dryRun: true,
    logsDir: path.join(dataDir, "logs"),
    screenshotsDir: path.join(dataDir, "screenshots"),
    runtimeDir: path.join(dataDir, "runtime"),
    backupsDir: path.join(dataDir, "backups"),
  };
}

test("portable backup records version, excludes browser state, restores across data roots, and requires overwrite authority", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mag-backup-"));
  const sourceConfig = config(process.cwd(), path.join(root, "windows-data"));
  const destinationConfig = config(process.cwd(), path.join(root, "mac-data"));
  try {
    await mkdir(path.dirname(sourceConfig.fieldRegistryPath), { recursive: true });
    await createFixtureWorkbook(sourceConfig.workbookPath, {
      sites: [["S0001", "Example", "https://example.invalid/signup", "YES", "", "", "", ""]],
      people: [["P0001", "Test", "Person", "", "test@example.invalid", "", "", "", "", "", "", "", "", "PENDING", "", ""]],
    });
    await copyFile(path.resolve("config/field-registry.json"), sourceConfig.fieldRegistryPath);
    await mkdir(sourceConfig.runtimeDir, { recursive: true });
    await writeFile(path.join(sourceConfig.runtimeDir, "ingestion-ledger.json"), '[{"requestId":"safe-id","personId":"P0001","digest":"hash"}]');
    const backupPath = await createOperationalBackup(sourceConfig, "1.1.0");
    const inspected = await inspectBackup(backupPath);
    assert.equal(inspected.metadata.applicationVersion, "1.1.0");
    assert.equal(inspected.metadata.browserStateIncluded, false);
    assert.ok(!inspected.metadata.files.some((file) => /browser/i.test(file)));
    assert.ok(inspected.metadata.files.includes("runtime/ingestion-ledger.json"));

    await restoreOperationalBackup(destinationConfig, backupPath, false);
    const restored = new WorkbookStore(destinationConfig.workbookPath);
    await restored.open();
    try {
      assert.equal(restored.getPeople()[0]?.id, "P0001");
      assert.equal(restored.getSites()[0]?.id, "S0001");
    } finally {
      await restored.release();
    }
    await assert.rejects(restoreOperationalBackup(destinationConfig, backupPath, false), /Explicit overwrite confirmation/);
    assert.match(await readFile(path.join(destinationConfig.runtimeDir, "ingestion-ledger.json"), "utf8"), /safe-id/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
