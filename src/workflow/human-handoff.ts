import { createInterface } from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import type { Page } from "playwright";
import type { AttemptRecord, HumanHandoffReason, PersonProfile, Site } from "../types/models.js";
import { StopRunError } from "../types/models.js";
import { safeUrl } from "../utils/text.js";
import { captureHandoffSnapshot, observeHandoffPage } from "./handoff-observer.js";

export type OperatorHandoffDecision =
  | { kind: "completed"; reason: string }
  | { kind: "resume"; reason: string; source: "automatic" | "manual" | "validation" };

type ManualCommand = { kind: "continue" } | { kind: "stop" };

function waitForManualCommand(readline: ReturnType<typeof createInterface>): Promise<ManualCommand> {
  return new Promise((resolve) => {
    const onLine = (line: string): void => {
      const answer = line.trim().toLowerCase();
      if (answer === "q" || answer === "quit" || answer === "stop") {
        readline.off("line", onLine);
        resolve({ kind: "stop" });
        return;
      }
      if (answer === "" || answer === "continue" || answer === "c") {
        readline.off("line", onLine);
        resolve({ kind: "continue" });
        return;
      }
      output.write("Enter continue, press Enter, or type q. Automatic page observation is still active.\n");
    };
    readline.on("line", onLine);
  });
}

export async function waitForOperator(
  person: PersonProfile,
  site: Site,
  attempt: AttemptRecord,
  reason: HumanHandoffReason,
  page: Page,
): Promise<OperatorHandoffDecision> {
  let baseline = await captureHandoffSnapshot(page);
  output.write("\n=== HUMAN ACTION REQUIRED ===\n");
  output.write(`Person: ${person.id} (${person.firstName} ${person.lastName})\n`);
  output.write(`Site: ${site.id} (${site.name})\n`);
  output.write(`Reason: ${reason.reason} [${reason.category}]\n`);
  output.write(`Current page: ${safeUrl(page.url())}\n`);
  output.write(`Attempt: ${attempt.attemptId}\n`);
  output.write("Complete the requested action in the open browser. Page changes are detected automatically.\n");
  output.write("Fallback: press Enter (or type continue) to force a re-scan; type q to stop safely.\n> ");

  const readline = createInterface({ input, output });
  const manualCommand = waitForManualCommand(readline);
  try {
    while (true) {
      const observerController = new AbortController();
      const observation = observeHandoffPage(page, baseline, { signal: observerController.signal })
        .then((value) => ({ source: "observer" as const, value }))
        .catch((error: unknown) => ({ source: "observer_error" as const, error }));
      const manual = manualCommand.then((value) => ({ source: "manual" as const, value }));
      const winner = await Promise.race([observation, manual]);

      if (winner.source === "manual") {
        observerController.abort();
        if (winner.value.kind === "stop") throw new StopRunError();
        return { kind: "resume", reason: "Operator requested a fallback re-scan", source: "manual" };
      }
      if (winner.source === "observer_error") throw winner.error;

      const result = winner.value;
      if (result.kind === "completed") return { kind: "completed", reason: result.reason };
      if (result.kind === "progressed") return { kind: "resume", reason: result.reason, source: "automatic" };
      if (result.kind === "validation_error") {
        output.write("\nValidation errors detected. Re-scanning without marking completion.\n");
        return { kind: "resume", reason: result.reason, source: "validation" };
      }

      output.write(`\n${result.reason}. Remaining in WAITING_FOR_HUMAN.\n`);
      output.write("Review the page and act again, or press Enter to request a re-scan.\n> ");
      baseline = result.snapshot;
    }
  } finally {
    readline.close();
  }
}
