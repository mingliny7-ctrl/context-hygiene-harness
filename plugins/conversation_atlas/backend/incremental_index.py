"""Manual-only incremental index persistence. No model client or scheduler is run here."""
from datetime import datetime, timezone
from contextlib import contextmanager
import hashlib
import json
from pathlib import Path
import re
import sqlite3
from typing import Literal
import uuid

from pydantic import BaseModel, ConfigDict, Field

from shared.conversation_store.database import DB_PATH
from shared.conversation_store.identity import is_temporary_conversation_id
from shared.conversation_store.store import read_stored_conversation
from .analysis import SemanticAnalysis, validate_references
from .analysis_cache import cache_path

SCHEMA_VERSION = 1
ALGORITHM_VERSION = 'incremental-append-v1'
PROMPT_VERSION = 'segment-contract-v1'  # Contract only: B5 supplies the semantic prompt.
NATIVE_KEY = re.compile(r'^chatgpt:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}:(user|assistant)$')


class IndexErrorState(ValueError):
    pass


def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def digest(value):
    return hashlib.sha256(encoded(value).encode('utf8')).hexdigest()


def fingerprint(message):
    return {'key': message['key'], 'role': message['role'],
            'body_digest': hashlib.sha256(message['content'].encode('utf8')).hexdigest()}


def now():
    return datetime.now(timezone.utc).isoformat()


class SegmentWrite(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    operation: Literal['create', 'extend']
    segment_id: str = Field(min_length=1, max_length=128)
    message_ids: list[str] = Field(min_length=1)
    analysis: SemanticAnalysis
    theme_state: str = Field(min_length=1, max_length=1600)


class IncrementalIndex:
    def __init__(self, source_db=None, index_db=None):
        self.source_db = Path(source_db or DB_PATH).resolve()
        self.path = cache_path(source_db, index_db).resolve()

    def initialize(self):
        """Explicit additive migration. Back up an existing derived DB before any DDL."""
        self.path.parent.mkdir(parents=True, exist_ok=True)
        backup = None
        if self.path.exists():
            with self._read() as c:
                if self._installed(c):
                    return None
                backup = self.path.with_name(self.path.stem + '.b4-backup-' + uuid.uuid4().hex + '.db')
                with sqlite3.connect(backup) as destination:
                    c.backup(destination)
        with self._write() as c:
            c.execute('BEGIN IMMEDIATE')
            c.execute('''CREATE TABLE IF NOT EXISTS atlas_segments (
                conversation_id TEXT NOT NULL, segment_id TEXT NOT NULL, revision INTEGER NOT NULL,
                start_key TEXT NOT NULL, end_key TEXT NOT NULL, analysis_json TEXT NOT NULL,
                theme_state TEXT NOT NULL, topic_state TEXT NOT NULL CHECK(topic_state IN ('open','stable')),
                schema_version INTEGER NOT NULL, algorithm_version TEXT NOT NULL,
                prompt_version TEXT NOT NULL, model TEXT NOT NULL, analyzed_at TEXT NOT NULL,
                PRIMARY KEY(conversation_id,segment_id))''')
            c.execute('''CREATE TABLE IF NOT EXISTS atlas_indexed_messages (
                conversation_id TEXT NOT NULL, message_key TEXT NOT NULL, role TEXT NOT NULL,
                body_digest TEXT NOT NULL, position INTEGER NOT NULL, segment_id TEXT NOT NULL,
                PRIMARY KEY(conversation_id,message_key), UNIQUE(conversation_id,position),
                FOREIGN KEY(conversation_id,segment_id) REFERENCES atlas_segments(conversation_id,segment_id))''')
            c.execute('''CREATE TABLE IF NOT EXISTS atlas_index_batches (
                batch_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, manifest_json TEXT NOT NULL,
                status TEXT NOT NULL CHECK(status IN ('prepared','completed','failed','interrupted')),
                created_at TEXT NOT NULL, finished_at TEXT, error_code TEXT,
                result_digest TEXT, receipt_json TEXT)''')
            c.execute("CREATE UNIQUE INDEX IF NOT EXISTS atlas_one_prepared_batch ON atlas_index_batches(conversation_id) WHERE status='prepared'")
        return backup

    @contextmanager
    def _read(self):
        c = sqlite3.connect(self.path.as_uri() + '?mode=ro', uri=True, timeout=15)
        c.row_factory = sqlite3.Row
        c.execute('PRAGMA query_only=ON')
        try:
            yield c
        finally:
            c.close()

    @contextmanager
    def _write(self):
        if self.path == self.source_db:
            raise IndexErrorState('SOURCE_DATABASE_FORBIDDEN')
        c = sqlite3.connect(self.path, timeout=15)
        c.row_factory = sqlite3.Row
        c.execute('PRAGMA foreign_keys=ON')
        try:
            with c:
                yield c
        finally:
            c.close()

    @staticmethod
    def _installed(c):
        return c.execute("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('atlas_segments','atlas_indexed_messages','atlas_index_batches')").fetchone()[0] == 3

    def _state(self, cid, c=None):
        if c is None:
            if not self.path.is_file():
                return [], []
            with self._read() as connection:
                connection.execute('BEGIN')
                return self._state(cid, connection)
        if not self._installed(c):
            return [], []
        members = [dict(r) for r in c.execute('SELECT message_key AS key,role,body_digest,position,segment_id FROM atlas_indexed_messages WHERE conversation_id=? ORDER BY position', (cid,))]
        segments = [dict(r) for r in c.execute('SELECT * FROM atlas_segments WHERE conversation_id=? ORDER BY segment_id', (cid,))]
        return members, segments

    def _source(self, cid):
        if not cid.strip() or is_temporary_conversation_id(cid):
            raise IndexErrorState('IDENTITY_UNRELIABLE')
        stored = read_stored_conversation(cid, self.source_db)
        if stored is None:
            raise IndexErrorState('CONVERSATION_NOT_FOUND')
        if stored['ordering'] not in ('dom_relative', 'source_time'):
            raise IndexErrorState('ORDER_UNRELIABLE')
        if [m['source_order'] for m in stored['messages']] != list(range(len(stored['messages']))):
            raise IndexErrorState('ORDER_UNRELIABLE')
        messages = [m for m in stored['messages'] if m['role'] in ('user', 'assistant') and m['content'].strip()]
        for m in messages:
            match = NATIVE_KEY.fullmatch(m['key'])
            if not match or match[1] != m['role']:
                raise IndexErrorState('IDENTITY_UNRELIABLE')
            if '显示更多' in m['content']:
                raise IndexErrorState('BODY_COMPLETENESS_UNCONFIRMED')
        return messages

    def inspect(self, cid):
        """Pure read: classify messages, never create a DB or schedule inference."""
        members, segments = self._state(cid)
        result = {'conversation_id': cid, 'status': 'ready', 'unchanged': [], 'appended': [],
                  'historical': [], 'changed': [], 'missing': [], 'reason': None}
        try:
            messages = self._source(cid)
        except IndexErrorState as error:
            return {**result, 'status': 'blocked', 'reason': str(error)}
        by_key = {m['key']: m for m in messages}
        saved = {m['key']: m for m in members}
        positions = {m['key']: i for i, m in enumerate(messages)}
        last = max((positions[k] for k in saved if k in positions), default=-1)
        for m in messages:
            old = saved.get(m['key'])
            if old:
                target = 'unchanged' if all(old[k] == fingerprint(m)[k] for k in ('role', 'body_digest')) else 'changed'
            else:
                target = 'historical' if positions[m['key']] < last else 'appended'
            result[target].append(m['key'])
        result['missing'] = [m['key'] for m in members if m['key'] not in by_key]
        if any(s['schema_version'] != SCHEMA_VERSION or s['algorithm_version'] != ALGORITHM_VERSION for s in segments):
            result.update(status='review_required', reason='INDEX_INCOMPATIBLE')
        elif result['changed'] or result['historical'] or result['missing']:
            result.update(status='review_required', reason='SOURCE_REVIEW_REQUIRED')
        elif [m['key'] for m in members] != [m['key'] for m in messages if m['key'] in saved]:
            result.update(status='review_required', reason='ORDER_CHANGED')
        return result

    def plan(self, cid, *, max_input_bytes=24000, max_context_bytes=4000):
        """Read-only context/pending contract. UTF-8 bytes are a conservative token upper bound."""
        if not 0 <= max_context_bytes < max_input_bytes or max_input_bytes < 4096:
            raise IndexErrorState('INVALID_BUDGET')
        status = self.inspect(cid)
        if status['status'] != 'ready':
            raise IndexErrorState(status['reason'])
        messages = self._source(cid)
        members, segments = self._state(cid)
        # Re-read consistency: reject an observation/state change during plan construction.
        known = {m['key']: m for m in members}
        if [m['key'] for m in messages if m['key'] not in known] != status['appended']:
            raise IndexErrorState('SOURCE_CHANGED')
        if any(fingerprint(m) != {k: known[m['key']][k] for k in ('key', 'role', 'body_digest')}
               for m in messages if m['key'] in known):
            raise IndexErrorState('SOURCE_CHANGED')
        if [m['key'] for m in messages if m['key'] in known] != [m['key'] for m in members]:
            raise IndexErrorState('SOURCE_CHANGED')
        tail = next((s for s in segments if members and s['segment_id'] == members[-1]['segment_id']), None)
        context = {'segment': None, 'messages': []}
        if tail and status['appended']:
            context['segment'] = {k: tail[k] for k in ('segment_id', 'revision', 'theme_state', 'topic_state', 'start_key', 'end_key')}
            context['segment']['analysis'] = json.loads(tail['analysis_json'])
            if len(encoded(context).encode()) > max_context_bytes:
                raise IndexErrorState('CONTEXT_TOO_LARGE')
            source_map = {m['key']: m for m in messages}
            for old in reversed(members):
                if old['segment_id'] != tail['segment_id']:
                    break
                m = source_map[old['key']]
                candidate = [{'key': m['key'], 'role': m['role'], 'content': m['content']}] + context['messages']
                if len(encoded({**context, 'messages': candidate}).encode()) > max_context_bytes:
                    break
                context['messages'] = candidate
        pending = []
        for m in messages:
            if m['key'] in known:
                continue
            item = {k: m[k] for k in ('key', 'role', 'content')}
            # Reserve 2048 bytes for prompt/schema; no body truncation or full-history fallback.
            if len(encoded({'context': context, 'pending': pending + [item]}).encode()) + 2048 > max_input_bytes:
                if not pending:
                    raise IndexErrorState('MESSAGE_TOO_LARGE')
                break
            pending.append(item)
        manifest = {'conversation_id': cid, 'pending': [fingerprint(m) for m in pending],
                    'context': [fingerprint(m) for m in context['messages']],
                    'context_segment': context['segment'], 'base_digest': digest([members, segments]),
                    'schema_version': SCHEMA_VERSION, 'algorithm_version': ALGORITHM_VERSION,
                    'max_input_bytes': max_input_bytes, 'max_context_bytes': max_context_bytes}
        return {'conversation_id': cid, 'context': context, 'pending': pending, 'manifest': manifest,
                'input_byte_upper_bound': len(encoded({'context': context, 'pending': pending}).encode()) + 2048,
                'remaining_count': len(status['appended']) - len(pending)}

    def prepare_batch(self, plan, *, manual=False):
        """Only an explicit manual action can prepare work; this never executes a request."""
        if manual is not True:
            raise IndexErrorState('MANUAL_TRIGGER_REQUIRED')
        manifest = plan['manifest']
        if not manifest['pending']:
            return {'batch_id': None, 'created': False, 'status': 'no_changes'}
        cid = manifest['conversation_id']
        fresh = self.plan(cid, max_input_bytes=manifest['max_input_bytes'], max_context_bytes=manifest['max_context_bytes'])
        if fresh['manifest'] != manifest:
            raise IndexErrorState('STALE_PLAN')
        batch_id = digest(manifest)
        with self._write() as c:
            c.execute('BEGIN IMMEDIATE')
            if digest(list(self._state(cid, c))) != manifest['base_digest']:
                raise IndexErrorState('INDEX_CHANGED')
            old = c.execute('SELECT status FROM atlas_index_batches WHERE batch_id=?', (batch_id,)).fetchone()
            if old and old['status'] in ('prepared', 'completed'):
                return {'batch_id': batch_id, 'created': False, 'status': old['status']}
            if c.execute("SELECT 1 FROM atlas_index_batches WHERE conversation_id=? AND status='prepared'", (cid,)).fetchone():
                raise IndexErrorState('BATCH_BUSY')
            c.execute('''INSERT INTO atlas_index_batches(batch_id,conversation_id,manifest_json,status,created_at)
                VALUES (?,?,?,'prepared',?) ON CONFLICT(batch_id) DO UPDATE SET
                status='prepared',created_at=excluded.created_at,finished_at=NULL,error_code=NULL''',
                (batch_id, cid, encoded(manifest), now()))
        return {'batch_id': batch_id, 'created': True, 'status': 'prepared'}

    def batch(self, batch_id):
        with self._read() as c:
            row = c.execute('SELECT * FROM atlas_index_batches WHERE batch_id=?', (batch_id,)).fetchone()
            return dict(row) if row else None

    def interrupt(self, batch_id, *, error_code='INTERRUPTED'):
        # Explicit lifecycle operation only; restarting/reading never silently retries a batch.
        if not re.fullmatch('[A-Z_]{1,64}', error_code):
            raise IndexErrorState('INVALID_ERROR_CODE')
        with self._write() as c:
            c.execute("UPDATE atlas_index_batches SET status=?,error_code=?,finished_at=? WHERE batch_id=? AND status='prepared'",
                      ('interrupted' if error_code == 'INTERRUPTED' else 'failed', error_code, now(), batch_id))

    def commit_batch(self, batch_id, updates, *, model, prompt_version=PROMPT_VERSION):
        """Caller supplies validated results. All coverage and checkpoint writes share one transaction."""
        if not isinstance(model, str) or not model.strip() or len(model) > 200:
            raise IndexErrorState('INVALID_MODEL_METADATA')
        if not isinstance(prompt_version, str) or not prompt_version.strip() or len(prompt_version) > 100:
            raise IndexErrorState('INVALID_PROMPT_VERSION')
        writes = [SegmentWrite.model_validate(u) for u in updates]
        result_digest = digest({'updates': [u.model_dump() for u in writes], 'model': model, 'prompt_version': prompt_version})
        job = self.batch(batch_id)
        if job is None:
            raise IndexErrorState('BATCH_NOT_FOUND')
        if job['status'] == 'completed':
            if job['result_digest'] != result_digest:
                raise IndexErrorState('IDEMPOTENCY_CONFLICT')
            return json.loads(job['receipt_json'])
        if job['status'] != 'prepared':
            raise IndexErrorState('BATCH_NOT_PREPARED')
        manifest = json.loads(job['manifest_json'])
        cid = job['conversation_id']
        current = self.plan(cid, max_input_bytes=manifest['max_input_bytes'], max_context_bytes=manifest['max_context_bytes'])
        # Unrelated future append is allowed, but the prepared pending prefix must remain exact.
        n = len(manifest['pending'])
        if (current['manifest']['base_digest'] != manifest['base_digest'] or
                current['manifest']['pending'][:n] != manifest['pending']):
            raise IndexErrorState('SOURCE_CHANGED')
        if [key for u in writes for key in u.message_ids] != [m['key'] for m in manifest['pending']]:
            raise IndexErrorState('PENDING_COVERAGE_INVALID')
        if len({u.segment_id for u in writes}) != len(writes):
            raise IndexErrorState('DUPLICATE_SEGMENT')
        source = self._source(cid)
        positions = {m['key']: i for i, m in enumerate(source)}
        by_key = {m['key']: m for m in source}
        for f in manifest['pending'] + manifest['context']:
            if f['key'] not in by_key or fingerprint(by_key[f['key']]) != f:
                raise IndexErrorState('SOURCE_CHANGED')
        with self._write() as c:
            c.execute('BEGIN IMMEDIATE')
            locked_job = c.execute('SELECT * FROM atlas_index_batches WHERE batch_id=?', (batch_id,)).fetchone()
            if locked_job['status'] == 'completed' and locked_job['result_digest'] == result_digest:
                return json.loads(locked_job['receipt_json'])
            if locked_job['status'] != 'prepared':
                raise IndexErrorState('BATCH_CHANGED')
            members, segments = self._state(cid, c)
            if digest([members, segments]) != manifest['base_digest']:
                raise IndexErrorState('INDEX_CHANGED')
            expected_prefix = [m['key'] for m in members] + [m['key'] for m in manifest['pending']]
            if [m['key'] for m in source[:len(expected_prefix)]] != expected_prefix:
                raise IndexErrorState('SOURCE_CHANGED')
            if any(fingerprint(by_key[m['key']]) != {k: m[k] for k in ('key', 'role', 'body_digest')}
                   for m in members):
                raise IndexErrorState('SOURCE_CHANGED')
            for i, u in enumerate(writes):
                existing = next((s for s in segments if s['segment_id'] == u.segment_id), None)
                if u.operation == 'extend':
                    if (i != 0 or not existing or not members or members[-1]['segment_id'] != u.segment_id
                            or existing['topic_state'] != 'open'):
                        raise IndexErrorState('EXTEND_NOT_OPEN_TAIL')
                elif existing:
                    raise IndexErrorState('SEGMENT_EXISTS')
                allowed = set(u.message_ids)
                if existing:
                    allowed.update(m['key'] for m in members if m['segment_id'] == u.segment_id)
                refs = {r.message_id for e in u.analysis.outcome_evidence for r in e.sources}
                refs.update(r.message_id for r in u.analysis.key_assistant_answers)
                if not refs <= allowed:
                    raise IndexErrorState('REFERENCE_OUTSIDE_SEGMENT')
                available = set(u.message_ids) | {m['key'] for m in manifest['context']}
                if existing:
                    prior = SemanticAnalysis.model_validate_json(existing['analysis_json'])
                    available.update(r.message_id for e in prior.outcome_evidence for r in e.sources)
                    available.update(r.message_id for r in prior.key_assistant_answers)
                if not refs <= available:
                    raise IndexErrorState('REFERENCE_NOT_PROVIDED')
                answers = [r.message_id for r in u.analysis.key_assistant_answers]
                if len(answers) != len(set(answers)):
                    raise IndexErrorState('DUPLICATE_ANSWER_REFERENCE')
                validate_references(u.analysis, {'messages': [by_key[k] for k in allowed]})
                c.execute('''INSERT INTO atlas_segments VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
                    ON CONFLICT(conversation_id,segment_id) DO UPDATE SET
                    revision=excluded.revision,end_key=excluded.end_key,analysis_json=excluded.analysis_json,
                    theme_state=excluded.theme_state,topic_state=excluded.topic_state,
                    model=excluded.model,prompt_version=excluded.prompt_version,analyzed_at=excluded.analyzed_at''',
                    (cid, u.segment_id, existing['revision'] + 1 if existing else 1,
                     existing['start_key'] if existing else u.message_ids[0], u.message_ids[-1],
                     encoded(u.analysis.model_dump()), u.theme_state, 'open' if i == len(writes) - 1 else 'stable',
                     SCHEMA_VERSION, ALGORITHM_VERSION, prompt_version, model, now()))
                for key in u.message_ids:
                    f = fingerprint(by_key[key])
                    c.execute('INSERT INTO atlas_indexed_messages VALUES (?,?,?,?,?,?)',
                              (cid, key, f['role'], f['body_digest'], positions[key], u.segment_id))
            if members and writes[0].operation == 'create':
                c.execute("UPDATE atlas_segments SET topic_state='stable' WHERE conversation_id=? AND segment_id=?", (cid, members[-1]['segment_id']))
            receipt = {'batch_id': batch_id, 'status': 'completed', 'covered': len(manifest['pending']),
                       'segment_ids': [u.segment_id for u in writes]}
            c.execute("UPDATE atlas_index_batches SET status='completed',finished_at=?,result_digest=?,receipt_json=? WHERE batch_id=?",
                      (now(), result_digest, encoded(receipt), batch_id))
        return receipt

    def read_segments(self, cid):
        """Read old results even if source is blocked; return explicit current validity alongside."""
        _, segments = self._state(cid)
        quality = self.inspect(cid)
        return {'segments': [{**s, 'analysis': json.loads(s['analysis_json'])} for s in segments],
                'source_status': quality['status'], 'source_reason': quality['reason']}
