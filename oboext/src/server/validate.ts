import { ServiceError } from "./errors.js";

export type Issue = { path: string; message: string; key?: string; params?: Record<string, string | number> };

type Failure = {
  ok: false;
  message: string;
  path: string;
  key?: string;
  params?: Record<string, string | number>;
  issues?: Issue[];
};
type Outcome<T> = { ok: true; value: T } | Failure;
export type Rule<T> = (value: unknown, path: string) => Outcome<T>;

/** Request translator shape (structurally matches i18n.makeT's return). */
type Translate = (key: string, vars?: Record<string, string | number>) => string;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Chinese fallbacks for label keys. Visitor-facing routes pass catalog keys
 * as `label`; when no request translator is active (admin surfaces, unit
 * tests, hook callers) the label must still render as proper Chinese rather
 * than leaking the raw key into the message.
 */
const LABEL_ZH: Record<string, string> = {
  "v.field.account": "账号",
  "v.field.password": "密码",
  "v.field.email": "邮箱",
};

/** Translator active for the duration of one parse() call (sync, per-request). */
let curT: Translate | null = null;

function fail(
  path: string,
  message: string,
  extra?: { key?: string; params?: Record<string, string | number>; issues?: Issue[] },
): Failure {
  return { ok: false, message, path, key: extra?.key, params: extra?.params, issues: extra?.issues };
}

function subject(path: string, label?: string): string {
  if (label && label.startsWith("v.")) {
    if (curT) return curT(label);
    return LABEL_ZH[label] ?? label;
  }
  return label || path || "值";
}

export type StringOpts = {
  min?: number;
  max?: number;
  trim?: boolean;
  lower?: boolean;
  upper?: boolean;
  pattern?: RegExp;
  label?: string;
  message?: string;
};

export type IntOpts = {
  min?: number;
  max?: number;
  coerce?: boolean;
  label?: string;
};

export type ArrayOpts = { min?: number; max?: number; label?: string };

export const v = {
  string(opts: StringOpts = {}): Rule<string> {
    const trim = opts.trim !== false;
    return (value, path) => {
      const s = subject("", opts.label);
      if (typeof value !== "string") return fail(path, `${s}必须是字符串`, { key: "v.must_string", params: { s } });
      let out = trim ? value.trim() : value;
      if (opts.lower) out = out.toLowerCase();
      if (opts.upper) out = out.toUpperCase();
      if (opts.min !== undefined && out.length < opts.min)
        return fail(path, `${s}长度不能少于 ${opts.min} 个字符`, {
          key: "v.min_length",
          params: { s, n: opts.min },
        });
      if (opts.max !== undefined && out.length > opts.max)
        return fail(path, `${s}长度不能超过 ${opts.max} 个字符`, {
          key: "v.max_length",
          params: { s, n: opts.max },
        });
      if (opts.pattern && !opts.pattern.test(out))
        return fail(path, opts.message ?? `${s}格式不正确`, { key: "v.pattern", params: { s } });
      return { ok: true, value: out };
    };
  },

  email(opts: { max?: number; label?: string; message?: string } = {}): Rule<string> {
    return v.string({
      max: opts.max ?? 120,
      label: opts.label ?? "v.field.email",
      pattern: EMAIL_RE,
      message: opts.message,
    });
  },

  int(opts: IntOpts = {}): Rule<number> {
    return (value, path) => {
      const s = subject("", opts.label);
      let n: number;
      if (typeof value === "number") n = value;
      else if (opts.coerce && typeof value === "string" && value.trim() !== "") n = Number(value);
      else return fail(path, `${s}必须是整数`, { key: "v.must_int", params: { s } });
      if (!Number.isInteger(n)) return fail(path, `${s}必须是整数`, { key: "v.must_int", params: { s } });
      if (opts.min !== undefined && n < opts.min)
        return fail(path, `${s}不能小于 ${opts.min}`, { key: "v.min_value", params: { s, n: opts.min } });
      if (opts.max !== undefined && n > opts.max)
        return fail(path, `${s}不能大于 ${opts.max}`, { key: "v.max_value", params: { s, n: opts.max } });
      return { ok: true, value: n };
    };
  },

  number(opts: { min?: number; max?: number; coerce?: boolean; label?: string } = {}): Rule<number> {
    return (value, path) => {
      const s = subject("", opts.label);
      let n: number;
      if (typeof value === "number") n = value;
      else if (opts.coerce && typeof value === "string" && value.trim() !== "") n = Number(value);
      else return fail(path, `${s}必须是数字`, { key: "v.must_number", params: { s } });
      if (!Number.isFinite(n)) return fail(path, `${s}必须是数字`, { key: "v.must_number", params: { s } });
      if (opts.min !== undefined && n < opts.min)
        return fail(path, `${s}不能小于 ${opts.min}`, { key: "v.min_value", params: { s, n: opts.min } });
      if (opts.max !== undefined && n > opts.max)
        return fail(path, `${s}不能大于 ${opts.max}`, { key: "v.max_value", params: { s, n: opts.max } });
      return { ok: true, value: n };
    };
  },

  bool(opts: { label?: string } = {}): Rule<boolean> {
    return (value, path) => {
      const s = subject("", opts.label);
      if (typeof value !== "boolean") return fail(path, `${s}必须是布尔值`, { key: "v.must_bool", params: { s } });
      return { ok: true, value };
    };
  },

  enum<T extends string>(values: readonly T[], opts: { label?: string; message?: string } = {}): Rule<T> {
    return (value, path) => {
      const s = subject("", opts.label);
      if (typeof value !== "string" || !values.includes(value as T))
        return fail(path, opts.message ?? `${s}只能是: ${values.join(" / ")}`, {
          key: "v.enum",
          params: { s, values: values.join(" / ") },
        });
      return { ok: true, value: value as T };
    };
  },

  literal<T extends string | number | boolean>(expected: T, opts: { label?: string } = {}): Rule<T> {
    return (value, path) => {
      const s = subject("", opts.label);
      if (value !== expected)
        return fail(path, `${s}必须是 ${String(expected)}`, {
          key: "v.must_literal",
          params: { s, v: String(expected) },
        });
      return { ok: true, value: expected };
    };
  },

  array<T>(item: Rule<T>, opts: ArrayOpts = {}): Rule<T[]> {
    return (value, path) => {
      const s = subject("", opts.label);
      if (!Array.isArray(value)) return fail(path, `${s}必须是数组`, { key: "v.must_array", params: { s } });
      if (opts.min !== undefined && value.length < opts.min)
        return fail(path, `${s}至少需要 ${opts.min} 项`, { key: "v.array_min", params: { s, n: opts.min } });
      if (opts.max !== undefined && value.length > opts.max)
        return fail(path, `${s}不能超过 ${opts.max} 项`, { key: "v.array_max", params: { s, n: opts.max } });
      const out: T[] = [];
      const issues: Issue[] = [];
      for (let i = 0; i < value.length; i++) {
        const r = item(value[i], `${path}[${i}]`);
        if (r.ok) out.push(r.value);
        else if (r.issues) issues.push(...r.issues);
        else issues.push({ path: `${path}[${i}]`, message: r.message, key: r.key, params: r.params });
      }
      if (issues.length > 0) return fail(path, issues[0].message, { key: issues[0].key, params: issues[0].params, issues });
      return { ok: true, value: out };
    };
  },

  object<S extends Record<string, Rule<any>>>(shape: S): Rule<{ [K in keyof S]: S[K] extends Rule<infer T> ? T : never }> {
    return (value, path) => {
      if (value === null || typeof value !== "object" || Array.isArray(value))
        return fail(path, "请求体必须是 JSON 对象", { key: "v.must_object" });
      const src = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      const issues: Issue[] = [];
      for (const key of Object.keys(shape)) {
        const r = shape[key](src[key], path ? `${path}.${key}` : key);
        if (r.ok) out[key] = r.value;
        else if (r.issues) issues.push(...r.issues);
        else issues.push({ path: path ? `${path}.${key}` : key, message: r.message, key: r.key, params: r.params });
      }
      if (issues.length > 0)
        return fail(path, issues[0].message, { key: issues[0].key, params: issues[0].params, issues });
      return { ok: true, value: out as any };
    };
  },

  optional<T>(rule: Rule<T>): Rule<T | undefined> {
    return (value, path) => {
      if (value === undefined) return { ok: true, value: undefined };
      return rule(value, path);
    };
  },

  nullable<T>(rule: Rule<T>): Rule<T | null> {
    return (value, path) => {
      if (value === null) return { ok: true, value: null };
      return rule(value, path);
    };
  },

  any(): Rule<unknown> {
    return (value) => ({ ok: true, value });
  },
};

function renderIssue(issue: Issue, t?: Translate): string {
  if (t && issue.key) return t(issue.key, issue.params);
  return issue.message;
}

export function parse<T>(
  rule: Rule<T>,
  data: unknown,
  t?: Translate,
): { ok: true; data: T } | { ok: false; issues: Issue[] } {
  const prev = curT;
  curT = t ?? null;
  try {
    const r = rule(data, "");
    if (r.ok) return { ok: true, data: r.value };
    const issues = r.issues ?? [{ path: r.path, message: r.message, key: r.key, params: r.params }];
    return { ok: false, issues: issues.length > 0 ? issues : [{ path: "", message: "请求参数不合法", key: "v.invalid" }] };
  } finally {
    curT = prev;
  }
}

export function parseOrThrow<T>(rule: Rule<T>, data: unknown, t?: Translate): T {
  const r = parse(rule, data, t);
  if (r.ok) return r.data;
  throw new ServiceError(r.issues.map((i) => renderIssue(i, t)).join("；"), 422);
}

export async function parseBody<T>(rule: Rule<T>, request: Request, t?: Translate): Promise<T> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new ServiceError(t ? t("v.bad_json") : "请求体不是合法 JSON", 400);
  }
  return parseOrThrow(rule, raw, t);
}
