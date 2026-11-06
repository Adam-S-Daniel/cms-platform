"""Decide whether an emailed post really came from the site owner. Pure: no network, no clock.

`verify_message` runs every check and returns a Verdict naming each one that failed, with a
short reason fit to send back to the owner. A message is accepted only when every check passes:

  dkim-signature       our own DKIM verification (dkimpy) finds a valid signature whose d= is the
                       sender's domain or a parent of it, signs From/To/Subject/Date, and has no
                       l= body-length limit (which would let a relay append text)
  single-headers       From, To, Cc, Subject, Date and Message-ID each appear at most once, so the
                       instance we read is the one the signature covers
  from-address         From holds exactly one address and it is the owner's
  posting-address      the posting address is in To or Cc, and that header is signed (an old
                       signed email re-sent to the posting address fails here)
  fastmail-results     the topmost run of Authentication-Results, added by Fastmail's own
                       servers, says dkim (aligned), dmarc and spf passed; lower ones are ignored
                       because a sender can write those
  date-fresh           Date is within the last 24 hours and at most 10 minutes ahead
  message-id           a Message-ID is present (it keys the duplicate check)
"""

from __future__ import annotations

import dataclasses
import datetime
import email.policy
import email.utils
import logging
import re
from email.parser import BytesParser


AUTHSERV_SUFFIX = ".messagingengine.com"
MAX_AGE = datetime.timedelta(hours=24)
MAX_SKEW = datetime.timedelta(minutes=10)
SIGNED_REQUIRED = ("from", "to", "subject", "date")
SINGLETONS = ("from", "to", "cc", "subject", "date", "message-id")

_NULL_LOGGER = logging.getLogger("email_draft.dkim")
_NULL_LOGGER.addHandler(logging.NullHandler())
_NULL_LOGGER.propagate = False


@dataclasses.dataclass(frozen=True)
class Failure:
    check: str
    reason: str


@dataclasses.dataclass
class Verdict:
    failures: list[Failure]

    @property
    def ok(self) -> bool:
        return not self.failures

    @property
    def failed_checks(self) -> list[str]:
        return [f.check for f in self.failures]


def _domain(address: str) -> str:
    return address.rpartition("@")[2].strip().lower().rstrip(".")


def aligned(sender_domain: str, signing_domain: str) -> bool:
    """Relaxed alignment: the signing domain is the sender's domain or a parent of it."""
    d = signing_domain.strip().lower().rstrip(".")
    return bool(d) and (sender_domain == d or sender_domain.endswith("." + d))


def _addresses(value: str) -> list[str]:
    try:
        pairs = email.utils.getaddresses([value], strict=True)
    except TypeError:  # Python without the strict parser
        pairs = email.utils.getaddresses([value])
    return [addr.strip().lower() for _, addr in pairs if addr.strip()]


def _strip_comments(value: str) -> str:
    out, depth, quoted, escape = [], 0, False, False
    for ch in value:
        if escape:
            escape = False
            if depth == 0:
                out.append(ch)
            continue
        if ch == "\\":
            escape = True
            if depth == 0:
                out.append(ch)
            continue
        if ch == '"' and depth == 0:
            quoted = not quoted
        elif not quoted and ch == "(":
            depth += 1
            continue
        elif not quoted and ch == ")" and depth:
            depth -= 1
            continue
        if depth == 0:
            out.append(ch)
    return "".join(out)


_RESULT_RE = re.compile(r"^\s*([a-z0-9_-]+)\s*=\s*([a-z]+)", re.IGNORECASE)
_PROP_RE = re.compile(r'([a-z0-9_-]+)\.([a-z0-9_.-]+)\s*=\s*("[^"]*"|[^\s;]+)', re.IGNORECASE)


def parse_authentication_results(value: str) -> tuple[str, list[tuple[str, str, dict]]]:
    """(authserv-id, [(method, result, {ptype.property: value})]) of one header value."""
    text = " ".join(_strip_comments(value).split())
    parts = text.split(";")
    authserv = parts[0].strip().split(" ")[0].lower() if parts and parts[0].strip() else ""
    results = []
    for part in parts[1:]:
        m = _RESULT_RE.match(part)
        if not m:
            continue
        props = {
            f"{p.lower()}.{k.lower()}": v.strip('"')
            for p, k, v in _PROP_RE.findall(part[m.end() :])
        }
        results.append((m.group(1).lower(), m.group(2).lower(), props))
    return authserv, results


def top_authentication_results(headers: list[tuple[str, str]]) -> list[str]:
    """The topmost contiguous run of Authentication-Results values (headers above it skipped)."""
    run: list[str] = []
    for name, value in headers:
        if name.lower() == "authentication-results":
            run.append(value)
        elif run:
            break
    return run


def _check_fastmail(headers, sender_domain) -> str | None:
    run = top_authentication_results(headers)
    if not run:
        return "Fastmail's authentication results are missing."
    results = []
    for value in run:
        authserv, parsed = parse_authentication_results(value)
        if not authserv.endswith(AUTHSERV_SUFFIX):
            return "The topmost authentication results were not added by Fastmail."
        results.extend(parsed)

    def passed(method):
        return any(m == method and r == "pass" for m, r, _ in results)

    missing = []
    dkim_ok = any(
        m == "dkim"
        and r == "pass"
        and (
            aligned(sender_domain, p.get("header.d", ""))
            or aligned(sender_domain, _domain(p.get("header.i", "")) if p.get("header.i") else "")
        )
        for m, r, p in results
    )
    if not dkim_ok:
        missing.append("DKIM")
    dmarc_ok = passed("dmarc") and not any(m == "dmarc" and r != "pass" for m, r, _ in results)
    if dmarc_ok:
        froms = [p["header.from"] for m, _, p in results if m == "dmarc" and "header.from" in p]
        dmarc_ok = all(f.lower().rstrip(".") == sender_domain for f in froms)
    if not dmarc_ok:
        missing.append("DMARC")
    if not passed("spf"):
        missing.append("SPF")
    if missing:
        return f"Fastmail did not record a pass for {', '.join(missing)}."
    return None


def _good_signatures(raw: bytes, sender_domain: str, dnsfunc) -> tuple[list[set[str]], str | None]:
    """Signed-header sets of every valid, aligned, unlimited DKIM signature, plus a reason."""
    # Imported here, not at module top, so `notify-failure` still runs when the dkimpy
    # install is what failed.
    import dkim
    import dkim.util

    try:
        verifier = dkim.DKIM(raw, logger=_NULL_LOGGER)
    except Exception:  # noqa: BLE001 - a malformed message simply has no valid signature
        return [], "The message could not be read for DKIM verification."
    sig_values = [v for n, v in verifier.headers if n.lower() == b"dkim-signature"]
    if not sig_values:
        return [], "The message has no DKIM signature."
    good, reason = [], "No DKIM signature verified."
    for idx, value in enumerate(sig_values):
        try:
            tags = dkim.util.parse_tag_value(value)
            kwargs = {"dnsfunc": dnsfunc} if dnsfunc else {}
            valid = dkim.DKIM(raw, logger=_NULL_LOGGER).verify(idx=idx, **kwargs)
        except Exception:  # noqa: BLE001 - any verifier error means "not valid"
            continue
        if not valid:
            continue
        domain = tags.get(b"d", b"").decode("ascii", "replace")
        if not aligned(sender_domain, domain):
            reason = "The valid DKIM signature is not from the owner's domain."
            continue
        if b"l" in tags:
            reason = "The DKIM signature covers only part of the body."
            continue
        signed = {
            h.strip().lower() for h in tags.get(b"h", b"").decode("ascii", "replace").split(":")
        }
        if not all(h in signed for h in SIGNED_REQUIRED):
            reason = "The DKIM signature does not cover From, To, Subject and Date."
            continue
        good.append(signed)
    return good, (None if good else reason)


def verify_message(
    raw: bytes,
    *,
    sender: str,
    posting_address: str,
    now: datetime.datetime,
    dnsfunc=None,
) -> Verdict:
    """Run every check on the raw RFC 5322 bytes; see the module docstring."""
    sender = sender.strip().lower()
    posting = posting_address.strip().lower()
    sender_domain = _domain(sender)
    msg = BytesParser(policy=email.policy.compat32).parsebytes(raw)
    headers = [(str(n), str(v)) for n, v in msg.items()]
    failures: list[Failure] = []

    def fail(check, reason):
        failures.append(Failure(check, reason))

    good, dkim_reason = _good_signatures(raw, sender_domain, dnsfunc)
    if dkim_reason:
        fail("dkim-signature", dkim_reason)

    counts: dict[str, int] = {}
    for name, _ in headers:
        counts[name.lower()] = counts.get(name.lower(), 0) + 1
    repeated = [h for h in SINGLETONS if counts.get(h, 0) > 1]
    if repeated:
        fail("single-headers", "A header that may appear once appears more than once.")

    from_values = msg.get_all("From") or []
    from_addrs = [a for v in from_values for a in _addresses(v)]
    if len(from_values) != 1 or len(from_addrs) != 1:
        fail("from-address", "The From header must hold exactly one address.")
    elif from_addrs[0] != sender:
        fail("from-address", "The From address is not the owner's address.")

    signed_union = set().union(*good) if good else set()
    found_in = [
        h
        for h in ("to", "cc")
        if any(posting == a for v in (msg.get_all(h) or []) for a in _addresses(v))
    ]
    if not found_in:
        fail("posting-address", "The posting address is not in the To or Cc line.")
    elif not any(h in signed_union for h in found_in):
        fail("posting-address", "The line holding the posting address is not signed.")

    reason = _check_fastmail(headers, sender_domain)
    if reason:
        fail("fastmail-results", reason)

    date_value = msg.get("Date")
    sent = None
    if date_value:
        try:
            sent = email.utils.parsedate_to_datetime(str(date_value))
        except (TypeError, ValueError, IndexError):
            sent = None
    if sent is None or sent.tzinfo is None:
        fail("date-fresh", "The Date header is missing or unreadable.")
    elif sent < now - MAX_AGE:
        fail("date-fresh", "The email is more than 24 hours old.")
    elif sent > now + MAX_SKEW:
        fail("date-fresh", "The email is dated in the future.")

    if not str(msg.get("Message-ID", "") or "").strip():
        fail("message-id", "The email has no Message-ID.")

    return Verdict(failures)
