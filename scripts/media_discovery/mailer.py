"""Send the run's digest as one plain-text email over implicit-TLS SMTP."""

import re
import smtplib
import ssl
from email.message import EmailMessage

SMTP_TIMEOUT_SECONDS = 30
# Port 465 speaks TLS from the first byte; any other port (587) starts plain
# and upgrades with STARTTLS before the login.
IMPLICIT_TLS_PORT = 465
# smtplib.SMTP.login's own preference order; login() tries each in turn.
AUTH_PREFERENCE = ("CRAM-MD5", "PLAIN", "LOGIN")
REPLY_MAX_CHARS = 300
_ADDRESS = re.compile(r"[^\s<>\"',;:()\[\]]+@[^\s<>\"',;:()\[\]]+")
_CONTROL = re.compile(r"[\x00-\x1f\x7f]+")


class SMTPLoginError(Exception):
    """The server refused the SMTP login.

    `lines` is safe to print to a public CI log: the host, port, TLS
    version, the server's advertised extensions, each AUTH mechanism tried
    with the server's reply code and text, and the SHAPE of the credentials
    (length, whitespace) -- never the password, the user name or any address,
    which are redacted from the server's text as well.
    """

    def __init__(self, lines: list[str]):
        super().__init__("SMTP login refused")
        self.lines = lines


def scrub_reply(text, secrets=()) -> str:
    """One printable line of server text with addresses and secrets removed."""
    if isinstance(text, bytes):
        text = text.decode("utf-8", "replace")
    text = str(text)
    for secret in sorted({s for s in secrets if s and len(s) >= 3}, key=len, reverse=True):
        text = re.sub(re.escape(secret), "<redacted>", text, flags=re.IGNORECASE)
    text = _ADDRESS.sub("<address>", text)
    text = _CONTROL.sub(" ", text).strip()
    return text[:REPLY_MAX_CHARS] + ("..." if len(text) > REPLY_MAX_CHARS else "")


_EMAIL_SHAPE = re.compile(r"[^@\s]+@[^@\s]+\.[^@\s]+")


def credential_shape(label: str, value: str) -> str:
    """Facts about a credential that help debug a refused login without revealing it."""
    stripped = value.strip()

    def yes(flag: bool) -> str:
        return "yes" if flag else "no"

    facts = [f"{len(value)} characters",
             f"leading/trailing whitespace: {yes(stripped != value)}",
             f"line break: {yes('\n' in value or '\r' in value)}",
             f"inner spaces: {yes(' ' in stripped)}",
             f"non-ASCII: {yes(not value.isascii())}"]
    if label == "user":
        facts.append(f"looks like an email address: {yes(bool(_EMAIL_SHAPE.fullmatch(stripped)))}")
    return f"{label}: " + ", ".join(facts)


def _login(smtp, user: str, password: str, *, host: str, port: int) -> None:
    """smtp.login(), one AUTH mechanism at a time, recording each server reply.

    smtplib's login() tries every mechanism it supports and raises only the
    last reply; narrowing the advertised list to one mechanism per call keeps
    each reply. The list is restored afterwards.
    """
    secrets = (user, user.partition("@")[0], password)
    tls = "implicit TLS" if port == IMPLICIT_TLS_PORT else "STARTTLS"
    lines = [f"server: {host} port {port} ({tls})"]
    version = getattr(getattr(smtp, "sock", None), "version", None)
    if callable(version):
        lines.append(f"TLS: {version()}")
    smtp.ehlo_or_helo_if_needed()
    features = smtp.esmtp_features
    lines.append("EHLO extensions: " + (", ".join(sorted(k.upper() for k in features)) or "none"))
    original = features.get("auth", "")
    advertised = original.upper().split()
    lines.append("AUTH advertised: " + (" ".join(advertised) or "none"))
    tried = [m for m in AUTH_PREFERENCE if m in advertised] or [None]
    try:
        for mech in tried:
            if mech:
                features["auth"] = mech
            label = f"AUTH {mech}" if mech else "login"
            try:
                smtp.login(user, password)
                return
            except smtplib.SMTPAuthenticationError as exc:
                lines.append(f"{label}: {exc.smtp_code} {scrub_reply(exc.smtp_error, secrets)}")
            except smtplib.SMTPException as exc:
                reply = getattr(exc, "smtp_error", None) or str(exc)
                code = getattr(exc, "smtp_code", None)
                lines.append(f"{label}: {type(exc).__name__}"
                             + (f" {code}" if code else "") + f" {scrub_reply(reply, secrets)}")
                break
    finally:
        if original:
            features["auth"] = original
    raise SMTPLoginError(lines + [credential_shape("user", user),
                                  credential_shape("password", password)])


def send_digest(subject: str, body: str, *, host: str, port: int, user: str, password: str,
                mail_from: str, mail_to: list[str], smtp_factory=None) -> None:
    if not mail_to:
        raise ValueError("no recipients")
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = mail_from
    msg["To"] = ", ".join(mail_to)
    msg.set_content(body)
    context = ssl.create_default_context()
    if port == IMPLICIT_TLS_PORT:
        smtp = (smtp_factory or smtplib.SMTP_SSL)(host, port, timeout=SMTP_TIMEOUT_SECONDS,
                                                  context=context)
    else:
        smtp = (smtp_factory or smtplib.SMTP)(host, port, timeout=SMTP_TIMEOUT_SECONDS)
    with smtp:
        if port != IMPLICIT_TLS_PORT:
            smtp.starttls(context=context)  # raises if the server does not offer it
        _login(smtp, user, password, host=host, port=port)
        smtp.send_message(msg)
