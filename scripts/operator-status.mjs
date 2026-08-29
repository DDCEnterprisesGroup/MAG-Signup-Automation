import { readFileSync } from "node:fs";

const [cachePath, pidPath] = process.argv.slice(2);
if (!cachePath || !pidPath) process.exit(2);
let status = {};
try { status = JSON.parse(readFileSync(cachePath, "utf8")); } catch { /* Status has not been cached yet. */ }
let running = false;
try { const pid = Number.parseInt(readFileSync(pidPath, "utf8"), 10); process.kill(pid, 0); running = true; } catch { /* Stopped. */ }
const profiles = status.profiles ?? {};
const worker = status.worker ?? {};
const errors = status.recentErrorCategories ?? {};
const latestError = Object.entries(errors).sort((a, b) => Number(b[1]) - Number(a[1]))[0];
console.log(`MAG: ${running ? "RUNNING" : "STOPPED"}`);
console.log(`Workers: ${running ? 1 : 0} active / ${worker.configuredCount ?? 1} configured`);
console.log(`Workbook: ${status.workbookAvailable === false ? "UNAVAILABLE" : "AVAILABLE"}`);
console.log(`Queue: ${profiles.queued ?? "unknown"} | Handoffs: ${status.humanHandoffs ?? "unknown"} | Retry pending: ${status.retryQueue ?? "unknown"}`);
console.log(`Last activity: ${worker.lastActivity ?? "none"}`);
console.log(`Last reconciliation: ${status.lastReconciliation ?? "none"}`);
console.log(`Recent critical error: ${latestError ? `${latestError[0]} (${latestError[1]})` : "none"}`);
