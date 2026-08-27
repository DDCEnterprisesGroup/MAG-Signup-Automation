import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Logger } from "../src/logging/logger.js";

test("password, DOB, and income values are redacted from logs", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mag-log-redaction-"));
  try {
    const logger = await Logger.create(directory);
    const password = "[REDACTED_TEST_PASSWORD]";
    const dob = "01/02/1990";
    const income = "85000";
    logger.addRedactions([password, dob, income]);
    await logger.event({ action: "test", message: `values ${password} ${dob} ${income}` });
    const log = await readFile(logger.logPath, "utf8");
    assert.doesNotMatch(log, /TestOnly-Password-123|01\/02\/1990|85000/);
    assert.match(log, /\[REDACTED\]/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
