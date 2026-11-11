import { definePlugin } from "../../oboext/src/server/plugin-api.js";
import { getNotifySettings } from "../../oboext/src/server/notify.js";
import { sendSmtpMail } from "../../oboext/src/server/smtp.js";
import { getSettings } from "../../oboext/src/server/queries.js";
import { configuredOrigin } from "../../oboext/src/server/site-origin.js";

type Settings = {
  recipients: string;
  notifyPending: boolean;
  includeContent: boolean;
};

type CommentPayload = {
  comment: {
    id: number;
    authorName: string;
    authorEmail?: string | null;
    authorUrl?: string | null;
    content: string;
    status: string;
    createdAt?: Date | string;
  };
  postType: string;
  postId: number;
  postTitle: string;
  isPublic: boolean;
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&"
      ? "&amp;"
      : c === "<"
        ? "&lt;"
        : c === ">"
          ? "&gt;"
          : c === '"'
            ? "&quot;"
            : "&#39;",
  );
}

export default definePlugin<Settings>({
  setup({ settings, addAction, HOOKS, log }) {
    addAction<CommentPayload>(HOOKS.commentCreated, (payload) => {
      if (!payload?.isPublic && !settings.notifyPending) return;
      const recipients = (settings.recipients || "")
        .split(/[\s,;]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (!recipients.length) return;

      void (async () => {
        const notify = await getNotifySettings();

        if (!notify.smtp.host) {
          log("SMTP 未配置，跳过评论通知邮件");
          return;
        }
        const site = await getSettings();
        const siteName = site.siteTitle || "oboext";
        const c = payload.comment;
        const stateText = payload.isPublic ? "已通过" : "待审核";
        const typeText = payload.postType === "page" ? "页面" : "文章";
        const when = c.createdAt ? new Date(c.createdAt).toLocaleString("zh-CN") : "";

        const lines = [
          `您的站点「${siteName}」收到一条新评论（${stateText}）`,
          "",
          `${typeText}：${payload.postTitle}`,
          `评论人：${c.authorName}${c.authorEmail ? " <" + c.authorEmail + ">" : ""}`,
        ];
        if (c.authorUrl) lines.push(`网址：${c.authorUrl}`);
        if (when) lines.push(`时间：${when}`);
        if (settings.includeContent) lines.push("", "评论内容：", c.content);
        const origin = configuredOrigin();
        // A bare path cannot be opened from a mail client; with the site
        // origin configured the moderation link is clickable, without it the
        // path hint stays honest instead of lying with a relative URL.
        const adminUrl = origin ? `${origin}/admin/comments` : "";
        if (adminUrl) lines.push("", `后台审核：${adminUrl}`);
        else lines.push("", "后台审核：登录后台 → 评论");
        const text = lines.join("\n");

        const html =
          `<div style="padding:24px;font-family:system-ui,sans-serif;color:#222">` +
          `<h2 style="margin:0 0 12px;font-size:18px">${escapeHtml(siteName)} 收到新评论</h2>` +
          `<p style="margin:0 0 8px"><b>状态：</b>${stateText}</p>` +
          `<p style="margin:0 0 8px"><b>${typeText}：</b>${escapeHtml(payload.postTitle)}</p>` +
          `<p style="margin:0 0 8px"><b>评论人：</b>${escapeHtml(c.authorName)}` +
          (c.authorEmail ? ` &lt;${escapeHtml(c.authorEmail)}&gt;` : "") +
          `</p>` +
          (settings.includeContent
            ? `<div style="margin:12px 0;padding:12px;border-left:3px solid #ddd;background:#f8f8f8">${escapeHtml(c.content).replace(/\n/g, "<br>")}</div>`
            : "") +
          (adminUrl
            ? `<p style="margin:12px 0 0"><a href="${adminUrl}" style="color:#2563eb">后台审核</a></p>`
            : "") +
          `</div>`;

        await sendSmtpMail(
          {
            host: notify.smtp.host,
            port: notify.smtp.port,
            security: notify.smtp.security,
            user: notify.smtp.user,
            pass: notify.smtp.pass,
            from: notify.smtp.from || notify.smtp.user,
          },
          {
            to: recipients.join(","),
            subject: `【${siteName}】新评论（${stateText}）：${payload.postTitle}`,
            text,
            html,
          },
        );
      })().catch((e: unknown) => {

        log("评论通知邮件发送失败:", e instanceof Error ? e.message : String(e));
      });
    });
  },
});
