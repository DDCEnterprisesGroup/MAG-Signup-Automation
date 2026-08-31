import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("production supervisor directly inherits stdin/stdout/stderr for the worker", async () => {
  const source = await readFile(new URL("../scripts/supervise.mjs", import.meta.url), "utf8");
  assert.match(source, /spawn\(process\.execPath/);
  assert.match(source, /stdio:\s*\["inherit",\s*"inherit",\s*"inherit"\]/);
  assert.doesNotMatch(source, /spawn\("npm"/);
});
