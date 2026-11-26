"""The run's results file: findings.json, as the /admin "New mentions" page reads it.

Pure functions, no I/O. `build_finding` turns one verified candidate into the
page's finding shape; `merge_results` folds a run into the previous file so a
find is listed (and emailed) once, however many weeks the search sees it.
Schema (theme/admin/media-search.js reads it, decisions.json beside it):

    {"version": 1, "searched_at": ISO, "person": str, "findings": [
      {"id", "status": "confirmed"|"unconfirmed", "kind", "title", "outlet",
       "date", "end_date", "primary_url", "other_urls": [...],
       "sources": [{"url", "author"?, "excerpt"?}],
       "reasons": [{"url", "main", "code", "detail", "text", "title"?, "whole"?}],
       "entry": {"collection", "slug", "path", "content"} | null,
       "first_seen": ISO, "last_seen": ISO}]}
"""

import hashlib

from .domains import normalize_url
from .render import WHOLE_PROBLEMS, problem_text

VERSION = 1


def finding_id(primary_url: str) -> str:
    """A stable id for a find: 16 hex digits of the SHA-256 of its normalized
    primary URL (the stripped URL itself when it cannot be normalized)."""
    try:
        key = normalize_url(primary_url)
    except ValueError:
        key = str(primary_url).strip()
    return hashlib.sha256(key.encode("utf-8")).hexdigest()[:16]


def _reasons(candidate, problems, titles, person: str) -> list[dict]:
    out = []
    for prob in problems:
        if not prob.url:
            out.append({"url": "", "main": False, "code": prob.code, "detail": prob.detail,
                        "text": WHOLE_PROBLEMS.get(prob.code, "It could not be confirmed."),
                        "whole": True})
            continue
        text = problem_text(prob, person)
        if text is None:
            continue
        main = prob.url == candidate.primary_url
        reason = {"url": prob.url, "main": main, "code": prob.code, "detail": prob.detail,
                  "text": text}
        title = (titles or {}).get(prob.url, "")
        if not main and title:
            reason["title"] = title
        out.append(reason)
    return out


def _sources(candidate, notes) -> list[dict]:
    """Each source URL, main one first, that has an author or an excerpt."""
    out = []
    for url in dict.fromkeys([candidate.primary_url, *candidate.supporting_urls]):
        note = (notes or {}).get(url)
        if note is None:
            continue
        item = {"url": url}
        if note.author:
            item["author"] = note.author
        if note.excerpt:
            item["excerpt"] = note.excerpt
        if len(item) > 1:
            out.append(item)
    return out


def build_finding(candidate, kind: str, status: str, problems, entry, titles, person: str,
                  notes=None) -> dict:
    """One finding, without its first_seen/last_seen (merge_results stamps them).
    `titles` maps a source URL to its page title and `notes` to its
    corroborate.SourceNote; `entry` is a render.Entry or None. A confirmed find
    carries no reasons."""
    return {
        "id": finding_id(candidate.primary_url),
        "status": status,
        "kind": kind,
        "title": candidate.title,
        "outlet": candidate.outlet,
        "date": candidate.date,
        "end_date": candidate.end_date,
        "primary_url": candidate.primary_url,
        "other_urls": list(candidate.supporting_urls),
        "sources": _sources(candidate, notes),
        "reasons": [] if status == "confirmed" else _reasons(candidate, problems, titles, person),
        "entry": None if entry is None else {
            "collection": entry.collection, "slug": entry.slug, "path": entry.path,
            "content": entry.content},
    }


def _decided(decisions_doc) -> set[str]:
    decisions = decisions_doc.get("decisions") if isinstance(decisions_doc, dict) else None
    return set(decisions) if isinstance(decisions, dict) else set()


def merge_results(prior, decisions_doc, run_findings, *, now: str, person: str,
                  touched=()) -> tuple[dict, list[dict]]:
    """(the new findings document, the findings that are NEW for the email).

    - an id not in `prior` is added and emailed;
    - one already confirmed, or decided in decisions.json, only gets a new
      last_seen;
    - one unconfirmed before and still unconfirmed has its reasons and entry
      refreshed and is not emailed;
    - one unconfirmed before and confirmed now (and undecided) is upgraded and
      emailed as ready;
    - prior findings the run did not see stay as they were. `touched` names
      ids the run saw without re-checking (skipped as repeats): last_seen only.
    """
    findings = [dict(f) for f in (prior or {}).get("findings", []) if isinstance(f, dict)]
    index = {f.get("id"): f for f in findings}
    decided = _decided(decisions_doc)
    new: list[dict] = []

    ordered: dict[str, dict] = {}
    for f in run_findings:  # one entry per id; a confirmed one wins
        have = ordered.get(f["id"])
        if have is None or (have["status"] != "confirmed" and f["status"] == "confirmed"):
            ordered[f["id"]] = f

    for fid in touched:
        if fid in index and fid not in ordered:
            index[fid]["last_seen"] = now

    for fid, f in ordered.items():
        have = index.get(fid)
        if have is None:
            added = {**f, "first_seen": now, "last_seen": now}
            findings.append(added)
            index[fid] = added
            new.append(added)
            continue
        have["last_seen"] = now
        if fid in decided or have.get("status") == "confirmed":
            continue
        if f["status"] == "confirmed":
            have.update(status="confirmed", entry=f["entry"], reasons=f["reasons"],
                        kind=f["kind"], sources=f["sources"])
            new.append(have)
        else:
            have.update(reasons=f["reasons"], entry=f["entry"], sources=f["sources"])

    doc = {"version": VERSION, "searched_at": now, "person": person, "findings": findings}
    return doc, new
