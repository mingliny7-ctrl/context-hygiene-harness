"""Small Atlas-owned derived database; no source-store writes or credentials."""

from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sqlite3

from shared.conversation_store.database import PROJECT_ROOT, DB_PATH


def cache_path(source_db=None, explicit=None):
    path = Path(explicit) if explicit is not None else Path(source_db).parent / 'atlas_analysis.db' if source_db is not None else Path(os.getenv('ATLAS_ANALYSIS_DB', PROJECT_ROOT / 'data' / 'atlas_analysis.db'))
    if path.resolve() == Path(source_db or DB_PATH).resolve():
        raise ValueError('Derived cache must be separate from the original conversation database')
    return path


def read_completed(path, conversation_id, source_digest, schema_version):
    path = Path(path)
    if not path.is_file():
        return None
    with sqlite3.connect(path.resolve().as_uri()+'?mode=ro',uri=True,timeout=15) as connection:
        connection.row_factory = sqlite3.Row
        connection.execute('PRAGMA query_only=ON')
        if not connection.execute("SELECT 1 FROM sqlite_master WHERE name='conversation_analysis'").fetchone():
            return None
        row = connection.execute('''SELECT * FROM conversation_analysis
            WHERE conversation_id=? AND source_digest=? AND schema_version=? AND analysis_status='completed'
        ''',(conversation_id,source_digest,schema_version)).fetchone()
        return dict(row) if row else None


def save_completed(path, conversation_id, source_digest, schema_version, prompt_version, result):
    path = Path(path)
    path.parent.mkdir(parents=True,exist_ok=True)
    analyzed_at = datetime.now(timezone.utc).isoformat()
    # Persist inference facts only. No endpoint credentials, settings or API keys.
    inference = {k:result['inference'][k] for k in ('model','mode','elapsed_seconds','attempts','stats','actual_model_calls')}
    with sqlite3.connect(path,timeout=15) as connection:
        connection.execute('''CREATE TABLE IF NOT EXISTS conversation_analysis (
            conversation_id TEXT NOT NULL, source_digest TEXT NOT NULL,
            schema_version INTEGER NOT NULL, prompt_version TEXT NOT NULL,
            model TEXT NOT NULL, analysis_status TEXT NOT NULL CHECK(analysis_status='completed'),
            analyzed_at TEXT NOT NULL, analysis_json TEXT NOT NULL, inference_json TEXT NOT NULL,
            PRIMARY KEY(conversation_id,source_digest,schema_version)
        )''')
        connection.execute('BEGIN IMMEDIATE')
        connection.execute('''INSERT INTO conversation_analysis VALUES (?,?,?,?,?,'completed',?,?,?)
            ON CONFLICT(conversation_id,source_digest,schema_version) DO UPDATE SET
                prompt_version=excluded.prompt_version, model=excluded.model,
                analyzed_at=excluded.analyzed_at, analysis_json=excluded.analysis_json,
                inference_json=excluded.inference_json
        ''',(conversation_id,source_digest,schema_version,prompt_version,result['inference']['model'],
             analyzed_at,json.dumps(result['analysis'],ensure_ascii=False),json.dumps(inference,ensure_ascii=False)))
    return analyzed_at
