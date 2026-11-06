#!/usr/bin/env python3
"""Email-to-draft: turn an email the site owner sends to a secret address into a Decap draft.

Design. A poller fires `repository_dispatch` with a Fastmail JMAP email id; the site's workflow
checks the site out at the workspace root and this platform at `.cms-platform/`, then runs
`email_draft.py process`. The script reads `_config.yml` (`cms.email_drafts.enabled`, `url`,
`timezone`), fetches the raw message over JMAP, verifies the sender (verify.py), skips an email
already drafted (a sha256 of its Message-ID is stamped into the pull request body), builds the post
(draft.py: Decap's own file name, front matter, body, images) and opens an editorial-workflow draft
exactly as Decap would (github_draft.py: `cms/posts/<entry>` branch, Decap's body marker,
`decap-cms/draft` label). It never merges or adds a publish label: nothing goes live until the
owner selects Publish in /admin. It replies over JMAP and files the email under `Processed` or
`Failed` beside the mailbox it arrived in. `notify-failure` is the workflow's `if: failure()`
fallback for a crash before `process` could reply.

Threat model. The posting address is a secret, but secrets leak, so it is not the credential.
The credential is the owner's domain's DKIM signature, verified here with dkimpy and cross-checked
against the Authentication-Results Fastmail's own servers prepend (lower ones are sender-written
and ignored). The signature must cover From, To, Subject and Date and the posting address must sit
in a signed To/Cc line, so an old signed email replayed to the posting address fails; Date must
be fresh. Every reply goes ONLY to the configured owner address, never to From or Reply-To, so a
spoofed message warns the owner instead of sending backscatter to a forged address. Logs are
public on a public repo: they carry only step names, check names, counts, HTTP statuses and error
class names, never an address, subject, body, header, token or API response body.
"""

from __future__ import annotations

import argparse
import dataclasses
import datetime
import email.policy
import email.utils
import hashlib
import os
import sys
import zoneinfo
from email.parser import BytesParser
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent))

import draft  # noqa: E402
import github_draft  # noqa: E402
import jmap  # noqa: E402
import verify  # noqa: E402

PROCESSED = "Processed"
FAILED = "Failed"
REQUIRED_ENV = (
    "FASTMAIL_API_TOKEN",
    "EMAIL_DRAFT_ADDRESS",
    "EMAIL_DRAFT_SENDER",
    "GH_TOKEN",
    "GITHUB_REPOSITORY",
)

NEXT_STEPS = {
    "config": "The site's settings need attention; ask whoever maintains the site.",
    "fastmail-api": "Fastmail could not be reached or refused a request. Send the email again "
    "in a few minutes.",
    "verification": "Send the post again from your own address, with the posting address in the "
    "To line. Do not forward or resend an older email.",
    "content": "Fix the email as described above and send it again.",
    "github-api": "GitHub could not be reached or refused a request. Send the email again in a "
    "few minutes; if it keeps failing, ask whoever maintains the site.",
    "reply": "The draft may exist; check /admin before sending again.",
    "workflow": "Send the email again in a few minutes; if it keeps failing, ask whoever "
    "maintains the site.",
}


def log(message: str, out=None) -> None:
    """The only way this script writes to the log. Callers pass only safe tokens."""
    print(f"email-draft: {message}", file=out or sys.stdout, flush=True)


class StepError(Exception):
    """A failed step. `category` and `cause` (a class name) are loggable; `detail` is not."""

    def __init__(self, category: str, detail: str, cause: str = ""):
        super().__init__(category)
        self.category = category
        self.detail = detail
        self.cause = cause


@dataclasses.dataclass
class Config:
    enabled: bool
    url: str
    tz: datetime.tzinfo


def load_config(site_root: Path) -> Config:
    try:
        data = yaml.safe_load((site_root / "_config.yml").read_text(encoding="utf-8")) or {}
        cms = data.get("cms") or {}
        enabled = bool(((cms.get("email_drafts") or {}).get("enabled")) is True)
        url = str(data.get("url") or "").rstrip("/")
        tz = zoneinfo.ZoneInfo(str(data.get("timezone") or "UTC"))
    except (
        OSError,
        yaml.YAMLError,
        AttributeError,
        zoneinfo.ZoneInfoNotFoundError,
        ValueError,
    ) as exc:
        msg = "The site's _config.yml could not be read."
        raise StepError("config", msg, type(exc).__name__) from exc
    if enabled and not url:
        raise StepError("config", "The site's _config.yml has no url.", "MissingUrl")
    return Config(enabled, url, tz)


def message_hash(message_id: str) -> str:
    return hashlib.sha256(message_id.strip().encode("utf-8")).hexdigest()


def run_url(env) -> str:
    server = env.get("GITHUB_SERVER_URL", "https://github.com").rstrip("/")
    repo, run_id = env.get("GITHUB_REPOSITORY", ""), env.get("GITHUB_RUN_ID", "")
    return f"{server}/{repo}/actions/runs/{run_id}" if repo and run_id else "(run link unavailable)"


def reply_subject(subject: str) -> str:
    subject = " ".join((subject or "").split())
    if not subject:
        return "Re: your email-to-draft message"
    return subject if subject.lower().startswith("re:") else f"Re: {subject}"


def success_text(post: draft.Post, link: str) -> str:
    lines = [
        "Your email is now a draft post.",
        "",
        f"Title: {post.title}",
        f"Draft: {link}",
        "",
        "Sign in there, edit it if you like, then select Publish. To discard it, open the entry "
        "and select Delete.",
    ]
    if post.image_paths:
        lines += ["", "Images included:"] + [f"- {p}" for p in post.image_paths]
    if post.skipped_attachments:
        lines += ["", "Attachments not included (only JPEG, PNG, GIF and WebP images are):"]
        lines += [f"- {name}" for name in post.skipped_attachments]
    return "\n".join(lines) + "\n"


def failure_text(category: str, reasons: list[str], env) -> str:
    lines = [f"Your email did not become a draft post ({category}).", "", "What failed:"]
    lines += [f"- {r}" for r in reasons] or ["- An unexpected error."]
    lines += [
        "",
        "What to do next:",
        NEXT_STEPS.get(category, NEXT_STEPS["github-api"]),
        "",
        f"Run log: {run_url(env)}",
    ]
    return "\n".join(lines) + "\n"


def _send(client, env, original: dict | None, text: str) -> None:
    client.send_reply(
        to=env["EMAIL_DRAFT_SENDER"],
        from_addresses=[env["EMAIL_DRAFT_ADDRESS"], env["EMAIL_DRAFT_SENDER"]],
        subject=reply_subject((original or {}).get("subject") or ""),
        text=text,
        in_reply_to=list((original or {}).get("messageId") or []),
    )


def _move(client, original: dict, email_id: str, child: str) -> None:
    parents = sorted((original.get("mailboxIds") or {}).keys())
    if not parents:
        raise jmap.JmapError("move", "email has no mailbox")
    client.move_email(email_id, client.ensure_child_mailbox(parents[0], child))


def _jmap_step(fn, *args, category="fastmail-api", **kwargs):
    try:
        return fn(*args, **kwargs)
    except jmap.JmapError as exc:
        detail = (
            "A Fastmail request failed." if category != "reply" else "Sending the reply failed."
        )
        raise StepError(category, detail, f"JmapError({exc.what}: {exc.detail})") from exc


def _gh_step(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except github_draft.GitHubError as exc:
        raise StepError(
            "github-api", "A GitHub request failed.", f"GitHubError({exc.what}: {exc.status})"
        ) from exc


def process(
    *,
    email_id: str,
    site_root: Path,
    env,
    now: datetime.datetime,
    client,
    github,
    dry_run: bool = False,
    dnsfunc=None,
    out=None,
) -> int:
    """Run the whole flow; return the exit code. See the module docstring."""
    missing = [k for k in REQUIRED_ENV if not env.get(k)]
    if missing:
        # A count, not the names: the workflow's first step names any unset secret.
        log(f"step=config result=fail missing_env_count={len(missing)}", out)
        return 1
    try:
        config = load_config(site_root)
    except StepError as exc:
        log(f"step=config result=fail cause={exc.cause}", out)
        return 1
    log(f"step=config result=ok enabled={str(config.enabled).lower()}", out)

    try:
        _jmap_step(client.session)
        original = _jmap_step(client.get_email, email_id)
        raw = _jmap_step(client.download, original["blobId"])
    except StepError as exc:
        log(f"step=fetch result=fail category={exc.category} cause={exc.cause}", out)
        return 1
    log(f"step=fetch result=ok bytes={len(raw)}", out)

    replied = False
    try:
        if not config.enabled:
            log("step=enabled result=off", out)
            if dry_run:
                log("plan: reply=disabled move=Failed (dry run: nothing sent)", out)
                return 0
            _jmap_step(
                _send,
                client,
                env,
                original,
                "Email-to-draft is turned off for this site, so your email was not turned "
                "into a post.\n",
                category="reply",
            )
            _jmap_step(_move, client, original, email_id, FAILED)
            return 0

        verdict = verify.verify_message(
            raw,
            sender=env["EMAIL_DRAFT_SENDER"],
            posting_address=env["EMAIL_DRAFT_ADDRESS"],
            now=now,
            dnsfunc=dnsfunc,
        )
        if not verdict.ok:
            log(f"step=verify result=fail checks={','.join(verdict.failed_checks)}", out)
            raise StepError("verification", "\n".join(f.reason for f in verdict.failures))
        log("step=verify result=ok", out)

        msg = BytesParser(policy=email.policy.default).parsebytes(raw)
        digest = message_hash(str(msg.get("Message-ID")))
        existing = _gh_step(github.find_existing_draft, digest)
        if existing:
            log("step=dedupe result=already-drafted", out)
            if dry_run:
                log("plan: reply=already-drafted move=Processed (dry run: nothing sent)", out)
                return 0
            link = draft.admin_link(config.url, existing)
            _jmap_step(
                _send,
                client,
                env,
                original,
                f"This email was already turned into a draft post.\n\nDraft: {link}\n",
                category="reply",
            )
            replied = True
            _jmap_step(_move, client, original, email_id, PROCESSED)
            return 0
        log("step=dedupe result=new", out)

        sent = email.utils.parsedate_to_datetime(str(msg.get("Date")))
        try:
            parsed = draft.parse_email(msg, sent)
        except draft.ContentError as exc:
            raise StepError("content", exc.reason, "ContentError") from exc
        log(
            f"step=parse result=ok images={len(parsed.images)} "
            f"skipped_attachments={len(parsed.skipped_attachments)}",
            out,
        )

        base, head_sha, tree_sha = _gh_step(github.default_branch_head)
        post = None
        for suffix in range(1, github_draft.MAX_SUFFIX + 1):
            try:
                candidate = draft.build_post(parsed, config.tz, suffix)
            except draft.ContentError as exc:
                raise StepError("content", exc.reason, "ContentError") from exc
            taken = _gh_step(
                github.branch_exists, github_draft.BRANCH_PREFIX + candidate.entry_name
            )
            if not taken:
                taken = _gh_step(github.file_exists, candidate.path, base)
            if not taken:
                post = candidate
                break
        if post is None:
            raise StepError(
                "github-api", "Too many posts already share this title and date.", "NameCollision"
            )
        log(f"step=build result=ok files={len(post.files)} suffix={suffix}", out)

        if dry_run:
            log(
                f"plan: create branch+commit ({len(post.files)} files), pull request with label "
                f"{github_draft.DRAFT_LABEL}, reply=success, move=Processed "
                "(dry run: nothing created or sent)",
                out,
            )
            return 0

        number = _gh_step(
            github.create_draft,
            entry_name=post.entry_name,
            files=post.files,
            message_hash=digest,
            base=base,
            head_sha=head_sha,
            tree_sha=tree_sha,
        )
        log(f"step=github result=ok pull={number}", out)
        link = draft.admin_link(config.url, post.entry_name)
        _jmap_step(_send, client, env, original, success_text(post, link), category="reply")
        replied = True
        log("step=reply result=ok", out)
        _jmap_step(_move, client, original, email_id, PROCESSED)
        log("step=move result=ok mailbox=Processed", out)
        return 0
    except Exception as exc:  # noqa: BLE001 - every failure gets a reply and the Failed mailbox
        if isinstance(exc, StepError):
            category, detail, cause = exc.category, exc.detail, exc.cause
        else:
            category, detail, cause = "github-api", "An unexpected error.", type(exc).__name__
            category = "fastmail-api" if isinstance(exc, jmap.JmapError) else category
        log(f"step=failed category={category} cause={cause or type(exc).__name__}", out)
        if dry_run:
            log("plan: reply=failure move=Failed (dry run: nothing sent)", out)
            return 1
        if not replied:
            try:
                _send(client, env, original, failure_text(category, detail.split("\n"), env))
                log("step=failure-reply result=ok", out)
            except Exception as reply_exc:  # noqa: BLE001
                log(f"step=failure-reply result=fail cause={type(reply_exc).__name__}", out)
        try:
            _move(client, original, email_id, FAILED)
            log("step=move result=ok mailbox=Failed", out)
        except Exception as move_exc:  # noqa: BLE001
            log(f"step=move result=fail cause={type(move_exc).__name__}", out)
        return 1


def notify_failure(*, email_id: str, reason: str, env, client, out=None) -> int:
    """Best effort: generic failure reply plus the Failed mailbox. Always returns 0."""
    try:
        client.session()
        original = client.get_email(email_id)
        _send(client, env, original, failure_text("workflow", [reason or "The run failed."], env))
        _move(client, original, email_id, FAILED)
        log("step=notify-failure result=ok", out)
    except Exception as exc:  # noqa: BLE001 - this must never fail the workflow step
        log(f"step=notify-failure result=fail cause={type(exc).__name__}", out)
        print(
            f"::warning::email-draft notify-failure did not complete ({type(exc).__name__})",
            file=out or sys.stdout,
            flush=True,
        )
    return 0


def main(argv=None, env=None, now=None, dnsfunc=None) -> int:
    """CLI entry point; `env`, `now` and `dnsfunc` exist for tests (defaults: the real ones)."""
    env = dict(os.environ if env is None else env)
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("process")
    p.add_argument("--email-id", required=True)
    p.add_argument("--site-root", default=".")
    p.add_argument("--dry-run", action="store_true")
    n = sub.add_parser("notify-failure")
    n.add_argument("--email-id", required=True)
    n.add_argument("--reason", default="")
    args = parser.parse_args(argv)

    client = jmap.Jmap(env.get("FASTMAIL_API_TOKEN", ""))
    if args.command == "notify-failure":
        return notify_failure(email_id=args.email_id, reason=args.reason, env=env, client=client)
    github = github_draft.GitHub(env.get("GH_TOKEN", ""), env.get("GITHUB_REPOSITORY", ""))
    return process(
        email_id=args.email_id,
        site_root=Path(args.site_root),
        env=env,
        now=now or datetime.datetime.now(datetime.timezone.utc),
        client=client,
        github=github,
        dry_run=args.dry_run,
        dnsfunc=dnsfunc,
    )


if __name__ == "__main__":
    sys.exit(main())
