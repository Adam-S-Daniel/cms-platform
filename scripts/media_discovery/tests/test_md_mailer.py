import ssl

import pytest

from media_discovery.mailer import send_digest


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
