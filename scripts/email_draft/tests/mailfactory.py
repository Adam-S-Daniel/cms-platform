"""Builds real, DKIM-signed test emails laid out the way Fastmail delivers them.

The RSA keys are generated deterministically from a seed (pure Python, no openssl), and
`FakeDns` serves their public halves, so dkimpy really verifies every signature with no network.
Addresses use example.com / example.net only.
"""

from __future__ import annotations

import base64
import random

import dkim

OWNER = "owner@example.com"
POSTING = "post-7f3a9c@example.net"
STRANGER = "someone@example.net"
SELECTOR = "fm1"
AUTHSERV = "stl-mx-04.messagingengine.com"
DATE = "Fri, 06 Nov 2026 09:55:00 -0500"  # 14:55 UTC
MESSAGE_ID = "<CAF1234.5678@mail.example.com>"


# ---- deterministic RSA ---------------------------------------------------


def _probable_prime(n: int, rng: random.Random) -> bool:
    if n < 2:
        return False
    for p in (2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37):
        if n % p == 0:
            return n == p
    d, s = n - 1, 0
    while d % 2 == 0:
        d, s = d // 2, s + 1
    for _ in range(32):
        x = pow(rng.randrange(2, n - 2), d, n)
        if x in (1, n - 1):
            continue
        for _ in range(s - 1):
            x = pow(x, 2, n)
            if x == n - 1:
                break
        else:
            return False
    return True


def _prime(bits: int, rng: random.Random) -> int:
    while True:
        c = rng.getrandbits(bits) | (1 << (bits - 1)) | (1 << (bits - 2)) | 1
        if _probable_prime(c, rng):
            return c


def _der_len(n: int) -> bytes:
    if n < 0x80:
        return bytes([n])
    b = n.to_bytes((n.bit_length() + 7) // 8, "big")
    return bytes([0x80 | len(b)]) + b


def _der(tag: int, body: bytes) -> bytes:
    return bytes([tag]) + _der_len(len(body)) + body


def _der_int(n: int) -> bytes:
    b = n.to_bytes((n.bit_length() + 8) // 8, "big") if n else b"\x00"
    return _der(0x02, b)


def _pem(label: str, b64: str) -> str:
    """Wrap base64 DER in PEM armor for `label` (the key is generated per test run)."""
    body = "\n".join(b64[i : i + 64] for i in range(0, len(b64), 64))
    return f"-----BEGIN {label}-----\n{body}\n-----END {label}-----\n"


def rsa_keypair(seed: int, bits: int = 1024) -> tuple[bytes, str]:
    """(PEM PKCS#1 private key, base64 SubjectPublicKeyInfo for a DKIM p= tag)."""
    rng = random.Random(seed)
    e = 65537
    while True:
        p, q = _prime(bits // 2, rng), _prime(bits // 2, rng)
        phi = (p - 1) * (q - 1)
        if p != q and phi % e:
            break
    n, d = p * q, pow(e, -1, phi)
    fields = [0, n, e, d, p, q, d % (p - 1), d % (q - 1), pow(q, -1, p)]
    der = _der(0x30, b"".join(_der_int(x) for x in fields))
    b64 = base64.b64encode(der).decode("ascii")
    pem = _pem("RSA PRIVATE KEY", b64)
    rsa_pub = _der(0x30, _der_int(n) + _der_int(e))
    algo = _der(0x30, _der(0x06, bytes.fromhex("2a864886f70d010101")) + b"\x05\x00")
    spki = _der(0x30, algo + _der(0x03, b"\x00" + rsa_pub))
    return pem.encode("ascii"), base64.b64encode(spki).decode("ascii")


class FakeDns:
    """A dnsfunc for dkimpy: serves TXT records from a dict, never the network."""

    def __init__(self):
        self.records: dict[bytes, bytes] = {}

    def publish(self, selector: str, domain: str, public_b64: str) -> None:
        name = f"{selector}._domainkey.{domain}.".encode("ascii")
        self.records[name] = f"v=DKIM1; k=rsa; p={public_b64}".encode("ascii")

    def __call__(self, name, timeout=5):
        return self.records.get(name if isinstance(name, bytes) else name.encode("ascii"))


# ---- messages ------------------------------------------------------------


def fastmail_auth_results(
    *,
    dkim_result="pass",
    d="example.com",
    dmarc="pass",
    spf="pass",
    authserv=AUTHSERV,
    from_domain=None,
) -> list[str]:
    """Fastmail's four contiguous Authentication-Results values, results split across them."""
    return [
        f"{authserv};\r\n    dkim={dkim_result} (2048-bit rsa key sha256) header.d={d}\r\n"
        f"    header.i=@{d} header.b=AbCdEfGh header.a=rsa-sha256 header.s={SELECTOR}\r\n"
        "    x-bits=2048",
        f"{authserv};\r\n    arc=none (no signatures found)",
        f"{authserv};\r\n    dmarc={dmarc} policy.published-domain-policy=reject\r\n"
        "    policy.applied-disposition=none policy.evaluated-disposition=none\r\n"
        f"    (p=reject,d=none,d.eval=none) policy.policy-from=p header.from={from_domain or d}",
        f"{authserv};\r\n    iprev=pass smtp.remote-ip=192.0.2.10 (mail.example.com);\r\n"
        f"    spf={spf} smtp.mailfrom=owner@example.com smtp.helo=mail.example.com",
    ]


def build_raw(
    *,
    from_header: str = OWNER,
    to: str = POSTING,
    cc: str | None = None,
    subject: str = "A post from email",
    date: str = DATE,
    message_id: str | None = MESSAGE_ID,
    body_text: str = "First paragraph.\r\n\r\nSecond paragraph.\r\n",
    mime: bytes | None = None,
    extra_headers: list[tuple[str, str]] = (),
) -> bytes:
    """An unsigned RFC 5322 message; `mime` replaces the default text/plain part."""
    lines = [f"From: {from_header}", f"To: {to}"]
    if cc:
        lines.append(f"Cc: {cc}")
    lines += [f"Subject: {subject}", f"Date: {date}"]
    if message_id:
        lines.append(f"Message-ID: {message_id}")
    lines.append("MIME-Version: 1.0")
    lines += [f"{n}: {v}" for n, v in extra_headers]
    if mime is None:
        lines.append('Content-Type: text/plain; charset="utf-8"')
        lines.append("Content-Transfer-Encoding: 8bit")
        return ("\r\n".join(lines) + "\r\n\r\n").encode("utf-8") + body_text.encode("utf-8")
    return ("\r\n".join(lines) + "\r\n").encode("utf-8") + mime


def sign(
    raw: bytes,
    key_pem: bytes,
    *,
    domain: str = "example.com",
    headers=("from", "to", "cc", "subject", "date", "message-id", "mime-version", "content-type"),
    length: bool = False,
) -> bytes:
    sig = dkim.sign(
        raw,
        SELECTOR.encode(),
        domain.encode(),
        key_pem,
        include_headers=[h.encode() for h in headers],
        length=length,
    )
    return sig + raw


def deliver(signed: bytes, *, top_results=None, lower_results=None) -> bytes:
    """Prepend the headers Fastmail adds on delivery, in Fastmail's order."""
    top = fastmail_auth_results() if top_results is None else top_results
    head = [
        "Return-Path: <owner@example.com>",
        "Received: from mx4 ([10.202.2.163]) by compute6.internal (LMTPProxy); "
        "Fri, 06 Nov 2026 09:55:03 -0500",
        "ARC-Seal: i=1; a=rsa-sha256; t=1793976903; cv=none; d=messagingengine.com; s=fm3; b=QUJD",
        "ARC-Message-Signature: i=1; a=rsa-sha256; c=relaxed/relaxed; d=messagingengine.com; "
        "h=from:to:subject:date; s=fm3; bh=QUJD; b=QUJD",
        f"ARC-Authentication-Results: i=1; {AUTHSERV}; dkim=pass header.d=example.com",
        f"X-ME-Authentication-Results: {AUTHSERV}; x-aligned-from=pass (Address match)",
    ]
    head += [f"Authentication-Results: {v}" for v in top]
    head += [
        "X-ME-Proxy-Cause: gggruggvucftvghtrhhoucdtuddrgeefgedrudekgdduudegucetufdoteggod",
        "X-ME-VSScore: 0",
        "Received: from mail.example.com (mail.example.com [192.0.2.10]) by mx4 (Postfix); "
        "Fri, 06 Nov 2026 09:55:02 -0500",
    ]
    head += [f"Authentication-Results: {v}" for v in (lower_results or [])]
    return ("\r\n".join(head) + "\r\n").encode("utf-8") + signed
