import { runPreflight, type PreflightOptions } from "../operations/preflight.js";

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1]?.trim() : undefined;
};

const options: PreflightOptions = { startingWorker: argv.includes("--starting") };
if (argv.includes("--targeted")) {
  const personId = (flag("--person") ?? "").toUpperCase();
  const siteId = (flag("--site") ?? "").toUpperCase();
  if (!/^P\d{4,}$/.test(personId) || !/^S\d{4,}$/.test(siteId)) {
    console.log("Reconciling... FAIL");
    console.log("Reason:");
    console.log("  - `--targeted` requires --person P#### --site S####");
    process.exit(1);
  }
  options.targeted = { personId, siteId };
}

const result = await runPreflight(undefined, (line) => console.log(line), options).catch((error: unknown) => {
  console.log("");
  console.log("Reconciling... FAIL");
  console.log("Worker NOT started.");
  console.log("");
  console.log("Reason:");
  console.log(`  - ${error instanceof Error ? error.message : String(error)}`);
  return { blocked: true } as const;
});

if (result.blocked) process.exitCode = 1;
