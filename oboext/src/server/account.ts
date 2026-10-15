import { and, eq, ne, sql } from "drizzle-orm";
import { db, ensureMigrations } from "./db.js";
import { users } from "./schema.js";
import type { Role } from "./schema.js";
import { hashPassword, verifyPassword } from "./auth.js";
import type { SessionUser } from "./auth.js";
import { isPasswordlessUser, clearPasswordlessMark } from "./passwordless.js";
import { ServiceError } from "./errors.js";
import { passwordError } from "./password-policy.js";
import { HOOKS, applyAsyncFilters } from "./hooks.js";
import { ensurePluginsLoaded } from "./plugins.js";
import { getPublicRegisterConfig } from "./members.js";
import type { VirtualSiteRoute } from "./virtual-routes.js";

// --------------------------------------------------------- self-service CRUD

export async function getOwnProfile(actor: SessionUser) {
  await ensureMigrations();
  const [row] = await db
    .select({ id: users.id, name: users.name, email: users.email, phone: users.phone })
    .from(users)
    .where(eq(users.id, actor.id));
  if (!row) throw new ServiceError("用户不存在", 404);
  return row;
}

export async function changeOwnProfile(
  actor: SessionUser,
  input: { name: string; email: string; phone?: string | null },
) {
  await ensureMigrations();
  const [target] = await db.select().from(users).where(eq(users.id, actor.id));
  if (!target) throw new ServiceError("用户不存在", 404);
  const name = input.name.trim();
  const email = input.email.trim();
  const phone = input.phone === undefined ? target.phone : input.phone || null;
  if (!name) throw new ServiceError("昵称不能为空", 422);
  if (email !== target.email) {
    const [exists] = await db
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.email}) = lower(${email})`);
    if (exists) throw new ServiceError("邮箱已被其他账号使用", 422);
  }
  if (phone && phone !== target.phone) {
    const [taken] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.phone, phone), ne(users.id, actor.id)));
    if (taken) throw new ServiceError("手机号已被其他账号使用", 422);
  }
  const [row] = await db
    .update(users)
    .set({ name, email, phone, updatedAt: new Date() })
    .where(eq(users.id, actor.id))
    .returning();
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    role: row.role as Role,
  };
}

export async function changeOwnPassword(
  actor: SessionUser,
  currentPassword: string,
  newPassword: string,
): Promise<{ id: number }> {
  await ensureMigrations();
  const [target] = await db.select().from(users).where(eq(users.id, actor.id));
  if (!target) throw new ServiceError("用户不存在", 404);
  const pwErr = passwordError(newPassword, { email: target.email, name: target.name });
  if (pwErr) throw pwErr;
  const nopassword = await isPasswordlessUser(actor.id);
  if (!nopassword && !(await verifyPassword(currentPassword, target.passwordHash))) {
    throw new ServiceError("当前密码不正确", 422);
  }
  await db
    .update(users)
    .set({ passwordHash: await hashPassword(newPassword), updatedAt: new Date() })
    .where(eq(users.id, actor.id));

  await clearPasswordlessMark(actor.id);
  return { id: actor.id };
}

// ------------------------------------------------------------- user center

export type UserCenterMenuItem = {
  href: string;
  label: string;

  icon?: string;
};

export type UserCenterProfile = {
  id: number;
  name: string;
  email: string | null;
  avatarUrl: string | null;
  createdAt: string | null;
};

const ROLE_LABEL: Record<string, string> = {
  admin: "管理员",
  editor: "编辑",
  author: "作者",
  subscriber: "注册用户",
};

function esc(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export async function getUserCenterProfile(
  userId: number,
): Promise<UserCenterProfile | null> {
  const [row] = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      avatarUrl: users.avatarUrl,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(eq(users.id, userId));
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    avatarUrl: row.avatarUrl,
    createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
  };
}

export async function getUserCenterMenu(): Promise<UserCenterMenuItem[]> {
  await ensurePluginsLoaded();
  const out = await applyAsyncFilters<{ items: UserCenterMenuItem[] }>(
    HOOKS.userCenterMenu,
    { items: [] },
  );
  const seen = new Set<string>();
  return out.items.filter((it) => {
    if (!it || typeof it.href !== "string" || typeof it.label !== "string") return false;
    if (seen.has(it.href)) return false;
    seen.add(it.href);
    return true;
  });
}

const STYLE = `
.oboe-uc-wrap{display:grid;gap:16px;max-width:760px;margin:8px 0 24px}
.oboe-uc-card{border-radius:16px;background:rgba(127,127,127,.07);border:1px solid rgba(127,127,127,.22);padding:22px}
.oboe-uc-head{display:flex;align-items:center;gap:16px}
.oboe-uc-avatar{width:64px;height:64px;border-radius:50%;object-fit:cover;border:1px solid rgba(127,127,127,.25);flex-shrink:0}
.oboe-uc-fallback{width:64px;height:64px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:24px;font-weight:700;background:var(--primary-color,var(--accent,#818cf8));color:#fff;flex-shrink:0}
.oboe-uc-name{font-size:1.2rem;font-weight:700;color:var(--text-color,inherit)}
.oboe-uc-meta{margin-top:4px;font-size:.82rem;opacity:.65;display:flex;flex-wrap:wrap;gap:6px 14px}
.oboe-uc-badge{display:inline-block;border-radius:9em;padding:1px 10px;font-size:.72rem;background:var(--primary-opacity-2,rgba(99,102,241,.15));color:var(--primary-color,var(--accent,#818cf8))}
.oboe-uc-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px}
.oboe-uc-item{display:flex;align-items:center;gap:10px;padding:16px;border-radius:14px;background:rgba(127,127,127,.07);border:1px solid rgba(127,127,127,.22);color:inherit;text-decoration:none;font-size:.95rem;transition:transform .18s ease,border-color .18s ease,box-shadow .18s ease}
.oboe-uc-item:hover{transform:translateY(-2px);border-color:var(--primary-color,var(--accent,#818cf8));box-shadow:0 6px 18px rgba(0,0,0,.08)}
.oboe-uc-item svg{width:18px;height:18px;flex-shrink:0;color:var(--primary-color,var(--accent,#818cf8))}
.oboe-uc-empty{opacity:.6;font-size:.9rem;padding:8px 2px}
.oboe-uc-btn{display:inline-block;margin-right:10px;margin-top:12px;padding:8px 22px;border-radius:9em;font-size:.9rem;text-decoration:none;background:var(--primary-color,var(--accent,#6366f1));color:#fff}
.oboe-uc-btn.ghost{background:transparent;color:var(--primary-color,var(--accent,#6366f1));border:1px solid var(--primary-color,var(--accent,#6366f1))}
`;

export async function renderUserCenter(user: SessionUser): Promise<VirtualSiteRoute> {
  const [profile, items] = await Promise.all([
    getUserCenterProfile(user.id),
    getUserCenterMenu(),
  ]);
  const name = esc(profile?.name ?? user.name);
  const joined = profile?.createdAt
    ? new Date(profile.createdAt).toLocaleDateString("zh-CN")
    : "—";
  const email = profile?.email ? esc(profile.email) : "未绑定邮箱";
  const avatar = profile?.avatarUrl
    ? `<img class="oboe-uc-avatar" src="${esc(profile.avatarUrl)}" alt="${name}">`
    : `<span class="oboe-uc-fallback">${esc((profile?.name ?? user.name).slice(0, 1).toUpperCase())}</span>`;
  const grid = items.length
    ? `<div class="oboe-uc-grid">${items
        .map(
          (it) =>
            `<a class="oboe-uc-item" href="${esc(it.href)}">${
              it.icon ??
              '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/></svg>'
            }<span>${esc(it.label)}</span></a>`,
        )
        .join("")}</div>`
    : `<p class="oboe-uc-empty">暂无扩展功能。</p>`;

  const html = `<style>${STYLE}</style><div class="oboe-uc-wrap">
  <div class="oboe-uc-card"><div class="oboe-uc-head">${avatar}
    <div><div class="oboe-uc-name">${name}</div>
    <div class="oboe-uc-meta"><span class="oboe-uc-badge">${esc(ROLE_LABEL[user.role] ?? user.role)}</span><span>${email}</span><span>加入于 ${joined}</span></div></div>
  </div></div>
  <div class="oboe-uc-card">${grid}</div>
</div>`;

  return { title: "用户中心", html, path: "/me", seoTitle: "用户中心" };
}

export async function renderUserCenterGuest(): Promise<VirtualSiteRoute> {
  const regCfg = await getPublicRegisterConfig().catch(() => null);
  const reg =
    regCfg?.enabled && regCfg.path
      ? `<a class="oboe-uc-btn ghost" href="${esc(regCfg.path)}">注册账号</a>`
      : "";
  const html = `<style>${STYLE}</style><div class="oboe-uc-wrap"><div class="oboe-uc-card" style="text-align:center;padding:40px 22px">
    <div class="oboe-uc-name">请先登录</div>
    <p class="oboe-uc-empty" style="margin-top:8px">登录后可查看个人资料与会员功能。</p>
    <a class="oboe-uc-btn" href="/admin/login?from=%2Fme">登录</a>${reg}
  </div></div>`;
  return { title: "登录", html, path: "/me", seoTitle: "登录" };
}
