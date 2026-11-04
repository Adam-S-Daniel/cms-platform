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
