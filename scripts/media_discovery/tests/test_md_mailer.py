import smtplib
import ssl

import pytest

from media_discovery.mailer import SMTPLoginError, credential_shape, scrub_reply, send_digest


class FakeSMTP:
    instances = []

    def __init__(self, host, port, timeout=None, context=None):
        self.args = (host, port, timeout, context)
        self.logged_in = None
        self.sent = []
        self.closed = False
        FakeSMTP.instances.append(self)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.closed = True
        return False

    esmtp_features = {"auth": "PLAIN LOGIN", "size": "71000000"}

    def ehlo_or_helo_if_needed(self):
        pass

    def login(self, user, password):
        self.logged_in = (user, password)

    def send_message(self, msg):
        self.sent.append(msg)


def send(**kw):
    FakeSMTP.instances.clear()
    args = dict(host="smtp.example.com", port=465, user="bot@example.com", password="pw",
                mail_from="bot@example.com", mail_to=["a@example.com", "b@example.net"],
                smtp_factory=FakeSMTP)
    args.update(kw)
    send_digest("2 new finds for Example Site to review", "Line one\nLine two\n", **args)
    return FakeSMTP.instances[-1]


def test_sends_one_plain_text_message_over_tls():
    smtp = send()
    host, port, timeout, context = smtp.args
    assert (host, port, timeout) == ("smtp.example.com", 465, 30)
    assert isinstance(context, ssl.SSLContext) and context.verify_mode == ssl.CERT_REQUIRED
    assert smtp.logged_in == ("bot@example.com", "pw") and smtp.closed
    [msg] = smtp.sent
    assert msg["Subject"] == "2 new finds for Example Site to review"
    assert msg["From"] == "bot@example.com"
    assert msg["To"] == "a@example.com, b@example.net"
    assert msg.get_content_type() == "text/plain" and not msg.is_multipart()
    assert msg.get_content() == "Line one\nLine two\n"


def test_no_recipients_is_an_error_before_connecting():
    FakeSMTP.instances.clear()
    with pytest.raises(ValueError):
        send_digest("s", "b", host="h", port=465, user="u", password="p", mail_from="u",
                    mail_to=[], smtp_factory=FakeSMTP)
    assert FakeSMTP.instances == []


class RealishSMTP(smtplib.SMTP):
    """The real smtplib.SMTP.login() loop, with the network and AUTH exchange faked.

    `replies` maps a mechanism to the (code, text) the server answers it with.
    """

    instances = []

    def __init__(self, host, port, timeout=None, context=None, replies=None,
                 advertised="PLAIN LOGIN"):
        super().__init__()  # no host: no connection
        self.esmtp_features = {"auth": advertised, "size": "71000000"} if advertised else {
            "size": "71000000"}
        self.does_esmtp = True
        self.replies = replies or {}
        self.tried = []
        self.sent = []
        RealishSMTP.instances.append(self)

    def ehlo_or_helo_if_needed(self):
        pass

    def auth(self, mechanism, authobject, *, initial_response_ok=True):
        self.tried.append(mechanism)
        code, text = self.replies.get(mechanism, (235, b"2.0.0 OK"))
        if code != 235:
            raise smtplib.SMTPAuthenticationError(code, text)
        return code, text

    def send_message(self, msg):
        self.sent.append(msg)

    def close(self):
        pass


def realish(replies=None, advertised="PLAIN LOGIN", user="bot@example.com",
            password="app-pass-1234"):
    RealishSMTP.instances.clear()

    def factory(host, port, timeout=None, context=None):
        return RealishSMTP(host, port, timeout, context, replies, advertised)
    return send_digest("s", "b", host="smtp.example.com", port=465, user=user,
                       password=password, mail_from=user, mail_to=["owner@example.net"],
                       smtp_factory=factory)


REFUSED = (535, b"5.7.8 Authentication failed for bot@example.com (app-pass-1234)")


def test_a_refused_login_reports_every_mechanism_tried_with_the_server_reply():
    with pytest.raises(SMTPLoginError) as err:
        realish({"PLAIN": REFUSED, "LOGIN": (535, b"5.7.0 Incorrect username or password")})
    smtp = RealishSMTP.instances[-1]
    assert smtp.tried == ["PLAIN", "LOGIN"] and smtp.sent == []
    assert smtp.esmtp_features["auth"] == "PLAIN LOGIN"  # restored
    lines = err.value.lines
    assert lines[:3] == ["server: smtp.example.com port 465 (implicit TLS)",
                         "EHLO extensions: AUTH, SIZE", "AUTH advertised: PLAIN LOGIN"]
    assert "AUTH PLAIN: 535 5.7.8 Authentication failed for <redacted> (<redacted>)" in lines
    assert "AUTH LOGIN: 535 5.7.0 Incorrect username or password" in lines
    assert lines[-2].startswith("user: 15 characters,")
    assert lines[-1].startswith("password: 13 characters,")
    text = "\n".join(lines[1:])  # the host line names the (non-secret) server
    for private in ("bot", "example.com", "app-pass-1234", "@"):
        assert private not in text, private


def test_a_later_mechanism_that_succeeds_sends_the_message():
    realish({"PLAIN": REFUSED})
    smtp = RealishSMTP.instances[-1]
    assert smtp.tried == ["PLAIN", "LOGIN"] and len(smtp.sent) == 1
    assert smtp.esmtp_features["auth"] == "PLAIN LOGIN"


def test_no_advertised_auth_still_reports_why():
    with pytest.raises(SMTPLoginError) as err:
        realish(advertised="")
    assert "AUTH advertised: none" in err.value.lines
    assert any(line.startswith("login: SMTPNotSupportedError") for line in err.value.lines)


def test_credential_shape_flags_a_pasted_line_break_without_revealing_the_value():
    shape = credential_shape("password", "abcd efgh ijkl mnop\n")
    assert shape == ("password: 20 characters, leading/trailing whitespace: yes, "
                     "line break: yes, inner spaces: yes, non-ASCII: no")
    assert "abcd" not in shape
    user = credential_shape("user", "bot@example.com")
    assert user.endswith("looks like an email address: yes") and "bot" not in user
    assert credential_shape("user", "bot").endswith("looks like an email address: no")


def test_scrub_reply_is_one_bounded_line_without_addresses_or_workflow_commands():
    out = scrub_reply(b"535 nope\r\n::error::spoof <x@example.org>" + b"z" * 400, ("secret",))
    assert "\n" not in out and "\r" not in out and not out.startswith("::")
    assert "<address>" in out and "example.org" not in out
    assert len(out) <= 303
    assert scrub_reply("bad SeCrEt here", ("secret",)) == "bad <redacted> here"
