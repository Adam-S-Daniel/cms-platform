"""Decide whether a page is about the configured person."""

import re
from dataclasses import dataclass, field

from .config import PersonConfig


@dataclass(frozen=True)
class IdentityResult:
    ok: bool
    reason: str
    name_matches: list[str] = field(default_factory=list)
    marker: str | None = None
    exclusion: str | None = None
    snippet: str | None = None


def _phrase_regex(phrase: str, flags: int = 0) -> re.Pattern:
    """Whole-word, whitespace-flexible match; periods and other punctuation literal."""
    body = r"\s+".join(re.escape(tok) for tok in phrase.split())
    return re.compile(r"(?<!\w)" + body + r"(?!\w)", flags)


def _marker_regex(marker: str) -> re.Pattern:
    # An all-uppercase marker (an acronym such as ODP) is case-sensitive.
    return _phrase_regex(marker, 0 if marker.isupper() else re.IGNORECASE)


def _near(span: tuple[int, int], hit: re.Match, window: int) -> bool:
    return hit.start() < span[1] + window and hit.end() > span[0] - window


def _first_near(span, hits, window):
    for marker, match in hits:
        if _near(span, match, window):
            return marker
    return None


def _snippet(text: str, span: tuple[int, int], width: int = 240) -> str:
    """About `width` characters of the page around the name, cut at whole words,
    with an ellipsis where the page goes on."""
    pad = max(0, (width - (span[1] - span[0])) // 2)
    start, end = max(0, span[0] - pad), min(len(text), span[1] + pad)
    if start > 0 and not text[start - 1].isspace():
        cut = re.search(r"\s", text[start:span[0]])  # drop a word cut in half,
        start = start + cut.end() if cut else start  # never the name itself
    if end < len(text) and not text[end].isspace():
        cut = re.search(r"\s\S*$", text[span[1]:end])
        end = span[1] + cut.start() if cut else end
    out = " ".join(text[start:end].split())
    if start > 0:
        out = "\u2026" + out
    if end < len(text):
        out += "\u2026"
    return out


def check_identity(page_text: str, cfg: PersonConfig) -> IdentityResult:
    spans: list[tuple[int, int]] = []
    names: list[str] = []
    for name in cfg.names:
        for m in _phrase_regex(name, re.IGNORECASE).finditer(page_text):
            spans.append(m.span())
            names.append(m.group(0))
    if not spans:
        return IdentityResult(False, "no-name")

    markers = [(mk, m) for mk in cfg.identity_markers
               for m in _marker_regex(mk).finditer(page_text)]
    exclusions = [(ex, m) for ex in cfg.exclusion_markers
                  for m in _marker_regex(ex).finditer(page_text)]

    excluded_by = None
    for span in sorted(spans):
        exclusion = _first_near(span, exclusions, cfg.near_chars)
        if exclusion:
            excluded_by = excluded_by or exclusion
            continue
        marker = _first_near(span, markers, cfg.near_chars)
        if marker:
            return IdentityResult(True, "ok", names, marker, None,
                                  _snippet(page_text, span))
    if excluded_by and all(_first_near(s, exclusions, cfg.near_chars) for s in spans):
        return IdentityResult(False, "exclusion", names, None, excluded_by)
    return IdentityResult(False, "no-identity-marker", names)
