type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export interface LogEntry {
  ts: string;
  level: Level;
  scope: string;
  msg: string;
}

let current: Level = "info";
const listeners = new Set<(e: LogEntry) => void>();

export function setLogLevel(level: Level) {
  current = level;
}

/** Subscribe to log entries (used by the web UI to stream logs). Returns an unsubscribe fn. */
export function onLog(fn: (e: LogEntry) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function format(e: LogEntry): string {
  return `[${e.ts}] ${e.level.toUpperCase().padEnd(5)} [${e.scope}] ${e.msg}`;
}

function emit(level: Level, scope: string, msg: string, extra?: unknown) {
  if (ORDER[level] < ORDER[current]) return;
  const ts = new Date().toISOString();
  const text = extra === undefined ? msg : `${msg} ${typeof extra === "string" ? extra : JSON.stringify(extra)}`;
  const entry: LogEntry = { ts, level, scope, msg: text };
  const out = level === "error" || level === "warn" ? console.error : console.log;
  out(format(entry));
  for (const l of listeners) {
    try {
      l(entry);
    } catch {
      /* listener errors must not break logging */
    }
  }
}

/** Capture every line emitted until stop(); the service archives it as reports/<id>.log next to the report. */
export function captureLogs(): { lines: string[]; stop: () => void } {
  const lines: string[] = [];
  const stop = onLog((e) => lines.push(format(e)));
  return { lines, stop };
}

export function createLogger(scope: string) {
  return {
    debug: (m: string, e?: unknown) => emit("debug", scope, m, e),
    info: (m: string, e?: unknown) => emit("info", scope, m, e),
    warn: (m: string, e?: unknown) => emit("warn", scope, m, e),
    error: (m: string, e?: unknown) => emit("error", scope, m, e),
  };
}

export type Logger = ReturnType<typeof createLogger>;
