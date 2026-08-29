import { execFileSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
let files = [];
try {
  files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split(/\r?\n/).filter(Boolean);
} catch {
  files = [
    "package.json",
    "package-lock.json",
    ".env.example",
    ...execFileSync(process.platform === "win32" ? "cmd" : "sh", process.platform === "win32"
      ? ["/d", "/s", "/c", "where rg >nul 2>nul && rg --files src config templates docs scripts 2>nul"]
      : ["-c", "rg --files src config templates docs scripts 2>/dev/null || true"], { cwd: root, encoding: "utf8" })
      .split(/\r?\n/)
      .filter(Boolean),
  ];
}

const forbiddenPath = /(^|\/)(data|logs|screenshots|runtime|backups|browser-profiles|user-data|user-data-dir|profile-data)(\/|$)|\.xls[mx]$|(^|\/)\.env$|\.(pem|key|pfx|p12)$|credentials.*\.json$|secrets.*\.json$/i;
const secretPattern = /(?:password|secret|api[_-]?key|access[_-]?token|private[_-]?key)\s*[:=]\s*["'](?!\[?REDACTED|<|$)([^"']{6,})["']/i;
const violations = [];
for (const relative of [...new Set(files)]) {
  const normalized = relative.replaceAll("\\", "/");
  if (forbiddenPath.test(normalized) && normalized !== "templates/MAG_Signup_Automation_Clean_Template.xlsx") {
    violations.push(`forbidden path: ${normalized}`);
    continue;
  }
  const absolute = path.join(root, relative);
  try {
    if ((await stat(absolute)).size > 2_000_000 || /\.(xlsx|png|jpg|jpeg|gif|zip)$/i.test(relative)) continue;
    const text = await readFile(absolute, "utf8");
    if (secretPattern.test(text)) violations.push(`possible embedded secret: ${normalized}`);
  } catch {
    // Ignore unreadable or transient files; other validation covers required files.
  }
}
if (violations.length) {
  console.error(violations.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`PASS: scanned ${new Set(files).size} shareable file(s); no forbidden operational paths or obvious embedded secrets detected.`);
}
