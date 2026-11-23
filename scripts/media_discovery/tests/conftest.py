"""Puts scripts/ on sys.path so tests can `import media_discovery.<module>`.

The modules use package-relative imports and their names (config, render, ...)
are generic, so they are imported as a package rather than as top-level modules
to stay clear of the other suites collected in the same pytest run.
"""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))

from md_fixtures import CONFIG_YAML  # noqa: E402 - needs the path above


@pytest.fixture
def site(tmp_path):
    (tmp_path / ".github").mkdir()
    (tmp_path / ".github" / "media-discovery.yml").write_text(CONFIG_YAML, encoding="utf-8")
    (tmp_path / "_media").mkdir()
    (tmp_path / "_media" / "1-old.md").write_text(
        '---\ntitle: "Already Listed Interview"\narticle_url: "https://elsewhere.example.com/x"\n'
        "---\n", encoding="utf-8")
    return tmp_path

