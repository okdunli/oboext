import { definePlugin } from "../../oboext/src/server/plugin-api.js";

type Settings = {
  cpm: number;
  wpm: number;
  template: string;
  showWordCount: boolean;

  hookMeta: boolean;
};

/** Split a plain-text string into CJK chars + latin words. */
function count(text: string): { chars: number; words: number } {
  const cjk = text.match(/[一-鿿぀-ヿ]/g)?.length ?? 0;
  const latin = text.replace(/[一-鿿぀-ヿ]/g, " ").match(/[A-Za-z0-9']+/g)?.length ?? 0;
  return { chars: cjk, words: latin };
}

export default definePlugin<Settings>({
  setup({ settings, addFilter, HOOKS }) {
    addFilter<{ post: { plainText?: string }; items: { label: string; value: string }[] }>(
      HOOKS.postMeta,
      (payload) => {

        if (settings.hookMeta === false) return payload;
        const text = payload.post?.plainText ?? "";
        if (!text) return payload;
        const { chars, words } = count(text);
        const minutes = Math.max(
          1,
          Math.round(chars / (settings.cpm || 400) + words / (settings.wpm || 220)),
        );
        const total = chars + words;
        const label = (settings.template || "约 {minutes} 分钟")
          .replace("{minutes}", String(minutes))
          .replace("{words}", String(total))
          .replace("{chars}", String(chars));
        payload.items.push({ label: "阅读时长", value: label });
        if (settings.showWordCount) {
          payload.items.push({ label: "字数", value: `${total}` });
        }
        return payload;
      },
    );
  },
});
