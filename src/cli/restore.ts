import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import path from "node:path";
import { loadConfig } from "../config.js";
import { latestBackup, restoreOperationalBackup } from "../operations/backup-restore.js";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1]?.trim() : undefined;
}

const config = await loadConfig();
const selected = argument("--file") || (await latestBackup(config.backupsDir));
if (!selected) throw new Error("No backup was supplied and no backup exists in the local backup directory. Use --file <path>.");
const backupPath = path.resolve(selected);
let confirmed = process.argv.includes("--confirm");
if (!confirmed) {
  if (!process.stdin.isTTY) throw new Error("Restore requires explicit confirmation. Re-run with --confirm or use an interactive terminal.");
  const readline = createInterface({ input, output });
  try {
    const answer = await readline.question(`Restore ${backupPath} into ${config.dataDir}? Type RESTORE to confirm: `);
    confirmed = answer.trim() === "RESTORE";
  } finally {
    readline.close();
  }
}
if (!confirmed) {
  console.log("Restore cancelled; no files were changed.");
} else {
  const metadata = await restoreOperationalBackup(config, backupPath, true);
  console.log(`Restore complete from MAG Automation v${metadata.applicationVersion} backup created ${metadata.createdAt}.`);
  console.log("Run npm run doctor before starting.");
}
