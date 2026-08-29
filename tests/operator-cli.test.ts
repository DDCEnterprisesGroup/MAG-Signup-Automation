import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { parseHandoffArgs, parseTargetedRunArgs } from "../src/cli/operator-args.js";

const ctl = new URL("../scripts/magctl.sh", import.meta.url).pathname;

test("targeted operator arguments are exact and reject broad execution", () => {
  assert.deepEqual(parseTargetedRunArgs(["--person", "p0002", "--site", "s0001", "--dry-run"]), { personId: "P0002", siteId: "S0001", rest: ["--dry-run"] });
  assert.throws(() => parseTargetedRunArgs(["--person", "P0002"]), /Usage/);
  assert.throws(() => parseTargetedRunArgs(["--person", "P0002", "--site", "S0001", "--all"]), /cannot use --all/);
  assert.throws(() => parseTargetedRunArgs(["--person", "X1", "--site", "S0001"]), /Usage/);
});

test("handoff arguments require one valid person/site pair", () => {
  assert.deepEqual(parseHandoffArgs(["resume", "p0002", "s0001"]), { action: "resume", personId: "P0002", siteId: "S0001" });
  assert.throws(() => parseHandoffArgs(["skip", "P0002"]), /Usage/);
  assert.throws(() => parseHandoffArgs(["resume", "P0002", "S0001", "S0002"]), /Usage/);
  assert.throws(() => parseHandoffArgs(["skip", "X1", "S0001"]), /Usage/);
});

test("start help is forwarded without starting the worker", () => {
  const output = execFileSync(ctl, ["start", "--help"], { encoding: "utf8", cwd: "/private/tmp", env: { ...process.env, MAG_DATA_DIR: "/private/tmp/mag-cli-test-data" } });
  assert.match(output, /mag run --person P0001 --site S0001/);
  assert.doesNotMatch(output, /started successfully/i);
});
