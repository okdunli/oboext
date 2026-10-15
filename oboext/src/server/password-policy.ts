import { ServiceError } from "./errors.js";

const COMMON_PASSWORDS = new Set([
  "123456", "123456789", "12345678", "1234567890", "1234567", "12345", "1234", "123",
  "111111", "11111111", "000000", "00000000", "666666", "888888", "999999",
  "222222", "333333", "444444", "555555", "777777",
  "112233", "121212", "123321", "654321", "696969", "131313", "159753", "753951",
  "147258369", "963852741", "789456123", "0123456789", "9876543210",
  "password", "password1", "password123", "passw0rd", "p@ssw0rd", "passwd", "pass",
  "admin", "admin123", "admin1234", "administrator", "root", "toor",
  "welcome", "welcome1", "letmein", "monkey", "dragon", "sunshine", "princess",
  "football", "baseball", "superman", "batman", "trustno1", "iloveyou", "loveme",
  "freedom", "whatever", "abc123", "abcd1234", "a123456", "a123456789", "123123",
  "1q2w3e4r", "1qaz2wsx", "qwerty", "qwertyuiop", "qwerty123", "qazwsx",
  "asdfgh", "asdfghjkl", "zxcvbn", "zxcvbnm",
  "woaini", "woaini1314", "5201314", "1314520", "521521", "7758521", "520520",
  "741852963", "woaini520",
  "computer", "internet", "google", "yahoo", "china", "chinalove",
  "oboext", "cmsadmin", "blogadmin", "test123", "temp123", "changeme", "default",
  "guest", "public", "master", "shadow", "michael", "jennifer", "hunter", "ranger",
  "buster", "thomas", "soccer", "harley", "hockey", "killer", "george", "andrew",
  "charlie", "andrea", "daniel", "starwars", "banana", "orange", "apple",
  "flower", "summer", "winter", "spring", "autumn", "zxcvbn123", "qwe123",
]);

const REPEAT_RE = /^([\s\S])\1*$/;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function hasSequentialRun(s: string, len: number): boolean {
  const lower = s.toLowerCase();
  for (let i = 0; i + len <= lower.length; i++) {
    let up = true;
    let down = true;
    for (let j = 1; j < len; j++) {
      const d = lower.charCodeAt(i + j) - lower.charCodeAt(i + j - 1);
      if (d !== 1) up = false;
      if (d !== -1) down = false;
      if (!up && !down) break;
    }
    if (up || down) return true;
  }
  return false;
}

export type PasswordContext = {
  email?: string | null;
  name?: string | null;
};

function similaritySeeds(ctx: PasswordContext): string[] {
  const out: string[] = [];
  const push = (raw: unknown) => {
    const s = String(raw ?? "").trim().toLowerCase();
    if (s.length >= 4) out.push(s);
  };
  push(ctx.name);
  const email = String(ctx.email ?? "").trim().toLowerCase();
  if (email) {
    push(email);
    const at = email.indexOf("@");
    if (at > 0) push(email.slice(0, at));
  }
  return out;
}

export function passwordViolations(pw: string, ctx: PasswordContext = {}): string[] {
  const out: string[] = [];
  const min = envInt("OBOEXT_PASSWORD_MIN_LENGTH", 8);
  const max = envInt("OBOEXT_PASSWORD_MAX_LENGTH", 200);
  const raw = typeof pw === "string" ? pw : "";
  if (raw.length < min) {
    out.push(`密码长度至少为 ${min} 个字符`);
    return out;
  }
  if (raw.length > max) {
    out.push(`密码长度不能超过 ${max} 个字符`);
    return out;
  }
  const norm = raw.trim();
  if (COMMON_PASSWORDS.has(norm.toLowerCase()))
    out.push("密码过于常见，请更换一个更独特的密码");
  if (REPEAT_RE.test(norm)) out.push("密码不能由同一个字符重复组成");
  if (hasSequentialRun(norm, 6)) out.push("密码不能包含 6 位以上的连续升降序字符");
  const lower = norm.toLowerCase();
  for (const seed of similaritySeeds(ctx)) {
    if (lower.includes(seed)) {
      out.push("密码不能包含账号或昵称");
      break;
    }
  }
  return out;
}

export function passwordError(pw: string, ctx?: PasswordContext): ServiceError | null {
  const violations = passwordViolations(pw, ctx);
  return violations.length > 0 ? new ServiceError(violations[0], 422) : null;
}

export function assertPassword(pw: string, ctx?: PasswordContext): void {
  const err = passwordError(pw, ctx);
  if (err) throw err;
}
