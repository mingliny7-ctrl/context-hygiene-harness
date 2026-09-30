"""A Windows-friendly database check: avoids PowerShell nested quote syntax."""

import sys
from pathlib import Path

# Running "python scripts/check_db.py" makes scripts/ the initial import path.
# Add the project root so shared/ is importable without environment tweaks.
PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from shared.conversation_store.database import DB_PATH, get_connection, init_db

init_db()
connection = get_connection()
try:
    tables = connection.execute(
        "SELECT name FROM sqlite_master WHERE type=? ORDER BY name", ("table",)
    ).fetchall()
    print("Database:", DB_PATH)
    print("Tables:", [name for (name,) in tables])
    conversation_count = connection.execute(
        "SELECT COUNT(*) FROM conversations"
    ).fetchone()[0]
    message_count = connection.execute("SELECT COUNT(*) FROM messages").fetchone()[0]
    print("Stored conversations:", conversation_count)
    print("Stored messages:", message_count)
finally:
    connection.close()
