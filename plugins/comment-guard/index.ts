import { definePlugin } from "../../oboext/src/server/plugin-api.js";

type Settings = {
  maxLinks: number;
  minLength: number;
  blacklist: string;
  action: "spam" | "pending";
  trustLoggedIn: boolean;
  trustReturning: boolean;
};

type ApprovePayload = {
  comment: { content: string; userId?: number | null; authorUrl?: string | null };
  /** Core's decision so far. A plugin may downgrade it. */
  status: "published" | "pending" | "spam";
  reason?: string;
};

export default definePlugin<Settings>({
  setup({ settings, addFilter, HOOKS, log }) {
    addFilter<ApprovePayload>(HOOKS.commentApprove, (payload) => {
      const { comment } = payload;
      if (settings.trustLoggedIn && comment.userId) return payload;

      const content = (comment.content ?? "").trim();

      if (content.length < (settings.minLength || 1)) {
        payload.status = settings.action;
        payload.reason = "内容过短";
        return payload;
      }

      const links = (content.match(/https?:\/\//gi) ?? []).length;
      if (links > (settings.maxLinks ?? 2)) {
        payload.status = settings.action;
        payload.reason = `链接过多（${links}）`;
        log("blocked by link count:", links);
        return payload;
      }

      const words = (settings.blacklist ?? "")
        .split(/\r?\n/)
        .map((w) => w.trim().toLowerCase())
        .filter(Boolean);
      const haystack = `${content} ${comment.authorUrl ?? ""}`.toLowerCase();
      const hit = words.find((w) => haystack.includes(w));
      if (hit) {
        payload.status = settings.action;
        payload.reason = `命中关键词「${hit}」`;
        log("blocked by keyword:", hit);
      }
      return payload;
    });
  },
});
