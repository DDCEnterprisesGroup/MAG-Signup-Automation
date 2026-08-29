import { access, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import type { AppConfig } from "../config.js";
import { loadFieldRegistry } from "../fields/field-registry.js";
import { WorkbookStore } from "../excel/workbook-store.js";

export interface BackupMetadata {
  format: "MAG-AUTOMATION-BACKUP";
  backupVersion: 1;
  applicationVersion: string;
  createdAt: string;
  sourcePlatform: NodeJS.Platform;
  browserStateIncluded: false;
  files: string[];
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export async function createOperationalBackup(config: AppConfig, applicationVersion: string): Promise<string> {
  await mkdir(config.backupsDir, { recursive: true });
  const store = new WorkbookStore(config.workbookPath);
  await store.open();
  const zip = new JSZip();
  const files: string[] = [];
  const add = async (source: string, archivePath: string, required: boolean): Promise<void> => {
    if (!(await exists(source))) {
      if (required) throw new Error(`Required backup source is missing: ${source}`);
      return;
    }
    zip.file(archivePath, await readFile(source));
    files.push(archivePath);
  };
  try {
    await add(config.workbookPath, "data/MAG_Workbook_Automation_Ready.xlsx", true);
    await add(config.fieldRegistryPath, "config/field-registry.json", true);
    await add(config.reconciliationStatePath, "config/reconciliation-state.json", false);
    await add(path.join(config.dataDir, "config", "installation.json"), "config/installation.json", false);
    await add(path.join(config.runtimeDir, "ingestion-ledger.json"), "runtime/ingestion-ledger.json", false);
    const metadata: BackupMetadata = {
      format: "MAG-AUTOMATION-BACKUP",
      backupVersion: 1,
      applicationVersion,
      createdAt: new Date().toISOString(),
      sourcePlatform: process.platform,
      browserStateIncluded: false,
      files,
    };
    zip.file("backup-metadata.json", JSON.stringify(metadata, null, 2));
    const target = path.join(config.backupsDir, `MAG-Backup-${stamp()}.zip`);
    await writeFile(target, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } }), {
      flag: "wx",
    });
    return target;
  } finally {
    await store.release();
  }
}

export async function inspectBackup(backupPath: string): Promise<{ zip: JSZip; metadata: BackupMetadata }> {
  const zip = await JSZip.loadAsync(await readFile(backupPath));
  const metadataFile = zip.file("backup-metadata.json");
  if (!metadataFile) throw new Error("Backup metadata is missing.");
  const metadata = JSON.parse(await metadataFile.async("string")) as BackupMetadata;
  if (metadata.format !== "MAG-AUTOMATION-BACKUP" || metadata.backupVersion !== 1 || !Array.isArray(metadata.files)) {
    throw new Error("Unsupported or invalid MAG backup format.");
  }
  if (!zip.file("data/MAG_Workbook_Automation_Ready.xlsx") || !zip.file("config/field-registry.json")) {
    throw new Error("Backup is incomplete: workbook or field registry is missing.");
  }
  return { zip, metadata };
}

export async function restoreOperationalBackup(config: AppConfig, backupPath: string, allowOverwrite: boolean): Promise<BackupMetadata> {
  const { zip, metadata } = await inspectBackup(backupPath);
  if ((await exists(config.workbookPath)) && !allowOverwrite) {
    throw new Error("A live workbook already exists. Explicit overwrite confirmation is required.");
  }
  const registryBytes = await zip.file("config/field-registry.json")!.async("uint8array");
  const registry = JSON.parse(new TextDecoder().decode(registryBytes)) as unknown;
  await mkdir(path.dirname(config.fieldRegistryPath), { recursive: true });
  const registryTemp = `${config.fieldRegistryPath}.${process.pid}.restore.tmp`;
  await writeFile(registryTemp, registryBytes, { flag: "wx" });
  try {
    await loadFieldRegistry(registryTemp);
  } catch (error) {
    await rm(registryTemp, { force: true });
    throw error;
  }
  void registry;

  const workbookBytes = await zip.file("data/MAG_Workbook_Automation_Ready.xlsx")!.async("uint8array");
  await mkdir(path.dirname(config.workbookPath), { recursive: true });
  const workbookTemp = `${config.workbookPath}.${process.pid}.restore.tmp.xlsx`;
  await writeFile(workbookTemp, workbookBytes, { flag: "wx" });
  const store = new WorkbookStore(workbookTemp);
  try {
    await store.open();
  } finally {
    await store.release().catch(() => undefined);
  }

  const recoveryStamp = new Date().toISOString().replace(/[:.]/g, "-");
  const workbookRecovery = `${config.workbookPath}.pre-restore-${recoveryStamp}.bak`;
  const registryRecovery = `${config.fieldRegistryPath}.pre-restore-${recoveryStamp}.bak`;
  const hadWorkbook = await exists(config.workbookPath);
  const hadRegistry = await exists(config.fieldRegistryPath);
  if (hadWorkbook) await rename(config.workbookPath, workbookRecovery);
  if (hadRegistry) await rename(config.fieldRegistryPath, registryRecovery);
  try {
    await rename(workbookTemp, config.workbookPath);
    await rename(registryTemp, config.fieldRegistryPath);
  } catch (error) {
    await rm(config.workbookPath, { force: true });
    await rm(config.fieldRegistryPath, { force: true });
    if (hadWorkbook) await rename(workbookRecovery, config.workbookPath);
    if (hadRegistry) await rename(registryRecovery, config.fieldRegistryPath);
    throw error;
  }

  for (const [archivePath, target] of [
    ["config/reconciliation-state.json", config.reconciliationStatePath],
    ["config/installation.json", path.join(config.dataDir, "config", "installation.json")],
    ["runtime/ingestion-ledger.json", path.join(config.runtimeDir, "ingestion-ledger.json")],
  ] as const) {
    const file = zip.file(archivePath);
    if (!file) continue;
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, await file.async("uint8array"));
  }
  return metadata;
}

export async function latestBackup(backupsDir: string): Promise<string | undefined> {
  try {
    const names = (await readdir(backupsDir)).filter((name) => /^MAG-Backup-.*\.zip$/i.test(name)).sort();
    const latest = names.at(-1);
    return latest ? path.join(backupsDir, latest) : undefined;
  } catch {
    return undefined;
  }
}
