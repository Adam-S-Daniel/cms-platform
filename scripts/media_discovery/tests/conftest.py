"""Puts scripts/ on sys.path so tests can `import media_discovery.<module>`.

The modules use package-relative imports and their names (config, render, ...)
are generic, so they are imported as a package rather than as top-level modules
to stay clear of the other suites collected in the same pytest run.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))
