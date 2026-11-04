"""The candidate record an LLM proposes, its JSON Schema, and code-side validation."""

import calendar
import re
from dataclasses import dataclass, field
from datetime import date

from .domains import normalize_url

KINDS = ("upcoming_talk", "past_talk", "podcast", "press", "authored_article",
         "brief_testimony")
TALK_KINDS = ("upcoming_talk", "past_talk")

TITLE_MAX = 300
QUOTE_MAX = 600
REASONING_MAX = 1500
SUPPORTING_MAX = 8

_DATE_RE = re.compile(r"^\d{4}-\d{2}(-\d{2})?$")


@dataclass
class Candidate:
    kind: str
    title: str
    outlet: str
    date: str
    primary_url: str
    end_date: str | None = None
    location: str | None = None
    session: str | None = None
    supporting_urls: list[str] = field(default_factory=list)
    evidence: list[dict] = field(default_factory=list)
    reasoning: str = ""


def _str(max_len=None, nullable=False, **extra):
    schema = {"type": ["string", "null"] if nullable else "string", **extra}
    if max_len:
        schema["maxLength"] = max_len
    return schema


_CANDIDATE_PROPS = {
    "kind": {"type": "string", "enum": list(KINDS)},
    "title": _str(TITLE_MAX),
    "outlet": _str(200),
    "date": _str(10),
    "end_date": _str(10, nullable=True),
    "location": _str(200, nullable=True),
    "session": _str(300, nullable=True),
    "primary_url": _str(2000),
    "supporting_urls": {"type": "array", "items": _str(2000), "maxItems": SUPPORTING_MAX},
    "evidence": {
        "type": "array",
        "items": {
            "type": "object",
            "properties": {"url": _str(2000), "quote": _str(QUOTE_MAX)},
            "required": ["url", "quote"],
            "additionalProperties": False,
        },
    },
    "reasoning": _str(REASONING_MAX),
}

CANDIDATES_JSON_SCHEMA = {
    "type": "object",
    "properties": {
        "candidates": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": _CANDIDATE_PROPS,
                "required": list(_CANDIDATE_PROPS),
                "additionalProperties": False,
            },
        },
    },
    "required": ["candidates"],
    "additionalProperties": False,
}


def parse_date(value: str, *, end_of_month: bool = False) -> date:
    """YYYY-MM-DD or YYYY-MM (first or last day of that month); ValueError if invalid."""
    if not isinstance(value, str) or not _DATE_RE.match(value):
        raise ValueError(f"bad date {value!r}")
    parts = [int(p) for p in value.split("-")]
    if len(parts) == 3:
        return date(*parts)
    last = calendar.monthrange(parts[0], parts[1])[1]
    return date(parts[0], parts[1], last if end_of_month else 1)


def _opt_str(obj: dict, key: str) -> str | None:
    v = obj.get(key)
    if v is None:
        return None
    if not isinstance(v, str):
        raise ValueError(f"{key} must be a string")
    return v.strip() or None


def _url(v) -> str:
    if not isinstance(v, str):
        raise ValueError("URL must be a string")
    normalize_url(v)  # raises ValueError unless http(s) with a host
    return v.strip()


def _one(obj) -> Candidate:
    if not isinstance(obj, dict):
        raise ValueError("candidate is not an object")
    kind = obj.get("kind")
    if kind not in KINDS:
        raise ValueError(f"bad kind {kind!r}")
    title = obj.get("title")
    if not isinstance(title, str) or not title.strip():
        raise ValueError("empty title")
    title = title.strip()
    if len(title) > TITLE_MAX:
        raise ValueError("title too long")
    outlet = obj.get("outlet")
    if not isinstance(outlet, str):
        raise ValueError("outlet must be a string")
    parse_date(obj.get("date"))
    end_date = _opt_str(obj, "end_date")
    if end_date is not None:
        if len(end_date) != 10:
            raise ValueError(f"bad end_date {end_date!r}")
        parse_date(end_date)
    supporting = obj.get("supporting_urls") or []
    if not isinstance(supporting, list):
        raise ValueError("supporting_urls must be a list")
    evidence = []
    for item in obj.get("evidence") or []:
        if not isinstance(item, dict) or not isinstance(item.get("quote"), str):
            raise ValueError("bad evidence item")
        evidence.append({"url": _url(item.get("url")), "quote": item["quote"][:QUOTE_MAX]})
    reasoning = obj.get("reasoning") or ""
    if not isinstance(reasoning, str):
        raise ValueError("reasoning must be a string")
    return Candidate(
        kind=kind, title=title, outlet=outlet.strip(), date=obj["date"],
        end_date=end_date, location=_opt_str(obj, "location"),
        session=_opt_str(obj, "session"), primary_url=_url(obj.get("primary_url")),
        supporting_urls=[_url(u) for u in supporting][:SUPPORTING_MAX],
        evidence=evidence, reasoning=reasoning[:REASONING_MAX],
    )


def parse_candidates(obj) -> tuple[list[Candidate], list[str]]:
    """Valid candidates plus a human-readable reason for each one dropped."""
    items = obj.get("candidates") if isinstance(obj, dict) else None
    if not isinstance(items, list):
        return [], ["response has no candidates list"]
    good: list[Candidate] = []
    drops: list[str] = []
    for i, item in enumerate(items):
        try:
            good.append(_one(item))
        except ValueError as exc:
            drops.append(f"candidate {i}: {exc}")
    return good, drops
