"""Cheap read-only invalidation across processes, including SQLite WAL writes."""
import hashlib
import json
import sqlite3
from pathlib import Path


def graph_revision(source_db, index_db):
    source, derived = Path(source_db), Path(index_db)
    if not source.is_file():
        raise sqlite3.OperationalError('Source database is unavailable')
    stamps = []
    for database in (source, derived):
        for path in (database, Path(str(database) + '-wal')):
            try:
                stat = path.stat()
                # SQLite can create an empty WAL when a read connection opens.
                # No committed frames means no content change to invalidate.
                stamps.append(None if path != database and stat.st_size == 0 else
                              (stat.st_dev, stat.st_ino, stat.st_size,
                               stat.st_mtime_ns, stat.st_ctime_ns))
            except FileNotFoundError:
                stamps.append(None)
    return hashlib.sha256(json.dumps(stamps).encode('ascii')).hexdigest()
