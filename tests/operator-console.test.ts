import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { NullOperatorControl, OperatorConsole, type OperatorInput, type OperatorOutput } from "../src/workflow/operator-console.js";

function make(): {
  console: OperatorConsole;
  type: (keys: string) => Promise<void>;
  text: () => string;
  rawModes: boolean[];
} {
  const rawModes: boolean[] = [];
  const stream = new PassThrough();
  let text = "";
  const input = Object.assign(stream, {
    isTTY: true,
    setRawMode: (mode: boolean) => void rawModes.push(mode),
  }) as unknown as OperatorInput;
  const output: OperatorOutput = { isTTY: true, write: (chunk) => void (text += chunk) };
  const console = new OperatorConsole(input, output);
  const type = async (keys: string): Promise<void> => {
    stream.write(keys);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { console, type, text: () => text, rawModes };
}

test("NullOperatorControl is inert and never blocks", async () => {
  const control = new NullOperatorControl();
  assert.equal(await control.checkpoint(), null);
  assert.equal(control.stopRequested, false);
  control.progress("still just a plain log");
  control.close();
});

test("progress lines are written above the status line on a TTY", async () => {
  const { console, text } = make();
  console.start();
  try {
    console.progress("P0007 | Site 3 / 40 | Acme | Scanning Page 2");
    assert.match(text(), /P0007 \| Site 3 \/ 40 \| Acme \| Scanning Page 2/);
  } finally {
    console.close();
  }
});

test("SPACE requests a defer and R requests a retry, each consumed once", async () => {
  const { console, type } = make();
  console.start();
  try {
    await type(" ");
    assert.equal(await console.checkpoint(), "defer");
    assert.equal(await console.checkpoint(), null);
    await type("r");
    assert.equal(await console.checkpoint(), "retry");
  } finally {
    console.close();
  }
});

test("S is a two-step confirmation and never a bare defer or skip", async () => {
  const { console, type, text } = make();
  console.start();
  try {
    await type("s");
    assert.equal(await console.checkpoint(), null);
    assert.match(text(), /Press Y to confirm/);
    await type("y");
    assert.equal(await console.checkpoint(), "skip");

    await type("s");
    await type("n");
    assert.equal(await console.checkpoint(), null);
    assert.match(text(), /SKIP cancelled/);
  } finally {
    console.close();
  }
});

test("P pauses the checkpoint until pressed again", async () => {
  const { console, type } = make();
  console.start();
  try {
    await type("p");
    let resolved = false;
    const pending = console.checkpoint().then((value) => {
      resolved = true;
      return value;
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(resolved, false);
    await type("p");
    assert.equal(await pending, null);
  } finally {
    console.close();
  }
});

test("Q is a confirmed graceful stop", async () => {
  const { console, type } = make();
  console.start();
  try {
    await type("q");
    assert.equal(console.stopRequested, false);
    await type("y");
    assert.equal(console.stopRequested, true);
  } finally {
    console.close();
  }
});

test("raw mode is enabled on start and always restored on close (idempotent)", () => {
  const { console, rawModes } = make();
  console.start();
  assert.equal(rawModes.at(0), true);
  console.close();
  assert.equal(rawModes.at(-1), false);
  console.close();
});

test("suspendInput/resumeInput hand the keyboard to a nested prompt and take it back", () => {
  const { console, rawModes } = make();
  console.start();
  try {
    console.suspendInput();
    assert.equal(rawModes.at(-1), false);
    console.resumeInput();
    assert.equal(rawModes.at(-1), true);
  } finally {
    console.close();
  }
});

test("an exception path still restores the terminal via close in a finally", () => {
  const { console, rawModes } = make();
  try {
    console.start();
    throw new Error("boom");
  } catch {
    // handled
  } finally {
    console.close();
  }
  assert.equal(rawModes.at(-1), false);
});
