export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function configuredLevel(): LogLevel {
  const raw = (process.env.OBOEXT_LOG_LEVEL ?? "").trim().toLowerCase();
  if (raw === "trace") return "debug";
  if (raw in LEVELS) return raw as LogLevel;
  return process.env.NODE_ENV === "production" ? "info" : "debug";
}

const SENSITIVE_KEY =
  /password|passwd|pwd|secret|token|authorization|cookie|set[_-]?cookie|email|api[_-]?key|private[_-]?key|salt|session|jwt|credential|database[_-]?url|db[_-]?url|connection[_-]?string|dsn/i;

const CREDENTIALS_IN_URL = /:\/\/[^/\s:@]+:[^/\s@]+@/;

function redactString(s: string): string {
  return CREDENTIALS_IN_URL.test(s) ? s.replace(CREDENTIALS_IN_URL, "://***:***@") : s;
}

function redactValue(key: string, value: unknown): unknown {
  if (SENSITIVE_KEY.test(key)) return "[REDACTED]";
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map((v) => (typeof v === "string" ? redactString(v) : v));
  return value;
}

function redactFields(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = redactValue(k, v);
  return out;
}

function errObject(e: Error): Record<string, unknown> {
  const o: Record<string, unknown> = { type: e.name, message: redactString(e.message) };
  if (e.stack) o.stack = redactString(e.stack);
  const cause = (e as Error & { cause?: unknown }).cause;
  if (cause instanceof Error) o.cause = errObject(cause);
  return o;
}

function collectFields(args: unknown[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const extras: unknown[] = [];
  for (const a of args) {
    if (a === undefined || a === null) continue;
    if (a instanceof Error) {
      out.err = errObject(a);
    } else if (typeof a === "object" && !Array.isArray(a)) {
      Object.assign(out, redactFields(a as Record<string, unknown>));
    } else {
      extras.push(typeof a === "string" ? redactString(a) : a);
    }
  }
  if (extras.length === 1 && !("detail" in out)) out.detail = extras[0];
  else if (extras.length > 1) out.detail = extras;
  return out;
}

function prettyLine(level: LogLevel, mod: string, msg: string, fields: Record<string, unknown>): string {
  const head = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)}[${mod}]`;
  if (!msg && !Object.keys(fields).length) return head;
  const kv = Object.entries(fields)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" ");
  return [head, msg, kv].filter(Boolean).join(" ");
}

const writers: Partial<Record<LogLevel, (s: string) => void>> = {};

function write(level: LogLevel, line: string): void {
  const w = writers[level];
  if (w) {
    try {
      w(line);
    } catch {
      // A failing sink must never take the process down with it.
    }
    return;
  }
  const stream = level === "warn" || level === "error" ? process.stderr : process.stdout;
  try {
    stream.write(line + "\n");
  } catch {
    // A closed stdout (EPIPE during shutdown) must never turn logging into a crash.
  }
}

export interface Logger {
  debug(msg?: string, ...args: unknown[]): void;
  info(msg?: string, ...args: unknown[]): void;
  warn(msg?: string, ...args: unknown[]): void;
  error(msg?: string, ...args: unknown[]): void;
  child(sub: string): Logger;
  readonly level: LogLevel;
}

export function createLogger(mod: string): Logger {
  const threshold = LEVELS[configuredLevel()];
  const usePretty = process.env.OBOEXT_LOG_FORMAT === "pretty" || (!!process.stdout?.isTTY && process.env.OBOEXT_LOG_FORMAT !== "json");

  function emit(level: LogLevel, msg: string | undefined, args: unknown[]): void {
    if (LEVELS[level] < threshold) return;
    const fields = collectFields(args);
    if (usePretty) {
      write(level, prettyLine(level, mod, msg ?? "", fields));
      return;
    }
    const rec: Record<string, unknown> = { ts: new Date().toISOString(), level, mod };
    if (msg) rec.msg = msg;
    Object.assign(rec, fields);
    write(level, JSON.stringify(rec));
  }

  return {
    debug: (msg, ...args) => emit("debug", msg, args),
    info: (msg, ...args) => emit("info", msg, args),
    warn: (msg, ...args) => emit("warn", msg, args),
    error: (msg, ...args) => emit("error", msg, args),
    child: (sub) => createLogger(`${mod}:${sub}`),
    get level() {
      return configuredLevel();
    },
  };
}

const cache = new Map<string, Logger>();

export function getLog(mod: string): Logger {
  let l = cache.get(mod);
  if (!l) {
    l = createLogger(mod);
    cache.set(mod, l);
  }
  return l;
}

export function setLogWriter(level: LogLevel, fn: (line: string) => void): void {
  writers[level] = fn;
}

export function clearLogWriters(): void {
  for (const k of Object.keys(writers)) delete writers[k as LogLevel];
}
