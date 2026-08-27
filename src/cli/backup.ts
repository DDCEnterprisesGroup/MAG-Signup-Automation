import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../config.js";
import { createOperationalBackup } from "../operations/backup-restore.js";

const config = await loadConfig();
const packageJson = JSON.parse(await readFile(path.join(config.projectRoot, "package.json"), "utf8")) as { version: string };
const target = await createOperationalBackup(config, packageJson.version);
console.log(`Backup created: ${target}`);
console.log("Browser profiles were excluded because they can contain authentication material.");
