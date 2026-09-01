import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WorkbookStore } from "../src/excel/workbook-store.js";
import { createFixtureWorkbook } from "./helpers/workbook-fixture.js";

async function fixture(): Promise<{ wbPath: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mag-lock-race-"));
  const wbPath = path.join(dir, "wb.xlsx");
  await createFixtureWorkbook(wbPath, {
    sites: [["S0001", "S", "https://example.invalid/s", "YES", "ACTIVE", "", "", ""]],
    people: [["P0001", "T", "P", "", "t@example.invalid", "", "", "", "", "", "", "", "", "PENDING", "", ""]],
  });
  return { wbPath, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

// TEST H — two workers starting at nearly the same instant.
test("simultaneous open: exactly one lock owner, the other refuses", async () => {
  const { wbPath, cleanup } = await fixture();
  try {
    const a = new WorkbookStore(wbPath);
    const b = new WorkbookStore(wbPath);
    const results = await Promise.allSettled([a.open(), b.open()]);
    const opened = results.filter((r) => r.status === "fulfilled").length;
    const refused = results.filter((r) => r.status === "rejected");
    assert.equal(opened, 1, "exactly one worker acquired the lock");
    assert.equal(refused.length, 1);
    assert.match(String((refused[0] as PromiseRejectedResult).reason), /already in use/i);
    await a.release().catch(() => undefined);
    await b.release().catch(() => undefined);
  } finally {
    await cleanup();
  }
});

// TEST H — an unreadable, freshly-created lock must NOT be stolen.
test("a recent unreadable lock is treated as HELD, not stale", async () => {
  const { wbPath, cleanup } = await fixture();
  try {
    // Simulate a racing worker that created the lock file but has not yet
    // written its metadata (empty / partial file, current mtime).
    await writeFile(`${wbPath}.lock`, "");
    const store = new WorkbookStore(wbPath);
    await assert.rejects(store.open(), /already in use/i, "must not steal a lock younger than the grace window");
    await store.release().catch(() => undefined);
  } finally {
    await rm(`${wbPath}.lock`, { force: true });
    await cleanup();
  }
});

// TEST H — a genuinely old unreadable lock IS reclaimable.
test("an old unreadable lock is reclaimed", async () => {
  const { wbPath, cleanup } = await fixture();
  try {
    await writeFile(`${wbPath}.lock`, "");
    // Backdate the lock well beyond the 15s grace window.
    const old = new Date(Date.now() - 60_000);
    const { utimes } = await import("node:fs/promises");
    await utimes(`${wbPath}.lock`, old, old);
    const store = new WorkbookStore(wbPath);
    await store.open();
    try {
      const meta = JSON.parse(await readFile(`${wbPath}.lock`, "utf8")) as { pid?: number };
      assert.equal(meta.pid, process.pid, "we now own the lock with our metadata published");
    } finally {
      await store.release();
    }
  } finally {
    await cleanup();
  }
});

// A stale lock from a dead PID is still reclaimed (regression: pre-existing behaviour).
test("a lock owned by a dead PID is reclaimed", async () => {
  const { wbPath, cleanup } = await fixture();
  try {
    await writeFile(`${wbPath}.lock`, JSON.stringify({ pid: 2_147_483_646, startedAt: new Date().toISOString() }));
    const store = new WorkbookStore(wbPath);
    await store.open();
    await store.release();
  } finally {
    await cleanup();
  }
});
