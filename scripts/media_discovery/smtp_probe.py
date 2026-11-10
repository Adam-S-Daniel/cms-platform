"""TEMPORARY login probe for the digest's SMTP account. Test branch only.

Sends one dummy message, trying in order until one login works:
  1. the SMTP user as set, From = MEDIA_DISCOVERY_MAIL_FROM (if set)
  2. the SMTP user as set, From = the SMTP user
  3-5. the SMTP user with its @ written as #, / or = (Fastmail's alternates)
No Claude call, no search, no repository reads. Prints only what mailer
already redacts, plus the attempt label.
"""

import os
import sys

from .mailer import SMTPLoginError, scrub_reply, send_digest

HOST = "smtp.fastmail.com"
PORT = 587
SUBJECT = "SMTP test (media discovery troubleshooting)"
BODY = "Dummy test message from a troubleshooting run. No discovery content.\n"


def main() -> int:
    env = os.environ
    user = env.get("MEDIA_DISCOVERY_SMTP_USER", "").strip()
    password = env.get("MEDIA_DISCOVERY_SMTP_PASSWORD", "")
    mail_to = [a.strip() for a in env.get("MEDIA_DISCOVERY_MAIL_TO", "").split(",") if a.strip()]
    mail_from = env.get("MEDIA_DISCOVERY_MAIL_FROM", "").strip()
    if not user or not password or not mail_to:
        print("::error::probe needs the SMTP user, password and recipient secrets")
        return 1
    local = user.partition("@")[0]
    variants = [user.replace("@", sep, 1) for sep in "#/="] if "@" in user else []
    secrets = (user, local, password, *variants)

    attempts = []
    if mail_from:
        attempts.append(("1 user as set, separate From", user, mail_from))
    attempts.append(("2 user as set, From = user", user, user))
    for sep, variant in zip("#/=", variants):
        attempts.append((f"3 user with @ as {sep}, From = user", variant, user))

    for label, login_user, sender in attempts:
        print(f"media-discovery probe: attempt {label}", flush=True)
        try:
            send_digest(SUBJECT, BODY, host=HOST, port=PORT, user=login_user,
                        password=password, mail_from=sender, mail_to=mail_to)
        except SMTPLoginError as exc:
            for line in exc.lines:
                print(f"media-discovery probe:   {scrub_reply(line, secrets)}", flush=True)
            continue
        except Exception as exc:  # noqa: BLE001 - SMTP errors can quote addresses
            print(f"media-discovery probe:   failed: {type(exc).__name__} "
                  f"{scrub_reply(str(exc), secrets)}", flush=True)
            continue
        print(f"media-discovery probe: SENT with attempt {label}", flush=True)
        return 0
    print("::error::every login attempt was refused")
    return 1


if __name__ == "__main__":
    sys.exit(main())
