#!/usr/bin/env node
/**
 * Set a working password for the seeded demo admin account.
 *
 * The demo seed (tools/seed-source.json) plants admin@example.com with the
 * sentinel password_hash "!demo-no-login", which is NOT a valid bcrypt hash,
 * so the account can never log in. This script replaces it with a real bcrypt
 * hash (cost 10, matching src/server/auth.ts) and forces status = "active".
 *
 * Usage:
 *   DATABASE_URL="postgres://..." node tools/set-admin-password.mjs "你的新密码"
 *   node tools/set-admin-password.mjs "你的新密码" --email you@example.com
 *
 * Requires bcryptjs + postgres (both are app dependencies; run from a checkout
 * that has run `npm install`). The password is read from the first CLI arg or
 * the NEW_ADMIN_PASSWORD env var.
 */
import bcrypt from "bcryptjs";

const password = process.argv[2] || process.env.NEW_ADMIN_PASSWORD;
const email = (process.argv.find((a) => a.startsWith("--email=")) || "--email=admin@example.com").slice(
  "--email=".length,
);

if (!password || password.length < 8) {
  console.error("[set-admin-password] 请提供一个至少 8 位的密码：");
  console.error('  node tools/set-admin-password.mjs "你的新密码"');
  process.exit(1);
}

const url = process.env.DATABASE_URL || process.env.DATABASE_URL_UNPOOLED;
if (!url) {
  console.error("[set-admin-password] 缺少 DATABASE_URL 环境变量（Neon 连接串）。");
  process.exit(1);
}

const { default: postgres } = await import("postgres");
const sql = postgres(url, { max: 1, prepare: false, ssl: "require" });
const hash = await bcrypt.hash(password, 10);

try {
  const res = await sql`
    UPDATE "users"
    SET password_hash = ${hash}, status = 'active'
    WHERE email = ${email}
    RETURNING id, email, name, role, status
  `;
  if (!res.length) {
    console.error(`[set-admin-password] 未找到邮箱为 ${email} 的用户，未做任何修改。`);
    process.exit(1);
  }
  const u = res[0];
  console.log(
    `[set-admin-password] 已为 ${u.email}（${u.name || u.role}）设置密码，状态=${u.status}。现在可用该邮箱登录后台。`,
  );
} finally {
  await sql.end();
}
