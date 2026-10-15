import { ServiceError } from "./errors.js";

export type Issue = { path: string; message: string };

type Failure = { ok: false; message: string; path: string; issues?: Issue[] };
type Outcome<T> = { ok: true; value: T } | Failure;
export type Rule<T> = (value: unknown, path: string) => Outcome<T>;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function fail(path: string, message: string, issues?: Issue[]): Failure {
  return { ok: false, message, path, issues };
}

function subject(path: string, label?: string): string {
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
    const s = subject("", opts.label);
    return (value, path) => {
      if (typeof value !== "string") return fail(path, `${s}必须是字符串`);
      let out = trim ? value.trim() : value;
      if (opts.lower) out = out.toLowerCase();
      if (opts.upper) out = out.toUpperCase();
      if (opts.min !== undefined && out.length < opts.min)
        return fail(path, `${s}长度不能少于 ${opts.min} 个字符`);
      if (opts.max !== undefined && out.length > opts.max)
        return fail(path, `${s}长度不能超过 ${opts.max} 个字符`);
      if (opts.pattern && !opts.pattern.test(out))
        return fail(path, opts.message ?? `${s}格式不正确`);
      return { ok: true, value: out };
    };
  },

  email(opts: { max?: number; label?: string } = {}): Rule<string> {
    return v.string({
      max: opts.max ?? 120,
      label: opts.label ?? "邮箱",
      pattern: EMAIL_RE,
      message: "邮箱格式不正确",
    });
  },

  int(opts: IntOpts = {}): Rule<number> {
    const s = subject("", opts.label);
    return (value, path) => {
      let n: number;
      if (typeof value === "number") n = value;
      else if (opts.coerce && typeof value === "string" && value.trim() !== "") n = Number(value);
      else return fail(path, `${s}必须是整数`);
      if (!Number.isInteger(n)) return fail(path, `${s}必须是整数`);
      if (opts.min !== undefined && n < opts.min)
        return fail(path, `${s}不能小于 ${opts.min}`);
      if (opts.max !== undefined && n > opts.max)
        return fail(path, `${s}不能大于 ${opts.max}`);
      return { ok: true, value: n };
    };
  },

  number(opts: { min?: number; max?: number; coerce?: boolean; label?: string } = {}): Rule<number> {
    const s = subject("", opts.label);
    return (value, path) => {
      let n: number;
      if (typeof value === "number") n = value;
      else if (opts.coerce && typeof value === "string" && value.trim() !== "") n = Number(value);
      else return fail(path, `${s}必须是数字`);
      if (!Number.isFinite(n)) return fail(path, `${s}必须是数字`);
      if (opts.min !== undefined && n < opts.min) return fail(path, `${s}不能小于 ${opts.min}`);
      if (opts.max !== undefined && n > opts.max) return fail(path, `${s}不能大于 ${opts.max}`);
      return { ok: true, value: n };
    };
  },

  bool(opts: { label?: string } = {}): Rule<boolean> {
    const s = subject("", opts.label);
    return (value, path) => {
      if (typeof value !== "boolean") return fail(path, `${s}必须是布尔值`);
      return { ok: true, value };
    };
  },

  enum<T extends string>(values: readonly T[], opts: { label?: string; message?: string } = {}): Rule<T> {
    const s = subject("", opts.label);
    return (value, path) => {
      if (typeof value !== "string" || !values.includes(value as T))
        return fail(path, opts.message ?? `${s}只能是: ${values.join(" / ")}`);
      return { ok: true, value: value as T };
    };
  },

  literal<T extends string | number | boolean>(expected: T, opts: { label?: string } = {}): Rule<T> {
    const s = subject("", opts.label);
    return (value, path) => {
      if (value !== expected) return fail(path, `${s}必须是 ${String(expected)}`);
      return { ok: true, value: expected };
    };
  },

  array<T>(item: Rule<T>, opts: ArrayOpts = {}): Rule<T[]> {
    const s = subject("", opts.label);
    return (value, path) => {
      if (!Array.isArray(value)) return fail(path, `${s}必须是数组`);
      if (opts.min !== undefined && value.length < opts.min)
        return fail(path, `${s}至少需要 ${opts.min} 项`);
      if (opts.max !== undefined && value.length > opts.max)
        return fail(path, `${s}不能超过 ${opts.max} 项`);
      const out: T[] = [];
      const issues: Issue[] = [];
      for (let i = 0; i < value.length; i++) {
        const r = item(value[i], `${path}[${i}]`);
        if (r.ok) out.push(r.value);
        else if (r.issues) issues.push(...r.issues);
        else issues.push({ path: `${path}[${i}]`, message: r.message });
      }
      if (issues.length > 0) return fail(path, issues[0].message, issues);
      return { ok: true, value: out };
    };
  },

  object<S extends Record<string, Rule<any>>>(shape: S): Rule<{ [K in keyof S]: S[K] extends Rule<infer T> ? T : never }> {
    return (value, path) => {
      if (value === null || typeof value !== "object" || Array.isArray(value))
        return fail(path, "请求体必须是 JSON 对象");
      const src = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      const issues: Issue[] = [];
      for (const key of Object.keys(shape)) {
        const r = shape[key](src[key], path ? `${path}.${key}` : key);
        if (r.ok) out[key] = r.value;
        else if (r.issues) issues.push(...r.issues);
        else issues.push({ path: path ? `${path}.${key}` : key, message: r.message });
      }
      if (issues.length > 0) return fail(path, issues[0].message, issues);
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

export function parse<T>(
  rule: Rule<T>,
  data: unknown,
): { ok: true; data: T } | { ok: false; issues: Issue[] } {
  const r = rule(data, "");
  if (r.ok) return { ok: true, data: r.value };
  const issues = r.issues ?? [{ path: r.path, message: r.message }];
  return { ok: false, issues: issues.length > 0 ? issues : [{ path: "", message: "请求参数不合法" }] };
}

export function parseOrThrow<T>(rule: Rule<T>, data: unknown): T {
  const r = parse(rule, data);
  if (r.ok) return r.data;
  throw new ServiceError(r.issues.map((i) => i.message).join("；"), 422);
}

export async function parseBody<T>(rule: Rule<T>, request: Request): Promise<T> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new ServiceError("请求体不是合法 JSON", 400);
  }
  return parseOrThrow(rule, raw);
}
