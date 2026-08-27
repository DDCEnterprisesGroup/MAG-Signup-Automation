import { loadConfig } from "./config.js";
import { WorkbookStore } from "./excel/workbook-store.js";

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1]?.trim() ?? "") : "";
}

async function main(): Promise<void> {
  const personId = argument("--person");
  const siteId = argument("--site");
  if (!personId || !siteId || !process.argv.includes("--confirm")) {
    throw new Error("Usage: npm run reset -- --person P0001 --site S0001 --confirm");
  }

  const config = await loadConfig();
  const workbook = new WorkbookStore(config.workbookPath);
  await workbook.open();
  try {
    const person = workbook.getPeople().find((candidate) => candidate.id === personId);
    if (!person) throw new Error(`Person ID not found: ${personId}`);
    const attempt = workbook.getLatestAttempt(personId, siteId);
    if (!attempt) throw new Error(`No attempt exists for ${personId} + ${siteId}.`);
    if (attempt.status !== "COMPLETED") {
      throw new Error(`Only a COMPLETED pair needs this reset. Latest status is ${attempt.status}.`);
    }
    await workbook.updateAttempt(attempt, {
      status: "TEMP FAILURE",
      retryEligible: "YES",
      errorType: "TEMPORARY_ERROR",
      notes: `Manual reset authorized ${new Date().toISOString()}`,
    });
    await workbook.updatePersonSummary(person);
    await workbook.updatePerson(person, "PENDING", siteId);
    console.log(`Reset authorized for ${personId} + ${siteId}. The next run may process this pair once.`);
  } finally {
    await workbook.release();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
