import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
BACKEND = PROJECT_ROOT / "plugins" / "context_hygiene" / "backend"
for path in (PROJECT_ROOT, BACKEND):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))
