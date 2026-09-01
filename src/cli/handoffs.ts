import { loadConfig } from "../config.js";
import { WorkbookStore } from "../excel/workbook-store.js";
import type { AttemptRecord } from "../types/models.js";
import { OPERATOR_RESUME_MARKER } from "../types/models.js";
import { appendNote } from "../utils/text.js";
import { parseHandoffArgs } from "./operator-args.js";

const HELD_STATUSES = new Set(["WAITING FOR HUMAN", "AWAITING CONFIRMATION"]);

const config = await loadConfig();
const workbook = new WorkbookStore(config.workbookPath);
await workbook.open();
try {
  const latest = new Map<string, AttemptRecord>();
  for (const attempt of workbook.getAttempts()) {
    if (HELD_STATUSES.has(attempt.status)) latest.set(`${attempt.personId}:${attempt.siteId}`, attempt);
  }
  const args = process.argv.slice(2);
  if (args.length === 0) {
    const handoffs = [...latest.values()];
    if (!handoffs.length) {
      console.log("No current human handoffs.");
      process.exit(0);
    }
    for (const attempt of handoffs) {
      const tag = attempt.status === "AWAITING CONFIRMATION" ? "SUBMISSION-UNCERTAIN" : attempt.errorType || "UNKNOWN";
      console.log(`${attempt.personId} ${attempt.siteId} ${attempt.attemptId} ${tag} step=${attempt.formStep} since=${attempt.attemptedAt} url=${attempt.lastUrl}`);
    }
    process.exit(0);
  }

  const command = parseHandoffArgs(args);
  const key = `${command.personId}:${command.siteId}`;
  const attempt = latest.get(key);
  if (!attempt) throw new Error(`No current human handoff or submission-uncertain attempt for ${command.personId} ${command.siteId}.`);
  const person = workbook.getPeople().find((candidate) => candidate.id.toUpperCase() === command.personId);
  const now = new Date().toISOString();

  if (command.action === "resume") {
    // For a submission-uncertain attempt this is the ONLY way it becomes
    // processable again: it stamps the explicit-authorization marker so the
    // eligibility gate and beginOrResumeAttempt release it for an in-place
    // re-check of the pinned confirmation URL (never the entry form).
    if (attempt.status === "AWAITING CONFIRMATION") {
      await workbook.updateAttempt(attempt, {
        notes: appendNote(attempt.notes, `${OPERATOR_RESUME_MARKER} ${now} — re-check confirmation URL only`),
      });
      console.log(`Released ${command.personId} ${command.siteId} for a confirmation-URL re-check (no resubmit).`);
    } else {
      console.log(`Handoff found for ${command.personId} ${command.siteId}.`);
    }
  } else if (command.action === "confirm") {
    await workbook.updateAttempt(attempt, {
      status: "COMPLETED",
      retryEligible: "NO",
      notes: appendNote(attempt.notes, `Operator confirmed the signup completed ${now}`),
    });
    if (person) {
      const hasOther = workbook.getAttempts().some(
        (candidate) => candidate.personId === person.id && candidate.attemptId !== attempt.attemptId && HELD_STATUSES.has(candidate.status),
      );
      await workbook.updatePerson(person, hasOther ? "WAITING FOR HUMAN" : "PENDING", hasOther ? command.siteId : "");
    }
    console.log(`Marked ${command.personId} ${command.siteId} COMPLETED (operator-confirmed).`);
  } else {
    // skip: operator abandons this pair. Not retryable.
    await workbook.updateAttempt(attempt, {
      status: "FAILED",
      retryEligible: "NO",
      notes: appendNote(attempt.notes, `Operator skipped ${now}`),
    });
    if (person) {
      const hasOther = workbook.getAttempts().some(
        (candidate) => candidate.personId === person.id && candidate.attemptId !== attempt.attemptId && HELD_STATUSES.has(candidate.status),
      );
      await workbook.updatePerson(person, hasOther ? "WAITING FOR HUMAN" : "PENDING", hasOther ? command.siteId : "");
    }
    console.log(`Skipped ${command.personId} ${command.siteId}.`);
  }
} finally {
  await workbook.release();
}
