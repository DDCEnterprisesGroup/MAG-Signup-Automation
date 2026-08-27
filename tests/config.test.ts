import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig, resolveDefaultDataDir } from "../src/config.js";

test("resolves portable Windows, macOS, and XDG local data paths", () => {
  assert.equal(resolveDefaultDataDir("win32", { LOCALAPPDATA: "D:\\Local" }, "C:\\Users\\Test"), "D:\\Local\\MAG-Automation");
  assert.equal(resolveDefaultDataDir("darwin", {}, "/Users/test"), "/Users/test/Library/Application Support/MAG-Automation");
  assert.equal(resolveDefaultDataDir("linux", { XDG_DATA_HOME: "/var/test-data" }, "/home/test"), "/var/test-data/MAG-Automation");
});

test("runtime WORKER_COUNT is configurable independently of serialized browser tests", async () => {
  const previous = process.env.WORKER_COUNT;
  process.env.WORKER_COUNT = "3";
  try {
    const config = await loadConfig(process.cwd());
    assert.equal(config.workerCount, 3);
  } finally {
    if (previous === undefined) delete process.env.WORKER_COUNT;
    else process.env.WORKER_COUNT = previous;
  }
});
