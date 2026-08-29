import { spawn } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";

const [pidFile, projectRoot, ...magArgs] = process.argv.slice(2);
if (!pidFile || !projectRoot) process.exit(2);
const child = spawn("npm", ["start", "--", ...magArgs], { cwd: projectRoot, env: process.env, stdio: "inherit", shell: false });
writeFileSync(pidFile, `${child.pid}\n`, { mode: 0o600 });
const forward = (signal) => { if (!child.killed) child.kill(signal); };
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => forward(signal));
child.on("error", (error) => { console.error(error.message); rmSync(pidFile, { force: true }); process.exitCode = 1; });
child.on("exit", (code, signal) => { rmSync(pidFile, { force: true }); process.exitCode = signal ? 128 : (code ?? 1); });
