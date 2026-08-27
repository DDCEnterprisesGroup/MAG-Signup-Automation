import { readFile } from "node:fs/promises";
import path from "node:path";

const packageJson = JSON.parse(await readFile(path.resolve("package.json"), "utf8")) as { version: string };
console.log(`MAG Automation v${packageJson.version}`);
