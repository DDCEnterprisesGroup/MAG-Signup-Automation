import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../config.js";
import { WorkbookStore } from "../excel/workbook-store.js";
import type { SignupIntake } from "../types/models.js";
import { parseIngestionFile, validateIngestionRecord } from "../operations/ingestion.js";

interface LedgerEntry {
  requestId: string;
  personId: string;
  digest: string;
  result: "CREATED" | "IDEMPOTENT";
  processedAt: string;
  source: string;
}

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`Usage: npm run ingest -- --file /absolute/path/to/signup.json`);
  return value;
}

function digest(input: SignupIntake): string {
  return createHash("sha256").update(JSON.stringify(input, Object.keys(input).sort())).digest("hex");
}

async function main(): Promise<void> {
  const inputPath = path.resolve(argument("--file"));
  const parsed = parseIngestionFile(await readFile(inputPath, "utf8"), path.extname(inputPath));
  const config = await loadConfig();
  const ledgerPath = path.join(config.runtimeDir, "ingestion-ledger.json");
  await mkdir(config.runtimeDir, { recursive: true });
  const ledger = await readFile(ledgerPath, "utf8").then((value) => JSON.parse(value) as LedgerEntry[]).catch(() => []);
  const workbook = new WorkbookStore(config.workbookPath);
  await workbook.open();
  try {
    const additions: LedgerEntry[] = [];
    const summary = { received: parsed.records.length, created: 0, idempotent: 0, rejected: 0, duplicatesPrevented: 0, quarantined: [] as Array<{ index: number; errors: string[] }> };
    for (const [index, input] of parsed.records.entries()) {
      const errors = validateIngestionRecord(input);
      if (errors.length) { summary.rejected += 1; summary.quarantined.push({ index: index + 1, errors }); continue; }
      const inputDigest = digest(input);
      const prior = [...ledger, ...additions].find((entry) => entry.requestId === input.requestId);
      if (prior) {
        if (prior.digest !== inputDigest) { summary.rejected += 1; summary.quarantined.push({ index: index + 1, errors: ["requestId conflicts with prior data"] }); continue; }
        summary.idempotent += 1; summary.duplicatesPrevented += 1; continue;
      }
      try {
        const result = await workbook.ingestPerson(input);
        additions.push({ requestId: input.requestId, personId: result.person.id, digest: inputDigest,
          result: result.created ? "CREATED" : "IDEMPOTENT", processedAt: new Date().toISOString(), source: input.source?.trim() || path.basename(inputPath) });
        if (result.created) summary.created += 1; else { summary.idempotent += 1; summary.duplicatesPrevented += 1; }
      } catch (error) {
        summary.rejected += 1; summary.quarantined.push({ index: index + 1, errors: [error instanceof Error ? error.message : String(error)] });
      }
    }
    const temporary = `${ledgerPath}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify([...ledger, ...additions], null, 2), { encoding: "utf8", mode: 0o600 });
    await rename(temporary, ledgerPath);
    console.log(JSON.stringify({ format: parsed.format, ...summary }, null, 2));
    if (summary.rejected > 0) process.exitCode = 2;
  } finally {
    await workbook.release();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
