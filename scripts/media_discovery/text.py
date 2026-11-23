"""Text normalization shared by the identity, corroboration and dedupe checks."""

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


class _TitleExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self._inside = False
        self.done = False

    def handle_starttag(self, tag, attrs):
        if tag == "title" and not self.done:
            self._inside = True

    def handle_endtag(self, tag):
        if tag == "title" and self._inside:
            self._inside, self.done = False, True

    def handle_data(self, data):
        if self._inside:
            self.parts.append(data)


def html_title(html: str) -> str:
    """The text of the page's first <title>, or "" (never raises)."""
    parser = _TitleExtractor()
    try:
        parser.feed(html)
        parser.close()
    except Exception:  # noqa: BLE001 - a malformed page just has no title
        return ""
    return clean_title("".join(parser.parts))
