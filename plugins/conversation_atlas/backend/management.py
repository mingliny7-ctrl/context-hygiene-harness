"""Atlas-owned visibility and bookmarks; original messages remain in the shared Store."""

from contextlib import closing
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import sqlite3
import uuid

from shared.conversation_store.database import get_read_connection, init_db
from shared.conversation_store.store import read_stored_conversation

NATIVE_ASSISTANT = re.compile(r'^chatgpt:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}:assistant$')
DERIVED_TABLES = ('conversation_analysis', 'atlas_index_calls', 'atlas_index_runs',
                  'atlas_index_batches', 'atlas_indexed_messages', 'atlas_segments',
                  'atlas_bookmarks', 'atlas_conversation_visibility', 'atlas_segment_visibility')
SOURCE_TABLES = ('conversations', 'messages', 'collector_save_state',
                 'conversation_order_evidence', 'message_presentations', 'collector_tombstones')


class ManagementError(ValueError):
    def __init__(self, code, message):
        self.code = code
        super().__init__(message)


class AtlasManagement:
    def __init__(self, source_db: Path, index_db: Path):
        self.source_db = Path(source_db).resolve()
        self.index_db = Path(index_db).resolve()
        if self.source_db == self.index_db:
            raise ValueError('Atlas management requires a separate derived database')

    def _read(self):
        if not self.index_db.is_file():
            return None
        connection = sqlite3.connect(self.index_db.as_uri() + '?mode=ro', uri=True, timeout=15)
        connection.row_factory = sqlite3.Row
        connection.execute('PRAGMA query_only=ON')
        return connection

    @staticmethod
    def _has(connection, table):
        return bool(connection.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone())

    @staticmethod
    def _tables(connection, schema):
        return {row[0] for row in connection.execute(f'SELECT name FROM "{schema}".sqlite_master WHERE type=\'table\'')}

    @staticmethod
    def _purge_schema(connection, schema, cid, derived):
        tables = AtlasManagement._tables(connection, schema)
        allowed = DERIVED_TABLES if derived else SOURCE_TABLES
        for table in tables - set(allowed):
            name = table.replace('"', '""')
            if 'conversation_id' in {col[1] for col in connection.execute(f'PRAGMA "{schema}".table_info("{name}")')}:
                raise ManagementError('UNKNOWN_DEPENDENCY', '发现未知的对话关联表，已取消删除。')
        prefix = f'"{schema}".'
        if derived:
            if 'atlas_index_calls' in tables:
                if 'atlas_index_runs' not in tables:
                    raise ManagementError('UNKNOWN_DEPENDENCY', '分析调用缺少运行记录，已取消删除。')
                connection.execute(f'DELETE FROM {prefix}atlas_index_calls WHERE run_id IN (SELECT run_id FROM {prefix}atlas_index_runs WHERE conversation_id=?)', (cid,))
            if 'atlas_indexed_messages' in tables:
                connection.execute(f'DELETE FROM {prefix}atlas_indexed_messages WHERE conversation_id=?', (cid,))
            for table in DERIVED_TABLES:
                if table not in ('atlas_index_calls', 'atlas_indexed_messages') and table in tables:
                    connection.execute(f'DELETE FROM {prefix}{table} WHERE conversation_id=?', (cid,))
        else:
            for table in ('collector_save_state', 'message_presentations', 'conversation_order_evidence', 'messages', 'conversations', 'collector_tombstones'):
                if table in tables:
                    connection.execute(f'DELETE FROM {prefix}{table} WHERE conversation_id=?', (cid,))

    def _known_backups(self):
        """Only project-generated SQLite backups in the two database directories."""
        paths = set()
        for path in (self.source_db, self.index_db):
            paths.update(p.resolve() for p in path.parent.glob(path.stem + '*backup*.db') if p.is_file())
        return sorted(paths - {self.source_db, self.index_db})

    def initialize(self):
        """Lazy additive schema migration, backed up before altering an existing index DB."""
        self.index_db.parent.mkdir(parents=True, exist_ok=True)
        if self.index_db.is_file():
            with closing(self._read()) as reader:
                if all(self._has(reader, table) for table in ('atlas_bookmarks', 'atlas_conversation_visibility', 'atlas_segment_visibility')):
                    return None
                backup = self.index_db.with_name(self.index_db.stem + '.management-backup-' + uuid.uuid4().hex + '.db')
                with sqlite3.connect(backup) as destination:
                    reader.backup(destination)
        else:
            backup = None
        with sqlite3.connect(self.index_db, timeout=15) as connection:
            connection.execute('BEGIN IMMEDIATE')
            connection.execute('''CREATE TABLE IF NOT EXISTS atlas_conversation_visibility (
                conversation_id TEXT PRIMARY KEY, hidden_at TEXT NOT NULL)''')
            connection.execute('''CREATE TABLE IF NOT EXISTS atlas_bookmarks (
                conversation_id TEXT NOT NULL, message_key TEXT NOT NULL,
                created_at TEXT NOT NULL, PRIMARY KEY(conversation_id,message_key))''')
            connection.execute('''CREATE TABLE IF NOT EXISTS atlas_segment_visibility (
                conversation_id TEXT NOT NULL, segment_id TEXT NOT NULL,
                hidden_at TEXT NOT NULL, PRIMARY KEY(conversation_id,segment_id))''')
        return backup

    def hidden_ids(self):
        connection = self._read()
        if connection is None:
            return set()
        with closing(connection):
            if not self._has(connection, 'atlas_conversation_visibility'):
                return set()
            return {row[0] for row in connection.execute('SELECT conversation_id FROM atlas_conversation_visibility')}

    def hidden(self):
        ids = self.hidden_ids()
        return [{'conversationId': cid, 'title': stored.get('original_title') or '原始标题待重新采集',
                 'messageCount': len(stored['messages'])} for cid in sorted(ids)
                if (stored := read_stored_conversation(cid, self.source_db)) is not None]

    def set_hidden(self, cid, hidden):
        if read_stored_conversation(cid, self.source_db) is None:
            raise ManagementError('NOT_FOUND', '会话不存在。')
        self.initialize()
        with sqlite3.connect(self.index_db, timeout=15) as connection:
            if hidden:
                connection.execute('INSERT OR IGNORE INTO atlas_conversation_visibility VALUES (?,?)',
                                   (cid, datetime.now(timezone.utc).isoformat()))
            else:
                connection.execute('DELETE FROM atlas_conversation_visibility WHERE conversation_id=?', (cid,))
        return {'conversationId': cid, 'hidden': hidden}

    def hidden_segment_ids(self, cid=None):
        """Return IDs for one Conversation, or (Conversation, Segment) pairs globally."""
        connection = self._read()
        if connection is None:
            return set()
        with closing(connection):
            if not self._has(connection, 'atlas_segment_visibility'):
                return set()
            if cid is not None:
                return {row[0] for row in connection.execute(
                    'SELECT segment_id FROM atlas_segment_visibility WHERE conversation_id=?', (cid,))}
            return {tuple(row) for row in connection.execute(
                'SELECT conversation_id,segment_id FROM atlas_segment_visibility')}

    def hidden_segments(self):
        connection = self._read()
        if connection is None:
            return []
        with closing(connection):
            if not all(self._has(connection, table) for table in ('atlas_segment_visibility', 'atlas_segments')):
                return []
            rows = connection.execute('''SELECT v.conversation_id,v.segment_id,v.hidden_at,s.analysis_json
                FROM atlas_segment_visibility v JOIN atlas_segments s
                ON s.conversation_id=v.conversation_id AND s.segment_id=v.segment_id
                ORDER BY v.hidden_at DESC,v.conversation_id,v.segment_id''').fetchall()
        result = []
        titles = {}
        for cid, sid, hidden_at, analysis in rows:
            if cid not in titles:
                stored = read_stored_conversation(cid, self.source_db)
                titles[cid] = (stored.get('original_title') or '原始标题待重新采集') if stored else None
            if titles[cid] is not None:
                result.append({'conversationId': cid, 'segmentId': sid,
                               'title': json.loads(analysis)['title'],
                               'conversationTitle': titles[cid], 'hiddenAt': hidden_at})
        return result

    def set_segment_hidden(self, cid, sid, hidden):
        """Visibility only: preserve analysis, coverage, and original messages."""
        if read_stored_conversation(cid, self.source_db) is None:
            raise ManagementError('NOT_FOUND', '会话不存在。')
        reader = self._read()
        if reader is None:
            raise ManagementError('NOT_FOUND', '主题不存在。')
        with closing(reader):
            if (not self._has(reader, 'atlas_segments') or not reader.execute(
                    'SELECT 1 FROM atlas_segments WHERE conversation_id=? AND segment_id=?', (cid, sid)).fetchone()):
                raise ManagementError('NOT_FOUND', '主题不存在。')
        self.initialize()
        with sqlite3.connect(self.index_db, timeout=15) as connection:
            connection.execute('BEGIN IMMEDIATE')
            if not connection.execute('SELECT 1 FROM atlas_segments WHERE conversation_id=? AND segment_id=?', (cid, sid)).fetchone():
                raise ManagementError('NOT_FOUND', '主题已不存在。')
            if hidden:
                connection.execute('INSERT OR IGNORE INTO atlas_segment_visibility VALUES (?,?,?)',
                                   (cid, sid, datetime.now(timezone.utc).isoformat()))
            else:
                connection.execute('DELETE FROM atlas_segment_visibility WHERE conversation_id=? AND segment_id=?', (cid, sid))
        return {'conversationId': cid, 'segmentId': sid, 'hidden': hidden}

    def _assistant(self, cid, key):
        if not NATIVE_ASSISTANT.fullmatch(key):
            raise ManagementError('IDENTITY_UNRELIABLE', '只能收藏具有稳定原始身份的模型回答。')
        stored = read_stored_conversation(cid, self.source_db)
        if stored is None:
            raise ManagementError('NOT_FOUND', '会话不存在。')
        message = next((m for m in stored['messages'] if m['key'] == key and m['role'] == 'assistant' and m['content'].strip()), None)
        if message is None:
            raise ManagementError('NOT_FOUND', '有效模型回答不存在。')
        return stored, message

    def bookmarks(self):
        connection = self._read()
        if connection is None:
            return []
        with closing(connection):
            if not self._has(connection, 'atlas_bookmarks'):
                return []
            rows = connection.execute('SELECT conversation_id,message_key,created_at FROM atlas_bookmarks ORDER BY created_at DESC,conversation_id,message_key').fetchall()
        result = []
        for cid, key, created_at in rows:
            try:
                stored, answer = self._assistant(cid, key)
            except ManagementError:
                continue
            result.append({'conversationId': cid, 'messageKey': key,
                           'title': stored.get('original_title') or '原始标题待重新采集',
                           'preview': ' '.join(answer['content'].split())[:100], 'createdAt': created_at})
        return result

    def set_bookmark(self, cid, key, saved):
        self._assistant(cid, key)
        self.initialize()
        with sqlite3.connect(self.index_db, timeout=15) as connection:
            if saved:
                connection.execute('INSERT OR IGNORE INTO atlas_bookmarks VALUES (?,?,?)',
                                   (cid, key, datetime.now(timezone.utc).isoformat()))
            else:
                connection.execute('DELETE FROM atlas_bookmarks WHERE conversation_id=? AND message_key=?', (cid, key))
        return {'conversationId': cid, 'messageKey': key, 'saved': saved}

    def bookmark_answer(self, cid, key):
        stored, answer = self._assistant(cid, key)
        messages = stored['messages']
        position = next(i for i, m in enumerate(messages) if m['key'] == key)
        users = []
        if stored['ordering'] in ('source_time', 'dom_relative'):
            j = position - 1
            while j >= 0 and messages[j]['role'] == 'user':
                users.insert(0, messages[j]); j -= 1
        pack = lambda m: {k: m[k] for k in ('key', 'role', 'content', 'source_order', 'source_created_at',
                                          'first_seen_at', 'presentation', 'presentation_status', 'observed_presentation')}
        return {'conversationId': cid, 'answer': pack(answer), 'questions': [pack(m) for m in users],
                'contextStatus': 'ordered_adjacent' if users else 'unconfirmed', 'ordering': stored['ordering']}

    def delete(self, cid):
        """Purge active DBs and known project backups in one SQLite transaction."""
        if read_stored_conversation(cid, self.source_db) is None:
            raise ManagementError('NOT_FOUND', '会话不存在。')
        self.initialize()
        init_db(self.source_db)  # Additive tombstone migration backs up the existing source DB.
        connection = sqlite3.connect(self.source_db, timeout=15)
        try:
            connection.execute('PRAGMA foreign_keys=ON')
            connection.execute('PRAGMA busy_timeout=15000')
            connection.execute('ATTACH DATABASE ? AS atlas', (str(self.index_db),))
            backups = self._known_backups()
            if len(backups) > 9:
                raise ManagementError('TOO_MANY_BACKUPS', '本地备份过多，已取消删除以免遗漏副本。')
            for i, path in enumerate(backups):
                connection.execute(f'ATTACH DATABASE ? AS backup_{i}', (str(path),))
            for schema in ('main', 'atlas', *(f'backup_{i}' for i in range(len(backups)))):
                connection.execute(f'PRAGMA "{schema}".secure_delete=ON')
            connection.execute('BEGIN IMMEDIATE')
            if not connection.execute('SELECT 1 FROM conversations WHERE conversation_id=?', (cid,)).fetchone():
                raise ManagementError('NOT_FOUND', '会话已不存在。')
            self._purge_schema(connection, 'atlas', cid, True)
            for i, path in enumerate(backups):
                self._purge_schema(connection, f'backup_{i}', cid, path.stem.startswith(self.index_db.stem))
            self._purge_schema(connection, 'main', cid, False)
            # The active Store alone keeps the compact re-import block.
            connection.execute('INSERT OR IGNORE INTO collector_tombstones(conversation_id) VALUES (?)', (cid,))
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()
        return {'conversationId': cid, 'deleted': True, 'captureBlocked': True}

    def tombstones(self):
        with closing(get_read_connection(self.source_db)) as connection:
            if not self._has(connection, 'collector_tombstones'):
                return []
            return [{'conversationId': row[0], 'deletedAt': row[1]} for row in
                    connection.execute('SELECT conversation_id,deleted_at FROM collector_tombstones ORDER BY deleted_at DESC')]

    def allow_recapture(self, cid):
        with sqlite3.connect(self.source_db, timeout=15) as connection:
            connection.execute('DELETE FROM collector_tombstones WHERE conversation_id=?', (cid,))
        return {'conversationId': cid, 'captureBlocked': False}
