import { spawn } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const [pidFile, projectRoot, ...magArgs] = process.argv.slice(2);
if (!pidFile || !projectRoot) process.exit(2);
// Spawn the worker directly.  The old npm intermediary usually inherited the
// terminal, but npm is allowed to manage/pause stdin while running lifecycle
// scripts.  That made raw-mode keypress delivery depend on npm's runtime
// behaviour instead of the worker owning the operator's TTY end-to-end.
const tsxCli = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url));
const child = spawn(process.execPath, [tsxCli, "src/index.ts", ...magArgs], {
  cwd: projectRoot,
  env: process.env,
  stdio: ["inherit", "inherit", "inherit"],
  shell: false,
});
writeFileSync(pidFile, `${child.pid}\n`, { mode: 0o600 });
const forward = (signal) => { if (!child.killed) child.kill(signal); };
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => forward(signal));
child.on("error", (error) => { console.error(error.message); rmSync(pidFile, { force: true }); process.exitCode = 1; });
child.on("exit", (code, signal) => { rmSync(pidFile, { force: true }); process.exitCode = signal ? 128 : (code ?? 1); });
