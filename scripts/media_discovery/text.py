"""Text normalization shared by the identity, corroboration and dedupe checks."""

import json
import re
import unicodedata
from html.parser import HTMLParser

_PUNCT_MAP = str.maketrans({
    "‘": "'", "’": "'", "‚": "'", "‛": "'",
    "“": '"', "”": '"', "„": '"', "‟": '"',
    "‐": "-", "‑": "-", "‒": "-", "–": "-",
    "—": "-", "―": "-", "−": "-",
})


def normalize(s: str) -> str:
    """NFKC, ASCII quotes and dashes, casefolded, whitespace collapsed."""
    s = unicodedata.normalize("NFKC", s).translate(_PUNCT_MAP)
    return " ".join(s.casefold().split())


_SKIP_TAGS = {"script", "style", "noscript"}
_BLOCK_TAGS = {
    "p", "div", "br", "li", "ul", "ol", "tr", "td", "th", "table", "section",
    "article", "header", "footer", "h1", "h2", "h3", "h4", "h5", "h6",
    "blockquote", "pre", "hr", "title",
}


class _TextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self._skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in _SKIP_TAGS:
            self._skip += 1
        elif tag in _BLOCK_TAGS:
            self.parts.append("\n")

    def handle_startendtag(self, tag, attrs):
        if tag in _BLOCK_TAGS:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in _SKIP_TAGS:
            self._skip = max(0, self._skip - 1)
        elif tag in _BLOCK_TAGS:
            self.parts.append("\n")

    def handle_data(self, data):
        if not self._skip:
            self.parts.append(data)


def html_to_text(html: str) -> str:
    """Visible text of an HTML page; entities decoded, block tags become newlines."""
    parser = _TextExtractor()
    parser.feed(html)
    parser.close()
    text = re.sub(r"[ \t\r\f\v]+", " ", "".join(parser.parts))
    lines = (line.strip() for line in text.split("\n"))
    return "\n".join(line for line in lines if line)


TITLE_MAX = 200


def clean_title(raw) -> str:
    """A page title on one line, whitespace collapsed, capped. The text is
    untrusted and kept raw otherwise; the admin page prints it as text."""
    return " ".join(str(raw or "").split())[:TITLE_MAX].rstrip()


AUTHOR_MAX = 120
MAX_AUTHORS = 3
# <meta> names and properties that carry a byline, best first.
_AUTHOR_META = ("author", "article:author", "byl", "parsely-author", "sailthru.author",
                "dc.creator", "citation_author")
_BY_PREFIX = re.compile(r"^\s*by\s+", re.IGNORECASE)


def clean_author(raw) -> str:
    """One byline on one line, without a leading "By", capped; "" for a web
    address (article:author is often a profile URL) or anything empty. Untrusted
    and kept raw otherwise: each output escapes it for its own context."""
    text = _BY_PREFIX.sub("", " ".join(str(raw or "").split()))
    if not text or re.match(r"^[a-z][a-z0-9+.-]*://", text, re.IGNORECASE):
        return ""
    return text[:AUTHOR_MAX].rstrip()


def _ld_authors(node, out: list[str], depth: int = 0) -> None:
    """Author names from a JSON-LD value: {"author": {"name": ...}} or a list,
    inside an @graph or not."""
    if depth > 4:
        return
    if isinstance(node, list):
        for item in node[:20]:
            _ld_authors(item, out, depth + 1)
    elif isinstance(node, dict):
        author = node.get("author") or node.get("creator")
        for a in author if isinstance(author, list) else [author]:
            if isinstance(a, str):
                out.append(a)
            elif isinstance(a, dict) and isinstance(a.get("name"), str):
                out.append(a["name"])
        if "@graph" in node:
            _ld_authors(node["@graph"], out, depth + 1)


class _HeadExtractor(HTMLParser):
    """The first <title>, byline <meta> tags and JSON-LD blocks of a page."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self._inside = False
        self.done = False
        self.meta: dict[str, list[str]] = {}
        self.ld: list[str] = []
        self._ld: list[str] | None = None

    def handle_starttag(self, tag, attrs):
        if tag == "title" and not self.done:
            self._inside = True
        elif tag == "meta":
            a = {k.lower(): v for k, v in attrs if k and v is not None}
            key = (a.get("name") or a.get("property") or "").strip().lower()
            if key in _AUTHOR_META and a.get("content"):
                self.meta.setdefault(key, []).append(a["content"])
        elif tag == "script":
            a = {k.lower(): (v or "") for k, v in attrs if k}
            if a.get("type", "").strip().lower() == "application/ld+json":
                self._ld = []

    def handle_startendtag(self, tag, attrs):
        if tag == "meta":
            self.handle_starttag(tag, attrs)

    def handle_endtag(self, tag):
        if tag == "title" and self._inside:
            self._inside, self.done = False, True
        elif tag == "script" and self._ld is not None:
            self.ld.append("".join(self._ld))
            self._ld = None

    def handle_data(self, data):
        if self._inside:
            self.parts.append(data)
        elif self._ld is not None:
            self._ld.append(data)

    def authors(self) -> str:
        raw: list[str] = []
        for key in _AUTHOR_META:
            raw += self.meta.get(key, [])
        if not any(clean_author(r) for r in raw):
            for block in self.ld[:10]:
                try:
                    _ld_authors(json.loads(block), raw)
                except (ValueError, RecursionError):
                    continue
        names = list(dict.fromkeys(a for a in (clean_author(r) for r in raw) if a))
        return clean_author(", ".join(names[:MAX_AUTHORS]))


def _head(html: str) -> _HeadExtractor | None:
    parser = _HeadExtractor()
    try:
        parser.feed(html)
        parser.close()
    except Exception:  # noqa: BLE001 - a malformed page just has no title or author
        return None
    return parser


def html_title(html: str) -> str:
    """The text of the page's first <title>, or "" (never raises)."""
    parser = _head(html)
    return clean_title("".join(parser.parts)) if parser else ""


def html_author(html: str) -> str:
    """The page's listed author(s), from its byline <meta> tags or else its
    JSON-LD, up to three joined with ", "; "" when none is listed (never raises)."""
    parser = _head(html)
    return parser.authors() if parser else ""
