"""Tests for jmap.py against an in-memory Fastmail JMAP server."""

import jmap
import pytest
from fakes import SECRET_BODY, SESSION_URL, FakeFastmail


def connected(fake):
    client = jmap.Jmap("fm-token", transport=fake, session_url=SESSION_URL)
    client.session()
    return client


def test_session_get_and_download():
    fake = FakeFastmail(b"RAW MESSAGE")
    client = connected(fake)
    assert client.account_id == "acct1"
    email = client.get_email("E1")
    assert email["blobId"] == "B1"
    assert client.download("B1") == b"RAW MESSAGE"
    get_call = fake.method_names[0]
    assert get_call == "Email/get"


def test_missing_email_raises():
    client = connected(FakeFastmail(b""))
    with pytest.raises(jmap.JmapError, match="not found"):
        client.get_email("nope")


def test_reply_goes_only_to_the_owner_from_the_posting_identity():
    fake = FakeFastmail(b"")
    client = connected(fake)
    client.send_reply(
        to="owner@example.com",
        from_addresses=["post-7f3a9c@example.net", "owner@example.com"],
        subject="Re: Hi",
        text="Body",
        in_reply_to=["m1@example.com"],
    )
    [sent] = fake.sent
    em = sent["email"]
    assert sent["identity"]["id"] == "id-posting"
    assert em["to"] == [{"name": None, "email": "owner@example.com"}]
    assert "cc" not in em and "bcc" not in em
    assert em["inReplyTo"] == ["m1@example.com"] and em["references"] == ["m1@example.com"]
    assert em["subject"] == "Re: Hi"
    # onSuccessUpdateEmail moved it from Drafts to Sent and cleared $draft.
    assert em["mailboxIds"] == {"sent": True}
    assert em["keywords"] == {"$seen": True}


@pytest.mark.parametrize(
    "available, expected",
    [(["owner@example.com", "other@example.org"], "id-owner"), (["other@example.org"], "id-other")],
)
def test_identity_fallbacks(available, expected):
    fake = FakeFastmail(b"")
    fake.identities = [i for i in fake.identities if i["email"] in available]
    client = connected(fake)
    client.send_reply(
        to="owner@example.com",
        from_addresses=["post-7f3a9c@example.net", "owner@example.com"],
        subject="s",
        text="t",
        in_reply_to=[],
    )
    assert fake.sent[0]["identity"]["id"] == expected


def test_child_mailbox_is_created_once_then_reused():
    fake = FakeFastmail(b"")
    client = connected(fake)
    first = client.ensure_child_mailbox("posting", "Processed")
    second = client.ensure_child_mailbox("posting", "Processed")
    assert first == second
    assert fake.method_names.count("Mailbox/set") == 1
    assert {"name": "Processed", "parentId": "posting"}.items() <= next(
        b for b in fake.mailboxes if b["id"] == first
    ).items()


def test_move_email_replaces_mailboxes_and_marks_seen():
    fake = FakeFastmail(b"")
    client = connected(fake)
    client.move_email("E1", "posting-child")
    assert fake.emails["E1"]["mailboxIds"] == {"posting-child": True}
    assert fake.emails["E1"]["keywords"] == {"$seen": True}


def test_http_error_carries_status_but_not_the_body():
    fake = FakeFastmail(b"")
    fake.fail_http["session"] = 401
    with pytest.raises(jmap.JmapError) as info:
        jmap.Jmap("fm-token", transport=fake, session_url=SESSION_URL).session()
    assert "HTTP 401" in str(info.value)
    assert SECRET_BODY not in str(info.value)
