import { emitKeypressEvents, type Key } from "node:readline";

/** The narrow slice of a TTY input stream the console needs (keeps it testable). */
export interface OperatorInput {
  isTTY?: boolean;
  setRawMode(mode: boolean): unknown;
  resume(): unknown;
  pause(): unknown;
  on(event: "keypress", listener: (chunk: string | undefined, key: Key | undefined) => void): unknown;
  off(event: "keypress", listener: (chunk: string | undefined, key: Key | undefined) => void): unknown;
}

/** The narrow slice of a TTY output stream the console needs. */
export interface OperatorOutput {
  isTTY?: boolean;
  write(text: string): unknown;
}

/**
 * Live operator controls for the running worker.
 *
 * The engine drives all state changes; this module only turns key presses into
 * *requests* that the engine consumes at its own safe checkpoints (cooperative
 * cancellation). It never kills work mid-action, never touches the workbook, and
 * always restores the terminal — on normal exit, on exception, and on signals.
 */

export type OperatorRequest = "defer" | "retry" | "skip" | "handoff" | null;

export interface LiveStatus {
  personId?: string;
  siteId?: string;
  siteName?: string;
  phase?: string;
  attempt?: string;
  siteStartedAt?: number;
}

export interface OperatorControl {
  /** Called by the engine at a safe point. Blocks while paused; returns a pending action or null. */
  checkpoint(): Promise<OperatorRequest>;
  /** Release the keyboard so a nested readline prompt (human handoff) can use stdin. */
  suspendInput(): void;
  resumeInput(): void;
  setStatus(patch: LiveStatus): void;
  /** A progress line from the engine. Printed above the live status line on a TTY; plain console.log otherwise. */
  progress(message: string): void;
  note(message: string): void;
  countCompleted(): void;
  countFailed(): void;
  countDeferred(): void;
  countHandoff(): void;
  /** True once the operator has asked the worker to stop after the current checkpoint. */
  readonly stopRequested: boolean;
  close(): void;
}

/** Used when there is no TTY (launchd service, tests, piped stdin): controls are simply unavailable. */
export class NullOperatorControl implements OperatorControl {
  readonly stopRequested = false;
  async checkpoint(): Promise<OperatorRequest> {
    return null;
  }
  suspendInput(): void {}
  resumeInput(): void {}
  setStatus(): void {}
  progress(message: string): void {
    console.log(message);
  }
  note(): void {}
  countCompleted(): void {}
  countFailed(): void {}
  countDeferred(): void {}
  countHandoff(): void {}
  close(): void {}
}

interface Counters {
  completed: number;
  failed: number;
  deferred: number;
  handoffs: number;
}

const LEGEND = "[SPACE] next  [R] retry  [S] skip  [H] handoff  [P] pause  [Q] quit";

export class OperatorConsole implements OperatorControl {
  private readonly input: OperatorInput;
  private readonly output: OperatorOutput;
  private request: OperatorRequest = null;
  private paused = false;
  private stopping = false;
  private confirm: "skip" | "quit" | null = null;
  private active = false;
  private closed = false;
  private status: LiveStatus = {};
  private readonly counters: Counters = { completed: 0, failed: 0, deferred: 0, handoffs: 0 };
  private readonly onKeypress = (_: string | undefined, key: Key | undefined): void => this.handleKey(key);
  private readonly restore = (): void => this.teardownRawMode();
  // Restore the terminal immediately on SIGINT, then step aside so the app's own
  // handler (graceful stop) and, ultimately, `close()` run normally. Never
  // re-raises the signal and never calls process.exit, so it cannot loop or
  // suppress the default exit path.
  private readonly onSigint = (): void => {
    this.teardownRawMode();
    process.removeListener("SIGINT", this.onSigint);
  };
  private tickTimer: NodeJS.Timeout | undefined;

  constructor(input: OperatorInput = process.stdin, output: OperatorOutput = process.stdout) {
    this.input = input;
    this.output = output;
  }

  static isAvailable(input: { isTTY?: boolean } = process.stdin): boolean {
    return Boolean(input.isTTY);
  }

  get stopRequested(): boolean {
    return this.stopping;
  }

  start(): void {
    if (this.active || this.closed || !this.input.isTTY) return;
    emitKeypressEvents(this.input as unknown as NodeJS.ReadableStream);
    this.input.setRawMode(true);
    this.input.resume();
    this.input.on("keypress", this.onKeypress);
    process.once("exit", this.restore);
    process.prependListener("SIGINT", this.onSigint);
    this.active = true;
    this.output.write(`\n${LEGEND}\n`);
    this.tickTimer = setInterval(() => this.render(), 1000);
    this.tickTimer.unref();
  }

  suspendInput(): void {
    if (!this.active) return;
    this.clearLine();
    this.input.off("keypress", this.onKeypress);
    if (this.input.isTTY) this.input.setRawMode(false);
    this.input.pause();
    this.active = false;
  }

  resumeInput(): void {
    if (this.active || this.closed || !this.input.isTTY) return;
    this.input.setRawMode(true);
    this.input.resume();
    this.input.on("keypress", this.onKeypress);
    this.active = true;
    this.output.write(`${LEGEND}\n`);
  }

  async checkpoint(): Promise<OperatorRequest> {
    while (this.paused && !this.stopping) {
      this.render();
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    const pending = this.request;
    this.request = null;
    return pending;
  }

  setStatus(patch: LiveStatus): void {
    this.status = { ...this.status, ...patch };
    this.render();
  }

  progress(message: string): void {
    if (!this.output.isTTY) {
      console.log(message);
      return;
    }
    this.clearLine();
    this.output.write(`${message}\n`);
    this.render();
  }

  note(message: string): void {
    this.clearLine();
    this.output.write(`  ${message}\n`);
    this.render();
  }

  countCompleted(): void {
    this.counters.completed += 1;
  }
  countFailed(): void {
    this.counters.failed += 1;
  }
  countDeferred(): void {
    this.counters.deferred += 1;
  }
  countHandoff(): void {
    this.counters.handoffs += 1;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.teardownRawMode();
    process.off("exit", this.restore);
    process.off("SIGINT", this.onSigint);
  }

  private teardownRawMode(): void {
    if (!this.active) return;
    this.active = false;
    this.input.off("keypress", this.onKeypress);
    try {
      if (this.input.isTTY) this.input.setRawMode(false);
    } catch {
      // Terminal already gone; nothing more we can do.
    }
    this.input.pause();
    this.clearLine();
  }

  private handleKey(key: Key | undefined): void {
    if (!key) return;
    // Ctrl+C in raw mode does not raise SIGINT for us; forward it explicitly.
    if (key.ctrl && key.name === "c") {
      // Raw mode swallows the automatic SIGINT; request a graceful stop and
      // re-raise so the app's normal interrupt handler still runs.
      this.stopping = true;
      this.teardownRawMode();
      process.emit("SIGINT");
      return;
    }
    const name = key.name ?? "";

    if (this.confirm) {
      if (name === "y") {
        this.request = this.confirm === "skip" ? "skip" : null;
        if (this.confirm === "quit") this.stopping = true;
        this.note(this.confirm === "skip" ? "S confirmed: permanent skip for this person/site." : "Q confirmed: stopping after the current checkpoint.");
      } else {
        this.note(`${this.confirm.toUpperCase()} cancelled.`);
      }
      this.confirm = null;
      return;
    }

    switch (name) {
      case "space":
        this.request = "defer";
        this.note("SPACE: current site will be deferred at the next safe checkpoint (still retryable later).");
        break;
      case "r":
        this.request = "retry";
        this.note("R: current site will be retried from the start.");
        break;
      case "h":
        this.request = "handoff";
        this.note("H: handing the current site to the human-handoff workflow.");
        break;
      case "p":
        this.paused = !this.paused;
        this.note(this.paused ? "P: paused. Press P again to resume." : "P: resumed.");
        break;
      case "s":
        this.confirm = "skip";
        this.note("Permanently skip this person/site? Press Y to confirm, any other key to cancel.");
        break;
      case "q":
        this.confirm = "quit";
        this.note("Stop the worker after the current checkpoint? Press Y to confirm, any other key to cancel.");
        break;
      default:
        break;
    }
  }

  private clearLine(): void {
    if (this.output.isTTY) this.output.write("\r[2K");
  }

  private render(): void {
    if (!this.output.isTTY || this.closed) return;
    const s = this.status;
    const elapsed = s.siteStartedAt ? formatElapsed(Date.now() - s.siteStartedAt) : "--:--";
    const parts = [
      this.paused ? "PAUSED" : "RUNNING",
      s.personId ?? "-",
      s.siteId ? `${s.siteId}${s.siteName ? ` ${truncate(s.siteName, 22)}` : ""}` : "-",
      s.phase ?? "-",
      s.attempt ? `try ${s.attempt}` : "",
      elapsed,
      `ok ${this.counters.completed} · fail ${this.counters.failed} · defer ${this.counters.deferred} · handoff ${this.counters.handoffs}`,
    ].filter(Boolean);
    this.clearLine();
    this.output.write(parts.join("  |  "));
  }
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = String(Math.floor(total / 60)).padStart(2, "0");
  const seconds = String(total % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}
