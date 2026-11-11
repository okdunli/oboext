import { POST_FORMATS, type PostFormatDef } from "./post-formats.js";

/**
 * English copy for the post format catalogue.
 *
 * `post-formats.ts` writes each format's label, description and extra-field
 * labels in Chinese (the product's source language) and hands the objects
 * straight to the admin editor. Rather than minting ~30 catalogue keys for a
 * schema that no template reads, the English names live here keyed by the
 * source string, the same shape as site-settings-en.ts and widgets-en.ts.
 *
 * The risk of a text-keyed table is a silent fallback: edit a Chinese label
 * and it renders untranslated instead of failing the build, so every CJK
 * string in post-formats.ts must keep an entry here.
 */
const FORMAT_EN: Record<string, string> = {
  // ---- format labels
  标准: "Standard",
  日志: "Aside",
  引语: "Quote",
  链接: "Link",
  图片: "Image",
  相册: "Gallery",
  视频: "Video",
  音频: "Audio",
  状态: "Status",
  引文: "Quote text",
  出处: "Source",
  目标链接: "Target URL",
  来源名称: "Source name",
  图注: "Caption",
  视频地址: "Video URL",
  封面图: "Cover image",
  音频地址: "Audio URL",

  // ---- format descriptions
  "常规文章，标题 + 正文": "A standard post with a title and a body.",
  "无标题的短随笔，适合碎片想法": "A short untitled note, good for quick thoughts.",
  "以引言为主体，突出显示引文与出处": "A quotation with its source, front and centre.",
  "分享一个外部链接，标题直接指向目标": "Share an external link; the title points at the target.",
  "单张大图为主体": "A single image as the main content.",
  "多图相册，用短代码 [gallery] 或图片区块排布": "An image gallery laid out with the [gallery] shortcode or image blocks.",
  "嵌入视频，正文作为说明": "Embed a video with the body as its caption.",
  "播客 / 音乐，附带播放器": "A podcast or music track with a player.",
  "一句话即时动态": "A one-liner status update.",

  // ---- extra field labels and placeholders
  被引用的话: "The quoted text",
  "作者 / 书名": "Author / book title",
  "https://... 或 /uploads/x.mp4": "https://... or /uploads/x.mp4",
};

/** English for one source string, or the source itself when untranslated. */
function formatCopyEn(text: string): string {
  return FORMAT_EN[text] ?? text;
}

/** The catalogue in the request's language. */
export function localizePostFormats(en: boolean): PostFormatDef[] {
  if (!en) return POST_FORMATS;
  return POST_FORMATS.map((f) => ({
    ...f,
    label: formatCopyEn(f.label),
    description: formatCopyEn(f.description),
    extraFields: f.extraFields?.map((ef) => ({
      ...ef,
      label: formatCopyEn(ef.label),
      ...(ef.placeholder ? { placeholder: formatCopyEn(ef.placeholder) } : {}),
    })),
  }));
}
