import { runPreflight } from "../operations/preflight.js";

const result = await runPreflight(undefined, (line) => console.log(line)).catch((error: unknown) => {
  console.log("");
  console.log("Reconciling... FAIL");
  console.log("Worker NOT started.");
  console.log("");
  console.log("Reason:");
  console.log(`  - ${error instanceof Error ? error.message : String(error)}`);
  return { blocked: true } as const;
});

if (result.blocked) process.exitCode = 1;
