// Server-only avatar URL resolver (parity with Oboext lib/avatar.ts). Uses node:crypto — never import from client code.
import { createHash } from "crypto";

export type AvatarSource =
  | "gravatar"
  | "cn-gravatar"
  | "cravatar"
  | "weavatar"
  | "libravatar"
  | "qq"
  | "none";

export interface AvatarOptions {
  source?: AvatarSource;
  size?: number;
  default?: string;
  rating?: string;
}

function md5(input: string): string {
  return createHash("md5").update(input, "utf8").digest("hex");
}

export function getAvatarUrl(
  email: string | null | undefined,
  opts: AvatarOptions = {},
): string | null {
  const source: AvatarSource = opts.source ?? "gravatar";
  const size = opts.size ?? 80;
  if (source === "none") return null;

  const normalized = (email ?? "").trim().toLowerCase();
  const hasEmail = normalized.length > 0;

  if (source === "qq" && normalized.endsWith("@qq.com")) {
    const qq = normalized.split("@")[0];
    if (/^\d{5,12}$/.test(qq)) {
      return `https://q1.qlogo.cn/g?b=qq&nk=${encodeURIComponent(qq)}&s=${size}`;
    }
  }

  if (!hasEmail) return null;
  const hash = md5(normalized);
  const def = opts.default ?? "identicon";
  const rating = opts.rating ?? "g";
  const qs = `s=${size}&d=${encodeURIComponent(def)}&r=${encodeURIComponent(rating)}`;

  switch (source) {
    case "cn-gravatar":
      return `https://cn.gravatar.com/avatar/${hash}?${qs}`;
    case "cravatar":
      return `https://cravatar.cn/avatar/${hash}?${qs}`;
    case "weavatar":
      return `https://weavatar.com/avatar/${hash}?${qs}`;
    case "libravatar":
      return `https://seccdn.libravatar.org/avatar/${hash}?${qs}`;
    case "qq":
      return `https://cravatar.cn/avatar/${hash}?${qs}`;
    case "gravatar":
    default:
      return `https://www.gravatar.com/avatar/${hash}?${qs}`;
  }
}
