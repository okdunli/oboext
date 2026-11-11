<?xml version="1.0" encoding="UTF-8"?>
<!--
  Browser view for the RSS feeds: readers consume the raw XML, humans opening
  /feed.xml get this readable page instead of the raw tree. Pure XSLT 1.0 -
  no script, no framework CSS, works from any origin that serves this file.
-->
<xsl:stylesheet version="1.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:atom="http://www.w3.org/2005/Atom" exclude-result-prefixes="content dc atom">
  <xsl:output method="html" indent="yes" encoding="UTF-8"/>
  <xsl:template match="/rss/channel">
    <html lang="{language}">
      <head>
        <meta charset="UTF-8"/>
        <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
        <meta name="robots" content="noindex"/>
        <title><xsl:value-of select="title"/> - RSS</title>
        <style>
          :root { color-scheme: light dark; }
          body {
            margin: 0; padding: 2rem 1rem 4rem;
            font: 16px/1.65 system-ui, -apple-system, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif;
            background: #0f0f11; color: #e4e4e7;
          }
          main { max-width: 680px; margin: 0 auto; }
          h1 { font-size: 1.5rem; margin: 0 0 .25rem; }
          .desc { color: #a1a1aa; margin: 0 0 2rem; }
          .hint { font-size: .85rem; color: #71717a; background: #18181b; border: 1px solid #27272a; border-radius: 10px; padding: .75rem 1rem; margin: 0 0 2rem; }
          article { border: 1px solid #27272a; border-radius: 12px; padding: 1rem 1.25rem; margin: 0 0 1rem; }
          h2 { font-size: 1.05rem; margin: 0 0 .35rem; }
          h2 a { color: #e4e4e7; text-decoration: none; }
          h2 a:hover { color: #a5b4fc; }
          .meta { font-size: .8rem; color: #71717a; margin: 0 0 .5rem; }
          .meta a { color: #a1a1aa; }
          .body { font-size: .92rem; overflow-wrap: break-word; }
          .body img { max-width: 100%; height: auto; }
          .body pre { overflow-x: auto; }
          footer { margin-top: 2.5rem; font-size: .8rem; color: #71717a; text-align: center; }
          footer a { color: #a1a1aa; }
          @media (prefers-color-scheme: light) {
            body { background: #fafafa; color: #18181b; }
            .desc, .meta, footer { color: #71717a; }
            .hint, article { border-color: #e4e4e7; }
            .hint { background: #f4f4f5; }
            h2 a { color: #18181b; }
            h2 a:hover { color: #4f46e5; }
          }
        </style>
      </head>
      <body>
        <main>
          <h1><xsl:value-of select="title"/></h1>
          <p class="desc"><xsl:value-of select="description"/></p>
          <p class="hint">
            这是 RSS 订阅源。把上面的地址粘贴进你喜欢的阅读器（Feedly、NetNewsWire、Freso…）即可订阅。
            / This is an RSS feed - paste its URL into your reader app to subscribe.
          </p>
          <xsl:for-each select="item">
            <article>
              <h2><a href="{link}"><xsl:value-of select="title"/></a></h2>
              <p class="meta">
                <xsl:if test="pubDate"><span><xsl:value-of select="pubDate"/></span> · </xsl:if>
                <xsl:if test="dc:creator"><span><xsl:value-of select="dc:creator"/></span> · </xsl:if>
                <a href="{link}"><xsl:value-of select="link"/></a>
              </p>
              <xsl:if test="description">
                <div class="body"><xsl:value-of select="description" disable-output-escaping="yes"/></div>
              </xsl:if>
            </article>
          </xsl:for-each>
          <footer>
            <a href="{link}"><xsl:value-of select="title"/></a>
          </footer>
        </main>
      </body>
    </html>
  </xsl:template>
</xsl:stylesheet>
