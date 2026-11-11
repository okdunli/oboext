/**
 * English copy for the site-settings schema.
 *
 * The schema in site-settings-schema.ts is written in Chinese (the product's
 * source language) and is read by ONE renderer (adminSettings) plus the settings
 * service. Rather than minting ~110 catalogue keys and rewriting the schema into
 * markers, the English names live here as a lookup keyed by the source string.
 *
 * The risk of a text-keyed table is silent fallback when someone edits the
 * Chinese: every CJK string in the schema must have an entry here, so a new
 * field cannot ship untranslated.
 */
export const SETTINGS_EN: Record<string, string> = {
  // ---- placeholders
  "逗号分隔": "Comma separated",
  "广告\n赌博": "ads\ngambling",
  "留空则不预填": "Empty pre-fills nothing",
  "我的博客": "My blog",
  "全站的日历基准：文章的年月日、归档分组、sitemap lastmod、签到日期都按它切日。修改后新内容按新时区记日，历史数据按旧时区记录、不回改，跨日附近的内容可能前后差一天。":
    "The site's calendar: post dates, archive sections, the sitemap's lastmod and check-in days all split on it. New content uses the new zone; historical day labels keep the zone they were written in and are not rewritten, so content near a day boundary may shift by a day.",
  "前台每个日期（文章、页面、评论）的显示样式；sitemap 与机器可读的 datetime 属性不受影响。":
    "How every front-desk date (posts, pages, comments) reads; the sitemap and machine-readable datetime attributes are unaffected.",
  // ---- section descriptions
  "站点身份信息，出现在标题栏、页头、页脚与分享卡片上。": "Site identity: the title bar, header, footer and share cards.",
  "首页展示方式、分页数量与摘要长度等阅读相关设置。": "How the front page lists posts, plus page size and excerpt length.",
  "标题模板支持 %title% / %site% / %tagline% 占位符。这些值会写入每个页面的 <head>。":
    "The title template accepts %title% / %site% / %tagline%; these values are written into every page's <head>.",
  "评论系统可在「系统自带」与多种第三方评论服务之间切换；头像源决定内置评论里头像的解析方式（含 QQ 邮箱直出 QQ 头像）。":
    "Switch between the built-in comment store and several third-party services; the avatar source decides how built-in comments resolve an avatar (QQ mail resolves to a QQ avatar).",
  "原样插入到每个页面。用于统计脚本、站长验证、全站样式覆盖。":
    "Inserted verbatim into every page: analytics scripts, webmaster verification, site-wide style overrides.",
  "RSS 输出全文": "Full text",
  "摘要": "Excerpt",
  "不显示评论": "Hide comments",
  "标题": "Title",
  "统计 ID": "Analytics ID",
  // ---- sections
  "常规": "General",
  "阅读": "Reading",
  "代码注入": "Code injection",
  "头像": "Avatars",
  "评论": "Comments",
  "评论系统": "Comment system",
  "本地化": "Localisation",
  "站长验证": "Webmaster verification",
  "社交链接": "Social links",
  "细节调整请到「主题」页面的设置面板。": "Theme-level options live on the Themes screen.",
  "特定词条": "Specific phrases",
  // ---- general
  "站点名称": "Site name",
  "副标题 / 标语": "Tagline",
  "站点描述": "Site description",
  "页脚版权文字": "Footer copyright",
  "支持 HTML，留空则使用默认版权行。例如：© 2026 站点名称": "HTML is allowed; empty falls back to the default line, e.g. © 2026 Site name",
  "备案号": "ICP filing number",
  "当前主题": "Current theme",
  "主题（可选）": "Theme (optional)",
  "页脚链接": "Footer links",
  "显示在页脚右侧的链接行（友链、备案号等）。文字支持 HTML；图标填 16px 小图 URL，留空则只显示文字。配置后优先于上方「备案号」。":
    "The link row on the right of the footer (friends, filing number…). Text allows HTML; an icon takes a 16px image URL - leave it out to show text only. Once set this wins over the filing number above.",
  // ---- reading
  "首页显示": "Front page shows",
  "最新文章列表": "Latest posts",
  "指定的静态页面": "A static page",
  "作为首页的页面": "Front page",
  "作为文章列表的页面": "Posts page",
  "每页文章数": "Posts per page",
  "摘要字数": "Excerpt length",
  "文章未手写摘要时，自动截取的长度。": "Length taken automatically when a post has no hand-written excerpt.",
  "RSS 输出内容": "Feed payload",
  "仅摘要": "Excerpt only",
  "全文": "Full text",
  "开启后 RSS 输出正文全文而非摘要。": "Emit full post bodies in the feed instead of excerpts.",
  "RSS 条目数": "Feed items",
  "日期格式": "Date format",
  "2026年8月24日": "August 24, 2026",
  "时区": "Time zone",
  "站点语言": "Site language",
  "简体中文": "Simplified Chinese",
  "繁体中文": "Traditional Chinese",
  "日本語": "Japanese",
  // ---- code injection
  "全站自定义 CSS": "Site-wide custom CSS",
  "<head> 注入": "<head> injection",
  "</body> 前注入": "Before </body> injection",
  // ---- seo
  "标题模板": "Title template",
  "默认描述": "Default description",
  "文章/页面没有自己的描述时使用。": "Used when a post or page has no description of its own.",
  "默认关键词": "Default keywords",
  "默认分享图": "Default share image",
  "Og 描述": "OG description",
  "用于首页 meta description 与 RSS 描述。": "Used for the front page's meta description and the feed description.",
  "Twitter @账号": "Twitter @handle",
  "Twitter 卡片": "Twitter card",
  "大图": "Large image",
  "robots 指令": "robots directive",
  "index,follow（允许收录）": "index,follow (indexable)",
  "noindex,nofollow（完全屏蔽）": "noindex,nofollow (fully hidden)",
  "搜索引擎站长验证码": "Search-engine verification codes",
  "只填验证码内容（meta 标签 content 的值），保存后自动输出到全站 <head>。":
    "Paste only the code itself (the meta tag's content value); it is emitted into every page's <head>.",
  // ---- comments
  "开启评论": "Enable comments",
  "所有评论先进审核队列": "Hold every comment for review",
  "游客必须填昵称与邮箱": "Guests must give a name and email",
  "游客必须填链接": "Guests must give a URL",
  "待审关键词": "Words that hold a comment",
  "每行一个；命中的评论标记为待审核。": "One per line; a match marks the comment for review.",
  "评论框默认内容": "Pre-filled comment text",
  "访客打开文章时评论框自动填入的文字，可自由修改后提交。": "Filled into the comment box when a visitor opens a post; they can edit it before submitting.",
  "评论来源": "Comment source",
  "系统自带（内置数据库）": "Built in (this site's database)",
  "选择「系统自带」使用本站数据库存储评论；其余为第三方评论服务。":
    "Built in stores comments in this site's database; the others are third-party services.",
  "Artalk（自建）": "Artalk (self-hosted)",
  "Giscus（GitHub 讨论）": "Giscus (GitHub discussions)",
  "Waline（valine 继任）": "Waline (Valine's successor)",
  "腾讯云开发评论（私有部署）": "Tencent CloudBase (private deploy)",
  "Disqus 站点短名": "Disqus short name",
  "Artalk 服务端地址": "Artalk server URL",
  "填写你的 Artalk 后端地址（含 http(s)://）。": "Your Artalk backend URL, protocol included.",
  "Artalk 站点名称": "Artalk site name",
  "Giscus 仓库": "Giscus repository",
  "仓库 ID": "Repository ID",
  "在仓库「Discussions」设置页或 giscus.app 获取。": "Find it in the repository's Discussions settings or on giscus.app.",
  "分类": "Category",
  "分类 ID": "Category ID",
  "讨论映射": "Discussion mapping",
  "路径名（推荐）": "Pathname (recommended)",
  "Issue 映射": "Issue mapping",
  "Issue 编号": "Issue number",
  "启用 Reaction": "Enable reactions",
  "留空跟随系统；可填 dark / light 或 Giscus 主题名。": "Empty follows the OS; accepts dark / light or a Giscus theme name.",
  "Waline 服务端地址": "Waline server URL",
  "评论环境 ID": "Comment environment ID",
  "腾讯云 / Vercel / 私有部署的环境 ID 或域名。": "The environment id or domain on Tencent Cloud / Vercel / a private deploy.",
  "Utterances 仓库": "Utterances repository",
  "评论 Webhook 地址": "Comment webhook URL",
  "有新评论时向该地址 POST 一条 JSON 通知；留空则禁用。": "POST a JSON notice here for each new comment; empty disables it.",
  // ---- avatars
  "头像源": "Avatar source",
  "Gravatar（国际）": "Gravatar (global)",
  "Gravatar 国内镜像": "Gravatar (China mirror)",
  "Cravatar（酷家）": "Cravatar",
  "QQ 邮箱 → QQ 头像": "QQ mail → QQ avatar",
  "仅对「系统自带」评论生效。QQ 邮箱会自动解析为 QQ 头像。":
    "Only affects built-in comments. A QQ address resolves to that account's avatar.",
  "缺省头像": "Fallback avatar",
  "邮箱无头像时 Gravatar 系显示的占位图。": "Shown when the Gravatar service has nothing for that address.",
  "无头像": "None",
  "头像尺寸": "Avatar size",
  "内容分级": "Content rating",
};
