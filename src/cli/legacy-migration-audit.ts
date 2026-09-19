import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { WorkbookStore } from "../excel/workbook-store.js";

const source = resolve(process.argv[2] || "");
if (!process.argv[2]) throw new Error("Usage: npm run migration:audit -- /absolute/path/to/workbook.xlsx");

const normalize = (value: string) => value.normalize("NFKD").replace(/[^a-z0-9]+/gi, " ").trim().toLowerCase();
const internalTokens = ["d andre combs", "d andre d combs", "magical dream builders", "altaire financial", "ice house jewelers", "k n roberts", "dollar district", "test", "demo", "sample", "internal", "example com"];
const validEmail = (value: string) => !value || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const validPhone = (value: string) => !value || value.replace(/\D/g, "").length >= 10;

const bytes = await readFile(source);
const store = new WorkbookStore(source);
await store.open();
try {
  const people = [...store.getPeople()];
  const identities = new Map<string, number>();
  let internal = 0, incomplete = 0, malformed = 0, credentialRows = 0, sensitiveRows = 0;
  for (const person of people) {
    const identity = normalize(person.email) || normalize(`${person.firstName} ${person.lastName}`);
    identities.set(identity, (identities.get(identity) || 0) + 1);
    const searchable = normalize(`${person.firstName} ${person.lastName} ${person.email}`);
    if (internalTokens.some((token) => searchable.includes(token))) internal += 1;
    if (!person.firstName || !person.lastName || !person.email) incomplete += 1;
    if (!validEmail(person.email) || !validPhone(person.phone)) malformed += 1;
    if (person.password.trim()) credentialRows += 1;
    if (person.dob.trim() || person.annualIncome.trim() || person.address.trim()) sensitiveRows += 1;
  }
  const duplicateRows = [...identities.values()].reduce((total, count) => total + Math.max(0, count - 1), 0);
  const externalCandidates = Math.max(0, people.length - internal);
  console.log(JSON.stringify({
    source,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sourceBytes: bytes.length,
    peopleRows: people.length,
    externalCustomerCandidates: externalCandidates,
    internalOrTestExcluded: internal,
    duplicateRows,
    incompleteRows: incomplete,
    malformedRows: malformed,
    sensitiveRowsHeldBack: sensitiveRows,
    credentialRowsQuarantined: credentialRows,
    standardRowsEligibleForMigration: externalCandidates === 0 ? 0 : externalCandidates,
    migrationApplied: false,
    note: externalCandidates === 0 ? "No real customer rows were available to migrate." : "Review staged candidates before applying migration."
  }, null, 2));
} finally {
  await store.release();
}
