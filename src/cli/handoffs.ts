import { loadConfig } from "../config.js";
import { WorkbookStore } from "../excel/workbook-store.js";
import type { AttemptRecord } from "../types/models.js";
import { parseHandoffArgs } from "./operator-args.js";

const config = await loadConfig();
const workbook = new WorkbookStore(config.workbookPath);
await workbook.open();
try {
  const latest = new Map<string, AttemptRecord>();
  for (const attempt of workbook.getAttempts()) if (attempt.status === "WAITING FOR HUMAN") latest.set(`${attempt.personId}:${attempt.siteId}`, attempt);
  const args = process.argv.slice(2);
  if (args.length === 0) {
    const handoffs = [...latest.values()];
    if (!handoffs.length) { console.log("No current human handoffs."); process.exit(0); }
    for (const attempt of handoffs) console.log(`${attempt.personId} ${attempt.siteId} ${attempt.attemptId} ${attempt.errorType || "UNKNOWN"} step=${attempt.formStep} since=${attempt.attemptedAt}`);
    process.exit(0);
  }
  const command = parseHandoffArgs(args);
  const key = `${command.personId}:${command.siteId}`;
  const attempt = latest.get(key);
  if (!attempt) throw new Error(`No current human handoff for ${command.personId} ${command.siteId}.`);
  if (command.action === "resume") {
    console.log(`Handoff found for ${command.personId} ${command.siteId}.`);
  } else if (command.action === "skip") {
    await workbook.updateAttempt(attempt, { status: "FAILED", retryEligible: "NO", notes: `Operator skipped human handoff ${new Date().toISOString()}` });
    const person = workbook.getPeople().find((candidate) => candidate.id.toUpperCase() === command.personId);
    if (person) {
      const hasOther = workbook.getAttempts().some((candidate) => candidate.personId === person.id && candidate.attemptId !== attempt.attemptId && candidate.status === "WAITING FOR HUMAN");
      await workbook.updatePerson(person, hasOther ? "WAITING FOR HUMAN" : "PENDING", hasOther ? command.siteId : "");
    }
    console.log(`Skipped handoff ${command.personId} ${command.siteId}.`);
  }
} finally { await workbook.release(); }
