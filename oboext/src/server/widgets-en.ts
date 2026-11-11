import { WIDGET_AREAS, WIDGET_TYPES } from "./widgets.js";

/**
 * English copy for the widget catalogue.
 *
 * `widgets.ts` writes each widget type's label, description and field labels in
 * Chinese (the product's source language) and hands the objects straight to the
 * admin screen. Rather than minting ~60 catalogue keys for a schema that no
 * template reads, the English names live here keyed by the source string, the
 * same shape as site-settings-en.ts.
 *
 * The risk of a text-keyed table is a silent fallback: edit a Chinese label and
 * it renders untranslated instead of failing the build, so every CJK string in
 * widgets.ts must keep an entry here.
 */
const PAIRS: [string, string][] = [
  // ---- widget types
  ["最新文章", "Recent posts"],
  ["按发布时间倒序列出最近的文章", "The latest posts, newest first"],
  ["热门文章", "Popular posts"],
  ["按阅读量排序的文章列表", "Posts ranked by view count"],
  ["分类目录", "Categories"],
  ["列出全部分类，可显示文章数", "Every category, optionally with its post count"],
  ["标签云", "Tag cloud"],
  ["标签云，字号随文章数变化", "Tag cloud whose font size follows the post count"],
  ["搜索框", "Search box"],
  ["站内搜索输入框", "A site search input"],
  ["文章归档", "Archives"],
  ["按年月归档的文章数量列表", "Post counts by month or year"],
  ["文本 / HTML", "Text / HTML"],
  ["自由文本，支持 HTML 与短代码", "Free text with HTML and shortcodes"],
  ["个人名片", "Profile card"],
  ["头像 + 简介 + 社交链接", "Avatar, bio and social links"],
  ["最新评论", "Recent comments"],
  ["展示最近通过审核的评论", "The latest approved comments"],
  ["友情链接", "Links"],
  ["自定义链接列表", "A custom list of links"],
  ["站点统计", "Site stats"],
  ["文章 / 分类 / 标签 / 评论 / 总阅读量", "Posts / categories / tags / comments / total views"],

  // ---- shared field labels
  ["选项", "Options"],
  ["显示数量", "How many"],
  ["显示日期", "Show date"],
  ["显示缩略图", "Show thumbnail"],
  ["限定分类 slug", "Limit to a category slug"],
  ["留空为全部", "Empty means all"],
  ["显示阅读量", "Show views"],
  ["显示文章数", "Show post count"],
  ["隐藏空分类", "Hide empty categories"],
  ["最多显示", "Max items"],
  ["字号缩放", "Font scaling"],
  ["占位文案", "Placeholder"],
  ["搜索文章…", "Search posts…"],
  ["归档粒度", "Granularity"],
  ["按月", "Monthly"],
  ["按年", "Yearly"],
  ["内容", "Content"],
  ["支持 HTML 与短代码，例如 [button href=\"/about\"]关于[/button]", 'HTML and shortcodes, e.g. [button href="/about"]About[/button]'],
  ["资料", "Details"],
  ["头像", "Avatar"],
  ["昵称", "Name"],
  ["一句话身份", "One-line role"],
  ["简介", "Bio"],
  ["社交链接", "Social links"],
  ["摘要长度", "Excerpt length"],
  ["链接", "Links"],
  ["链接列表", "Link list"],
  ["文章数", "Posts"],
  ["评论数", "Comments"],
  ["总阅读量", "Total views"],
  ["运行天数", "Days online"],
  ["建站日期", "Launch date"],

  // ---- areas
  ["左侧栏", "Left sidebar"],
  ["固定左侧栏的组件区域", "Widgets for the fixed left column"],
  ["页脚", "Footer"],
  ["页脚链接区", "Footer link area"],
];

export const WIDGET_EN: Record<string, string> = Object.fromEntries(PAIRS);

/** English for one source string, or the source itself when untranslated. */
export function widgetCopyEn(text: string | undefined): string | undefined {
  return text === undefined ? undefined : (WIDGET_EN[text] ?? text);
}

/** The catalogue in the request's language: labels, descriptions, field copy. */
export function localizeWidgetCatalog(en: boolean) {
  const tr = (text?: string) => (en ? widgetCopyEn(text) : text);
  return {
    areas: WIDGET_AREAS.map((a) => ({
      ...a,
      label: tr(a.label) as string,
      description: tr(a.description),
    })),
    types: WIDGET_TYPES.map((ty) => ({
      ...ty,
      label: tr(ty.label) as string,
      description: tr(ty.description) as string,
      settings: ty.settings.map((g) => ({
        ...g,
        label: tr(g.label) as string,
        fields: g.fields.map((f) => ({
          ...f,
          label: tr(f.label) as string,
          ...(f.placeholder ? { placeholder: tr(f.placeholder) as string } : {}),
          ...(f.help ? { help: tr(f.help) as string } : {}),
          ...(f.options
            ? { options: f.options.map((o) => ({ ...o, label: tr(o.label) as string })) }
            : {}),
          // A text field's default is content the admin keeps, so translate it
          // too - otherwise an English admin saves a Chinese placeholder.
          ...(typeof f.default === "string" && f.default
            ? { default: tr(f.default) as string }
            : {}),
        })),
      })),
    })),
  };
}
