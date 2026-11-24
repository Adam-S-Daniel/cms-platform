"""Where a new media item goes in its category.

A site lists each media category by `weight`, lowest first, and checks that a
lower weight is never an older date (jodidaniel.com's
test_media_lists_newest_first_within_each_category). The new item goes before
the first item in its category that is strictly older, and that item and
everything after it move down one. Mirrors `placeMedia` in
theme/admin/media-search.js, which does the same for the editor's "Add to site"
path (PR 1121); keep the two in step.
"""

import re

import yaml

MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August",
          "September", "October", "November", "December"]
_FRONT = re.compile(r"\A---\r?\n(.*?)\r?\n---(?:\r?\n|\Z)", re.S)
_WEIGHT_LINE = re.compile(r"\A(---\r?\n(?:.*?\n)??)weight:[^\r\n]*", re.S)


def front_matter(text: str) -> dict:
    """The category, weight and date_display of `text`; {} when unreadable.
    A weight that is not a whole number reads as None, and such an item is
    never moved."""
    m = _FRONT.match(text or "")
    if not m:
        return {}
    try:
        doc = yaml.safe_load(m.group(1))
    except yaml.YAMLError:
        return {}
    if not isinstance(doc, dict):
        return {}
    weight = doc.get("weight")
    return {
        "category": doc.get("category"),
        "date_display": doc.get("date_display"),
        "weight": weight if isinstance(weight, int) and not isinstance(weight, bool) else None,
    }


def date_key(display) -> tuple[int, int | None] | None:
    """(year, month) for "May 2026", (year, None) for "2026", else None."""
    s = str(display or "").strip()
    if re.fullmatch(r"\d{4}", s):
        return int(s), None
    m = re.fullmatch(r"([A-Z][a-z]+) (\d{4})", s)
    if m and m.group(1) in MONTHS:
        return int(m.group(2)), MONTHS.index(m.group(1)) + 1
    return None


def older_than(a, b) -> bool:
    """True when `a` is strictly older than `b`; a bare year compares on the year."""
    if a[0] != b[0]:
        return a[0] < b[0]
    if a[1] is None or b[1] is None:
        return False
    return a[1] < b[1]


def with_weight(text: str, weight: int) -> str:
    return _WEIGHT_LINE.sub(lambda m: f"{m.group(1)}weight: {weight}", text, count=1)


def place_media(content: str, siblings: list[tuple[str, str]]) -> tuple[str, list[tuple[str, str]]]:
    """`content` is the new entry; `siblings` is [(path, content)] for every
    item already in the folder. Returns the entry's content with its weight
    set and [(path, content)] for each item that moves down."""
    fm = front_matter(content)
    key = date_key(fm.get("date_display"))
    peers = sorted(
        ((path, text, front_matter(text)) for path, text in siblings),
        key=lambda p: p[2].get("weight") if p[2].get("weight") is not None else 0)
    peers = [p for p in peers
             if p[2].get("category") == fm.get("category") and p[2].get("weight") is not None]
    if not peers or fm.get("weight") is None:
        return content, []
    weight = None
    if key:
        for _, _, pfm in peers:
            k = date_key(pfm.get("date_display"))
            if k and older_than(k, key):
                weight = pfm["weight"]
                break
    if weight is None:
        return with_weight(content, peers[-1][2]["weight"] + 1), []
    moves = [(path, with_weight(text, pfm["weight"] + 1))
             for path, text, pfm in peers if pfm["weight"] >= weight]
    return with_weight(content, weight), moves
