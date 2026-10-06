<?xml version="1.0" encoding="UTF-8"?>
<!--
  Browser view of a site's Atom feeds (#728). The theme's feed_stylesheet hook
  adds an <?xml-stylesheet?> instruction pointing here, so a visitor who clicks
  the RSS icon gets a readable page instead of the raw XML tree. Feed readers
  ignore the instruction and parse the same Atom document.

  Deliberately self-contained and neutral: one XSL serves every site, and the
  sites do not share a look (a site's own stylesheet may not even load on its
  pages), so the styles are inline and follow the visitor's light/dark setting.
  A browser applies an XSL only from the feed's own origin, which is why this
  is served from /assets/ on the same host. Same-origin XSL needs no script and
  no external fetch, so the platform's response-header policy (nosniff, frame
  ancestors) does not affect it.
-->
<xsl:stylesheet version="1.0"
                xmlns:xsl="http://www.w3.org/1999/XSL/Transform"
                xmlns:atom="http://www.w3.org/2005/Atom">
  <xsl:output method="html" version="1.0" encoding="UTF-8" indent="yes"/>

  <xsl:template match="/atom:feed">
    <html lang="en">
      <head>
        <meta charset="utf-8"/>
        <meta name="viewport" content="width=device-width, initial-scale=1"/>
        <meta name="robots" content="noindex"/>
        <title><xsl:call-template name="text"><xsl:with-param name="value" select="atom:title"/></xsl:call-template> (feed)</title>
        <style>
          :root { color-scheme: light dark; --fg: #1b1f24; --dim: #57606a; --bg: #fff; --card: #f6f8fa; --line: #d0d7de; --link: #0b57d0; }
          @media (prefers-color-scheme: dark) {
            :root { --fg: #e6edf3; --dim: #9aa4af; --bg: #0d1117; --card: #161b22; --line: #30363d; --link: #79b0ff; }
          }
          * { box-sizing: border-box; }
          body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.6 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
          main { max-width: 42rem; margin: 0 auto; padding: 2rem 1rem 4rem; }
          a { color: var(--link); }
          h1 { margin: 0 0 .75rem; font-size: 1.6rem; line-height: 1.25; }
          .sub { margin: -.5rem 0 1.5rem; color: var(--dim); }
          .how { margin: 0 0 2rem; padding: 1rem 1.25rem; background: var(--card); border: 1px solid var(--line); border-radius: 8px; }
          .how p { margin: 0 0 .75rem; }
          .how p:last-child { margin-bottom: 0; }
          .url { display: block; padding: .5rem .75rem; background: var(--bg); border: 1px solid var(--line); border-radius: 6px; font: .9rem/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; overflow-wrap: anywhere; user-select: all; }
          h2 { margin: 0 0 .75rem; font-size: 1.1rem; }
          ol { margin: 0; padding: 0; list-style: none; }
          li { padding: .85rem 0; border-top: 1px solid var(--line); }
          li:first-child { border-top: 0; }
          .t { font-weight: 600; }
          .d { display: block; color: var(--dim); font-size: .85rem; }
          .s { margin: .25rem 0 0; color: var(--dim); }
        </style>
      </head>
      <body>
        <main>
          <h1><xsl:call-template name="text"><xsl:with-param name="value" select="atom:title"/></xsl:call-template></h1>
          <xsl:if test="atom:subtitle">
            <p class="sub"><xsl:call-template name="text"><xsl:with-param name="value" select="atom:subtitle"/></xsl:call-template></p>
          </xsl:if>

          <div class="how">
            <p><strong>This is a news feed, not a web page.</strong> To follow it, copy this address into your feed reader (for example Feedly, NetNewsWire or Inoreader) and it will show you new posts as they appear.</p>
            <xsl:choose>
              <xsl:when test="atom:link[@rel='self']/@href">
                <span class="url"><xsl:value-of select="atom:link[@rel='self'][1]/@href"/></span>
              </xsl:when>
              <xsl:otherwise>
                <p>Copy the address from your browser's address bar.</p>
              </xsl:otherwise>
            </xsl:choose>
            <xsl:if test="starts-with(atom:link[@rel='alternate'][1]/@href, 'http')">
              <p>Prefer to read in the browser? <a href="{atom:link[@rel='alternate'][1]/@href}">Go to the website</a>.</p>
            </xsl:if>
          </div>

          <xsl:if test="atom:entry">
            <h2>Latest posts</h2>
            <ol>
              <xsl:for-each select="atom:entry">
                <li>
                  <xsl:variable name="href" select="atom:link[@rel='alternate'][1]/@href"/>
                  <span class="t">
                    <xsl:choose>
                      <xsl:when test="starts-with($href, 'http')">
                        <a href="{$href}"><xsl:call-template name="text"><xsl:with-param name="value" select="atom:title"/></xsl:call-template></a>
                      </xsl:when>
                      <xsl:otherwise>
                        <xsl:call-template name="text"><xsl:with-param name="value" select="atom:title"/></xsl:call-template>
                      </xsl:otherwise>
                    </xsl:choose>
                  </span>
                  <xsl:if test="atom:published">
                    <span class="d"><xsl:value-of select="substring-before(concat(atom:published, 'T'), 'T')"/></span>
                  </xsl:if>
                  <xsl:if test="atom:summary">
                    <p class="s"><xsl:call-template name="text"><xsl:with-param name="value" select="atom:summary"/></xsl:call-template></p>
                  </xsl:if>
                </li>
              </xsl:for-each>
            </ol>
          </xsl:if>
        </main>
      </body>
    </html>
  </xsl:template>

  <!--
    Titles, subtitles and summaries are type="html": the feed escapes them for
    HTML inside the XML, so an ampersand in a title arrives as the literal text
    "&amp;amp;". XSLT 1.0 cannot decode character references and Firefox ignores
    disable-output-escaping here, so that one case (the only one the site's
    `smartify` leaves behind; it already turns quotes and dashes into real
    characters) is mapped by hand. Anything else shows as-is, which is readable.
  -->
  <xsl:template name="text">
    <xsl:param name="value"/>
    <xsl:call-template name="swap">
      <xsl:with-param name="text" select="string($value)"/>
      <xsl:with-param name="from" select="'&amp;amp;'"/>
      <xsl:with-param name="to" select="'&amp;'"/>
    </xsl:call-template>
  </xsl:template>

  <xsl:template name="swap">
    <xsl:param name="text"/>
    <xsl:param name="from"/>
    <xsl:param name="to"/>
    <xsl:choose>
      <xsl:when test="contains($text, $from)">
        <xsl:value-of select="substring-before($text, $from)"/>
        <xsl:value-of select="$to"/>
        <xsl:call-template name="swap">
          <xsl:with-param name="text" select="substring-after($text, $from)"/>
          <xsl:with-param name="from" select="$from"/>
          <xsl:with-param name="to" select="$to"/>
        </xsl:call-template>
      </xsl:when>
      <xsl:otherwise>
        <xsl:value-of select="$text"/>
      </xsl:otherwise>
    </xsl:choose>
  </xsl:template>
</xsl:stylesheet>
