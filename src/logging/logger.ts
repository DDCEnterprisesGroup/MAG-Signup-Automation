import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { ErrorCategory } from "../types/models.js";
import { safeUrl } from "../utils/text.js";

export interface LogEvent {
  personId?: string;
  siteId?: string;
  url?: string;
  pageStep?: number;
  action: string;
  outcome?: string;
  errorCategory?: ErrorCategory | "";
  message?: string;
}

export class Logger {
  readonly logPath: string;
  private readonly redactions = new Set<string>();

  private constructor(logPath: string) {
    this.logPath = logPath;
  }

  static async create(logsDir: string): Promise<Logger> {
    await mkdir(logsDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    return new Logger(path.join(logsDir, `run-${stamp}.jsonl`));
  }

  addRedactions(values: string[]): void {
    for (const value of values) {
      const trimmed = value.trim();
      if (trimmed.length >= 2) this.redactions.add(trimmed);
    }
  }

  redact(value: string): string {
    let result = value;
    for (const secret of this.redactions) {
      const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      result = result.replace(new RegExp(escaped, "gi"), "[REDACTED]");
    }
    return result;
  }

  async event(event: LogEvent): Promise<void> {
    const payload = {
      timestamp: new Date().toISOString(),
      ...event,
      action: this.redact(event.action),
      ...(event.outcome ? { outcome: this.redact(event.outcome) } : {}),
      ...(event.url ? { url: safeUrl(event.url) } : {}),
      ...(event.message ? { message: this.redact(event.message) } : {}),
    };
    await appendFile(this.logPath, `${JSON.stringify(payload)}\n`, "utf8");
  }
}
