"""Tests for verify.py: real DKIM signatures, Fastmail's header layout, and forgeries."""

import datetime

import mailfactory as m
import pytest
import verify


def check(raw, dns, now, **kw):
    return verify.verify_message(
        raw,
        sender=kw.get("sender", m.OWNER),
        posting_address=kw.get("posting", m.POSTING),
        now=now,
        dnsfunc=dns,
    )


def good(keys, **kw):
    top = kw.pop("top_results", None)
    lower = kw.pop("lower_results", None)
    sign_kw = {k: kw.pop(k) for k in ("domain", "headers", "length") if k in kw}
    key = kw.pop("key", keys["example.com"][0])
    return m.deliver(
        m.sign(m.build_raw(**kw), key, **sign_kw), top_results=top, lower_results=lower
    )


def test_genuine_fastmail_delivery_passes(keys, dns, now):
    verdict = check(good(keys), dns, now)
    assert verdict.ok, verdict.failures


def test_sender_comparison_is_case_insensitive(keys, dns, now):
    raw = good(keys, from_header="Owner Person <OWNER@Example.COM>", to="POST-7F3A9C@example.net")
    assert check(raw, dns, now).ok


def test_posting_address_in_signed_cc_passes(keys, dns, now):
    raw = good(keys, to="friend@example.net", cc=m.POSTING)
    assert check(raw, dns, now).ok


def test_subdomain_sender_with_parent_domain_signature_passes(keys, dns, now):
    top = m.fastmail_auth_results(d="example.com", from_domain="mail.example.com")
    raw = good(keys, from_header="owner@mail.example.com", top_results=top)
    verdict = check(raw, dns, now, sender="owner@mail.example.com")
    assert verdict.ok, verdict.failures


def test_dmarc_pass_for_another_from_domain_fails(keys, dns, now):
    raw = good(keys, top_results=m.fastmail_auth_results(from_domain="example.net"))
    assert check(raw, dns, now).failed_checks == ["fastmail-results"]


def test_forged_authentication_results_below_the_top_run_are_ignored(keys, dns, now):
    raw = good(
        keys,
        top_results=m.fastmail_auth_results(dkim_result="fail", dmarc="fail", spf="softfail"),
        lower_results=m.fastmail_auth_results(),
    )
    verdict = check(raw, dns, now)
    assert verdict.failed_checks == ["fastmail-results"]


def test_top_run_not_from_messagingengine_fails(keys, dns, now):
    raw = good(keys, top_results=m.fastmail_auth_results(authserv="mx.example.net"))
    assert check(raw, dns, now).failed_checks == ["fastmail-results"]


def test_top_run_lookalike_authserv_fails(keys, dns, now):
    raw = good(
        keys, top_results=m.fastmail_auth_results(authserv="messagingengine.com.example.net")
    )
    assert "fastmail-results" in check(raw, dns, now).failed_checks


def test_top_run_with_one_foreign_header_fails(keys, dns, now):
    top = m.fastmail_auth_results()
    top[2] = top[2].replace(m.AUTHSERV, "mx.example.net")
    assert "fastmail-results" in check(good(keys, top_results=top), dns, now).failed_checks


def test_fastmail_dkim_pass_for_other_domain_fails(keys, dns, now):
    raw = good(keys, top_results=m.fastmail_auth_results(d="example.net"))
    assert "fastmail-results" in check(raw, dns, now).failed_checks


def test_missing_spf_pass_fails(keys, dns, now):
    raw = good(keys, top_results=m.fastmail_auth_results(spf="fail"))
    verdict = check(raw, dns, now)
    assert verdict.failed_checks == ["fastmail-results"]
    assert "SPF" in verdict.failures[0].reason


def test_wrong_signing_domain_fails(keys, dns, now):
    raw = good(keys, domain="example.net", key=keys["example.net"][0])
    assert "dkim-signature" in check(raw, dns, now).failed_checks


def test_signature_with_unpublished_key_fails(keys, dns, now):
    raw = good(keys, key=keys["unpublished"][0])
    assert "dkim-signature" in check(raw, dns, now).failed_checks


def test_missing_dkim_fails(keys, dns, now):
    raw = m.deliver(m.build_raw())
    verdict = check(raw, dns, now)
    assert verdict.failed_checks == ["dkim-signature", "posting-address"]
    assert "no DKIM signature" in verdict.failures[0].reason


def test_tampered_body_fails(keys, dns, now):
    raw = good(keys).replace(b"Second paragraph.", b"Buy cheap stuff.")
    assert "dkim-signature" in check(raw, dns, now).failed_checks


def test_body_length_limited_signature_fails(keys, dns, now):
    raw = good(keys, length=True)
    assert "dkim-signature" in check(raw, dns, now).failed_checks


def test_unsigned_to_fails(keys, dns, now):
    raw = good(keys, headers=("from", "subject", "date", "message-id"))
    verdict = check(raw, dns, now)
    assert "dkim-signature" in verdict.failed_checks
    assert "posting-address" in verdict.failed_checks


def test_replayed_email_to_another_recipient_fails(keys, dns, now):
    # A legitimately signed email to someone else, re-sent to the posting address (envelope only).
    raw = good(keys, to=m.STRANGER)
    assert check(raw, dns, now).failed_checks == ["posting-address"]


def test_replay_with_an_unsigned_cc_added_fails(keys, dns, now):
    signed = m.sign(
        m.build_raw(to=m.STRANGER),
        keys["example.com"][0],
        headers=("from", "to", "subject", "date", "message-id"),
    )
    raw = m.deliver(f"Cc: {m.POSTING}\r\n".encode() + signed)
    verdict = check(raw, dns, now)
    assert verdict.failed_checks == ["posting-address"]
    assert "not signed" in verdict.failures[0].reason


def test_two_from_addresses_fail(keys, dns, now):
    raw = good(keys, from_header=f"{m.OWNER}, {m.STRANGER}")
    assert "from-address" in check(raw, dns, now).failed_checks


def test_two_from_headers_fail(keys, dns, now):
    raw = good(keys, extra_headers=[("From", m.STRANGER)])
    failed = check(raw, dns, now).failed_checks
    assert "from-address" in failed and "single-headers" in failed


def test_prepended_second_subject_fails(keys, dns, now):
    raw = m.deliver(b"Subject: injected\r\n" + m.sign(m.build_raw(), keys["example.com"][0]))
    assert "single-headers" in check(raw, dns, now).failed_checks


def test_display_name_spoofing_fails(keys, dns, now):
    raw = good(
        keys,
        from_header=f'"{m.OWNER}" <attacker@example.net>',
        domain="example.net",
        key=keys["example.net"][0],
        top_results=m.fastmail_auth_results(d="example.net"),
    )
    failed = check(raw, dns, now).failed_checks
    assert {"from-address", "dkim-signature", "fastmail-results"} <= set(failed)


def test_stale_date_fails(keys, dns, now):
    raw = good(keys, date="Wed, 04 Nov 2026 09:55:00 -0500")
    assert check(raw, dns, now).failed_checks == ["date-fresh"]


def test_future_date_fails(keys, dns, now):
    raw = good(keys, date="Fri, 06 Nov 2026 10:20:00 -0500")  # 15:20 UTC, 20 minutes ahead
    assert check(raw, dns, now).failed_checks == ["date-fresh"]


def test_date_within_skew_passes(keys, dns, now):
    raw = good(keys, date="Fri, 06 Nov 2026 10:09:00 -0500")
    assert check(raw, dns, now).ok


def test_unreadable_date_fails(keys, dns, now):
    raw = good(keys, date="sometime last week")
    assert "date-fresh" in check(raw, dns, now).failed_checks


def test_missing_message_id_fails(keys, dns, now):
    raw = good(keys, message_id=None, headers=("from", "to", "subject", "date"))
    assert check(raw, dns, now).failed_checks == ["message-id"]


def test_every_failure_is_listed_at_once(keys, dns, now):
    raw = m.deliver(
        m.build_raw(to=m.STRANGER, date="Mon, 02 Nov 2026 09:00:00 -0500", message_id=None),
        top_results=m.fastmail_auth_results(authserv="mx.example.net"),
    )
    assert check(raw, dns, now).failed_checks == [
        "dkim-signature",
        "posting-address",
        "fastmail-results",
        "date-fresh",
        "message-id",
    ]


def test_reasons_never_carry_addresses(keys, dns, now):
    raw = m.deliver(m.build_raw(from_header=f"{m.OWNER}, {m.STRANGER}", to=m.STRANGER))
    for failure in check(raw, dns, now).failures:
        assert "@" not in failure.reason


@pytest.mark.parametrize(
    "value, authserv, methods",
    [
        (
            "mx.messagingengine.com; dkim=pass (ok) header.d=example.com",
            "mx.messagingengine.com",
            [("dkim", "pass", {"header.d": "example.com"})],
        ),
        (
            "mx.messagingengine.com 1; spf=pass smtp.mailfrom=a@example.com; dmarc=fail",
            "mx.messagingengine.com",
            [("spf", "pass", {"smtp.mailfrom": "a@example.com"}), ("dmarc", "fail", {})],
        ),
        ("mx.messagingengine.com; none", "mx.messagingengine.com", []),
        (
            "mx.messagingengine.com; dkim=pass (a; (nested) b) header.d=x.example",
            "mx.messagingengine.com",
            [("dkim", "pass", {"header.d": "x.example"})],
        ),
    ],
)
def test_parse_authentication_results(value, authserv, methods):
    assert verify.parse_authentication_results(value) == (authserv, methods)


def test_top_run_skips_headers_above_and_stops_at_the_first_other_header():
    headers = [
        ("ARC-Authentication-Results", "x"),
        ("Authentication-Results", "a"),
        ("authentication-results", "b"),
        ("X-ME-VSScore", "0"),
        ("Authentication-Results", "forged"),
    ]
    assert verify.top_authentication_results(headers) == ["a", "b"]


def test_alignment():
    assert verify.aligned("example.com", "Example.COM")
    assert verify.aligned("mail.example.com", "example.com")
    assert not verify.aligned("example.com", "mail.example.com")
    assert not verify.aligned("badexample.com", "example.com")
    assert not verify.aligned("example.com", "")


def test_now_is_respected_not_the_wall_clock(keys, dns):
    later = datetime.datetime(2026, 11, 8, 15, 0, tzinfo=datetime.timezone.utc)
    assert check(good(keys), dns, later).failed_checks == ["date-fresh"]
