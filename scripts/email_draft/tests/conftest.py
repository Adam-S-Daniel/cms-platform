"""Puts scripts/email_draft on sys.path so tests can `import verify`, `import draft`, etc."""

import datetime
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import mailfactory  # noqa: E402

NOW = datetime.datetime(2026, 11, 6, 15, 0, tzinfo=datetime.timezone.utc)


@pytest.fixture(scope="session")
def keys():
    """Deterministic RSA keys: the owner's domain, a stranger's domain, and an unpublished one."""
    return {
        "example.com": mailfactory.rsa_keypair(1),
        "example.net": mailfactory.rsa_keypair(2),
        "unpublished": mailfactory.rsa_keypair(3),
    }


@pytest.fixture
def dns(keys):
    fake = mailfactory.FakeDns()
    fake.publish(mailfactory.SELECTOR, "example.com", keys["example.com"][1])
    fake.publish(mailfactory.SELECTOR, "example.net", keys["example.net"][1])
    return fake


@pytest.fixture
def now():
    return NOW
