"""Puts scripts/cross_post on sys.path so tests can `import cross_post`."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
