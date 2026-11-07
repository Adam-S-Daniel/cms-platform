"""Send the run's digest as one plain-text email over implicit-TLS SMTP."""

import smtplib
import ssl
from email.message import EmailMessage

SMTP_TIMEOUT_SECONDS = 30


def send_digest(subject: str, body: str, *, host: str, port: int, user: str, password: str,
                mail_from: str, mail_to: list[str], smtp_factory=smtplib.SMTP_SSL) -> None:
    if not mail_to:
        raise ValueError("no recipients")
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = mail_from
    msg["To"] = ", ".join(mail_to)
    msg.set_content(body)
    with smtp_factory(host, port, timeout=SMTP_TIMEOUT_SECONDS,
                      context=ssl.create_default_context()) as smtp:
        smtp.login(user, password)
        smtp.send_message(msg)
