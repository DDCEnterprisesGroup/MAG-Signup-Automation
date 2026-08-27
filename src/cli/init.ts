import { access, copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../config.js";
import { initializeFieldRegistry } from "../fields/field-registry.js";
import { WorkbookStore } from "../excel/workbook-store.js";

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function initializeInstallation(projectRoot = process.cwd()): Promise<{ workbookCreated: boolean; workbookPath: string }> {
  const config = await loadConfig(projectRoot);
  await Promise.all([
    mkdir(config.dataDir, { recursive: true }),
    mkdir(path.dirname(config.workbookPath), { recursive: true }),
    mkdir(config.logsDir, { recursive: true }),
    mkdir(config.screenshotsDir, { recursive: true }),
    mkdir(path.join(config.runtimeDir, "browser-profiles"), { recursive: true }),
    mkdir(config.backupsDir, { recursive: true }),
    mkdir(path.dirname(config.fieldRegistryPath), { recursive: true }),
  ]);
  await initializeFieldRegistry(config.projectRoot, config.fieldRegistryPath);
  let workbookCreated = false;
  if (!(await exists(config.workbookPath))) {
    const template = path.join(config.projectRoot, "templates", "MAG_Signup_Automation_Clean_Template.xlsx");
    if (!(await exists(template))) throw new Error(`Clean workbook template is missing: ${template}`);
    await copyFile(template, config.workbookPath, 1);
    workbookCreated = true;
  }
  const localConfigPath = path.join(config.dataDir, "config", "installation.json");
  if (!(await exists(localConfigPath))) {
    await writeFile(localConfigPath, JSON.stringify({ version: 1, createdAt: new Date().toISOString() }, null, 2), { encoding: "utf8", flag: "wx" });
  }
  const store = new WorkbookStore(config.workbookPath);
  await store.open();
  await store.release();
  return { workbookCreated, workbookPath: config.workbookPath };
}

initializeInstallation()
  .then(({ workbookCreated, workbookPath }) => {
    console.log(workbookCreated ? `Created clean workbook: ${workbookPath}` : `Existing workbook preserved: ${workbookPath}`);
    console.log("Initialization complete. Run npm run doctor.");
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
