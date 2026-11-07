"""python3 -m media_discovery run --site-root DIR --repo OWNER/NAME --mode {email-only,live}

One discovery run: ask Claude for candidates, re-fetch and corroborate each,
open one Decap editorial-workflow PR per confirmed find (live mode) and email
one digest. See docs/MEDIA-DISCOVERY.md.

The repository and its Actions logs are public, so everything this prints is
a count or a fixed message: never a title, name, URL, quote or address. Those
go only into the PRs (written by safe_md) and the emailed digest.
"""

import argparse
import os
import sys
from datetime import date
from email.utils import getaddresses
from pathlib import Path

from . import llm
from .config import ConfigError, load_config
from .corroborate import effective_kind, verify
from .dedupe import is_duplicate, load_existing
from .domains import normalize_url
from .fetch import fetch
from .github_api import GitHub, GitHubError
from .mailer import send_digest
from .render import render_digest, render_entry, render_pr

CONFIG_PATH = ".github/media-discovery.yml"
LABELS = ["decap-cms/pending_review", "media-discovery"]
SMTP_PORT = 465
DEFAULT_SMTP_HOST = "smtp.fastmail.com"
MODES = ("email-only", "live")


def _single_address(value: str) -> str | None:
    """The one plain address in `value`, or None when it is not exactly one."""
    found = getaddresses([value])
    if len(found) != 1 or "," in value:
        return None
    address = found[0][1].strip()
    local, _, domain = address.partition("@")
    if not local or not domain or "@" in domain or any(c.isspace() for c in address):
        return None
    return address


def _split(value: str | None) -> list[str]:
    return [p.strip() for p in (value or "").split(",") if p.strip()]


def _describe(exc: BaseException) -> str:
    """Exception class and HTTP status only: messages can quote a response."""
    status = getattr(exc, "status_code", None) or getattr(exc, "status", None)
    return f"{type(exc).__name__}, HTTP {status}" if status else type(exc).__name__


def _urls(candidate) -> set[str]:
    out = set()
    for url in [candidate.primary_url, *candidate.supporting_urls]:
        try:
            out.add(normalize_url(url))
        except ValueError:
            pass
    return out


def _parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="python3 -m media_discovery")
    sub = p.add_subparsers(dest="command", required=True)
    run = sub.add_parser("run", help="run one discovery pass")
    run.add_argument("--site-root", required=True, type=Path)
    run.add_argument("--repo", required=True, help="OWNER/NAME of the site repository")
    run.add_argument("--mode", required=True, choices=MODES)
    run.add_argument("--today", type=date.fromisoformat, help="YYYY-MM-DD (default: today)")
    run.add_argument("--no-email", action="store_true", help="do not send the digest")
    return p


def main(argv=None, *, env=None, client_factory=llm.default_client, fetcher=fetch,
         github_factory=GitHub, send=send_digest, out=None) -> int:
    args = _parser().parse_args(argv)
    env = os.environ if env is None else env
    out = out or sys.stdout

    def say(line: str) -> None:
        print(line, file=out, flush=True)

    owner, _, name = args.repo.partition("/")
    if not owner or not name or "/" in name:
        say("::error::--repo must be OWNER/NAME")
        return 2

    cfg_file = args.site_root / CONFIG_PATH
    if not cfg_file.is_file():
        say(f"::notice::media discovery is not configured for this site (no {CONFIG_PATH}); "
            "nothing to do")
        return 0
    try:
        cfg = load_config(cfg_file.read_text(encoding="utf-8"))
    except ConfigError as exc:
        say(f"::error::{CONFIG_PATH} is invalid: {exc}")
        return 1

    api_key = env.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        say("::notice::media discovery is configured but ANTHROPIC_API_KEY is empty: add the "
            "ANTHROPIC_API_KEY repository secret (the caller passes it as anthropic_api_key); "
            "skipping this run")
        return 0

    today = args.today or date.today()
    mode = args.mode
    token = env.get("GITHUB_TOKEN", "")
    if mode == "live" and not token:
        say("::notice::live mode needs GITHUB_TOKEN (the PR-writing App token); "
            "running email-only")
        mode = "email-only"
    gh = github_factory(token) if token else None
    reviewers = _split(env.get("MEDIA_DISCOVERY_REVIEWERS"))
    admin_url = env.get("MEDIA_DISCOVERY_ADMIN_URL", "").strip()
    review_link = (admin_url.rstrip("/") + "/#/workflow" if admin_url
                   else f"https://github.com/{args.repo}/pulls?q=is%3Aopen+label%3Amedia-discovery")
    site_name = env.get("MEDIA_DISCOVERY_SITE_NAME", "").strip() or name

    existing = load_existing(args.site_root, cfg)
    if gh is None:
        say("::notice::no GITHUB_TOKEN: earlier discovery PRs are not checked for duplicates")
        prior = set()
    else:
        try:
            prior = gh.prior_pr_urls(args.repo)
        except GitHubError as exc:
            if mode == "live":
                say(f"::error::{exc}")
                return 1
            # Email-only writes nothing, so a token that cannot list PRs costs
            # at most a repeated line in the email, not a red weekly run.
            say(f"::notice::earlier discovery PRs could not be listed ({exc}); "
                "continuing without that duplicate check")
            prior = set()

    try:
        candidates, notes = llm.find_candidates(cfg, existing, today, client_factory(api_key))
    except Exception as exc:  # noqa: BLE001 - reported without its message
        say(f"::error::the Claude API request failed ({_describe(exc)})")
        return 1
    for note in notes:
        if note in llm.OUTCOME_NOTES:
            say(f"::warning::{note}")
    dropped = sum(1 for n in notes if n not in llm.OUTCOME_NOTES)

    seen = set(prior)
    counts = dict(duplicates=0, confirmed=0, prs_opened=0, unconfirmed=0)
    new_prs, would_open, unconfirmed = [], [], []
    failure = None
    reviewer_misses = 0
    for cand in candidates:
        if is_duplicate(cand, existing, seen):
            counts["duplicates"] += 1
            continue
        try:
            kind = effective_kind(cand, today)
            urls = list(dict.fromkeys([cand.primary_url, *cand.supporting_urls]))
            verdict = verify(cand, {u: fetcher(u) for u in urls}, cfg)
            if not verdict.confirmed:
                unconfirmed.append((cand, verdict.reasons))
                continue
            try:
                entry = render_entry(cand, kind, cfg)
            except ValueError as exc:
                unconfirmed.append((cand, [f"confirmed, but it cannot become an entry: {exc}"]))
                continue
        except Exception:  # noqa: BLE001 - one bad candidate must not end the run; no text logged
            unconfirmed.append((cand, ["internal error while checking"]))
            continue
        seen |= _urls(cand)
        counts["confirmed"] += 1
        if mode != "live":
            would_open.append((cand, entry))
            continue
        title, body = render_pr(cand, kind, entry, verdict, review_link)
        try:
            opened = gh.open_entry_pr(args.repo, entry, title, body, LABELS, reviewers)
        except GitHubError as exc:
            failure = failure or str(exc)
            unconfirmed.append((cand, [f"confirmed, but the pull request could not be opened "
                                       f"(HTTP {exc.status})"]))
            continue
        if opened is None:
            counts["duplicates"] += 1
            continue
        counts["prs_opened"] += 1
        reviewer_misses += not opened.reviewers_requested
        new_prs.append((title, opened.url, review_link))
    counts["unconfirmed"] = len(unconfirmed)

    say(f"media-discovery: mode={mode} candidates={len(candidates)} dropped={dropped} "
        + " ".join(f"{k}={v}" for k, v in counts.items()))
    if reviewer_misses:
        say(f"::warning::{reviewer_misses} pull request(s) opened without the requested reviewers "
            "(check MEDIA_DISCOVERY_REVIEWERS: each must be a collaborator)")

    digest = render_digest(site_name, new_prs, unconfirmed, would_open)
    if digest is None:
        say("media-discovery: nothing new; no email")
    elif args.no_email:
        say("media-discovery: --no-email set; digest not sent")
    else:
        knobs = {"MEDIA_DISCOVERY_SMTP_USER": env.get("MEDIA_DISCOVERY_SMTP_USER", ""),
                 "MEDIA_DISCOVERY_SMTP_PASSWORD": env.get("MEDIA_DISCOVERY_SMTP_PASSWORD", ""),
                 "MEDIA_DISCOVERY_MAIL_TO": env.get("MEDIA_DISCOVERY_MAIL_TO", "")}
        missing = [k for k, v in knobs.items() if not v.strip()]
        recipients = _split(knobs["MEDIA_DISCOVERY_MAIL_TO"])
        if missing or not recipients:
            say("::notice::digest not emailed: set " + ", ".join(missing or
                ["MEDIA_DISCOVERY_MAIL_TO"]) + " (repository secrets)")
        else:
            smtp_user = knobs["MEDIA_DISCOVERY_SMTP_USER"].strip()
            mail_from = smtp_user
            requested_from = env.get("MEDIA_DISCOVERY_MAIL_FROM", "").strip()
            if requested_from:
                valid_from = _single_address(requested_from)
                if valid_from:
                    mail_from = valid_from
                else:
                    say("::warning::MEDIA_DISCOVERY_MAIL_FROM is not a single email address; "
                        "sending from the SMTP login")
            try:
                send(*digest, host=env.get("MEDIA_DISCOVERY_SMTP_HOST", "").strip()
                     or DEFAULT_SMTP_HOST, port=SMTP_PORT,
                     user=smtp_user,
                     password=knobs["MEDIA_DISCOVERY_SMTP_PASSWORD"],
                     mail_from=mail_from, mail_to=recipients)
            except Exception as exc:  # noqa: BLE001 - SMTP errors can quote addresses
                say(f"::error::sending the digest failed ({_describe(exc)})")
                return 1
            say(f"media-discovery: digest emailed to {len(recipients)} recipient(s)")

    if failure:
        say(f"::error::{failure}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
