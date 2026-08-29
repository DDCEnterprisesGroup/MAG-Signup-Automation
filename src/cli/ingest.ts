import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../config.js";
import { WorkbookStore } from "../excel/workbook-store.js";
import type { SignupIntake } from "../types/models.js";

interface LedgerEntry {
  requestId: string;
  personId: string;
  digest: string;
  result: "CREATED" | "IDEMPOTENT";
  processedAt: string;
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
  const input = JSON.parse(await readFile(inputPath, "utf8")) as SignupIntake;
  const config = await loadConfig();
  const ledgerPath = path.join(config.runtimeDir, "ingestion-ledger.json");
  await mkdir(config.runtimeDir, { recursive: true });
  const ledger = await readFile(ledgerPath, "utf8").then((value) => JSON.parse(value) as LedgerEntry[]).catch(() => []);
  const inputDigest = digest(input);
  const prior = ledger.find((entry) => entry.requestId === input.requestId);
  if (prior) {
    if (prior.digest !== inputDigest) throw new Error("requestId was already used with different signup data.");
    console.log(JSON.stringify({ status: "IDEMPOTENT", requestId: input.requestId, personId: prior.personId }));
    return;
  }

  const workbook = new WorkbookStore(config.workbookPath);
  await workbook.open();
  try {
    const result = await workbook.ingestPerson(input);
    const entry: LedgerEntry = {
      requestId: input.requestId,
      personId: result.person.id,
      digest: inputDigest,
      result: result.created ? "CREATED" : "IDEMPOTENT",
      processedAt: new Date().toISOString(),
    };
    const temporary = `${ledgerPath}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify([...ledger, entry], null, 2), { encoding: "utf8", mode: 0o600 });
    await rename(temporary, ledgerPath);
    console.log(JSON.stringify({ status: entry.result, requestId: entry.requestId, personId: entry.personId }));
  } finally {
    await workbook.release();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
