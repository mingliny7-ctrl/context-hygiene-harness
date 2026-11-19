"""One bounded scan per page open, sharing the existing indexer and its receipts."""
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from datetime import datetime, timezone
import json
import threading
import time

from shared.conversation_store.store import list_stored_conversations
from .incremental_index import IndexErrorState
from .indexer import ExecutionLock


class OpenAnalysis:
    def __init__(self, indexer, management):
        self.indexer, self.management = indexer, management
        self.guard = threading.Lock()
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix='atlas-open')
        self.future = None
        self.state = {'status':'idle', 'requests':0, 'completed':0, 'skipped':0, 'errorCode':None}

    def status(self):
        with self.guard:
            return dict(self.state)

    def _update(self, **changes):
        with self.guard:
            self.state.update(changes)

    def start(self):
        with self.guard:
            if self.future and not self.future.done():
                return dict(self.state)
            lock = ExecutionLock(str(self.indexer.index.path) + '.open')
            self.state = {'status':'queued', 'requests':0, 'completed':0, 'skipped':0, 'errorCode':None}
            try:
                self.future = self.executor.submit(self._execute, lock)
            except Exception:
                lock.close()
                raise
            return dict(self.state)

    def _execute(self, lock):
        budget = self.indexer.budget
        requests = input_tokens = output_tokens = completed = skipped = 0
        started = time.monotonic()
        try:
            self._update(status='running')
            index = self.indexer.index
            if index.path.is_file():
                with index._read() as c:
                    installed = c.execute("SELECT 1 FROM sqlite_master WHERE name='atlas_index_runs'").fetchone()
                    recent = c.execute('SELECT created_at,budget_json FROM atlas_index_runs ORDER BY created_at DESC LIMIT 1').fetchone() if installed else None
                if recent and json.loads(recent['budget_json']).get('trigger') == 'open':
                    age = (datetime.now(timezone.utc)-datetime.fromisoformat(recent['created_at'])).total_seconds()
                    if age < 60:
                        self._update(status='paused', errorCode='OPEN_COOLDOWN')
                        return
            rows = list_stored_conversations(index.source_db)
            rows.sort(key=lambda row: (row.get('updated_at') or '', row['conversation_id']), reverse=True)
            for row in rows:
                cid = row['conversation_id']
                if cid in self.management.hidden_ids():
                    continue
                source = index.inspect(cid)
                if source['status'] != 'ready':
                    skipped += 1
                    self._update(skipped=skipped, errorCode=source['reason'])
                    continue
                if not source['appended']:
                    continue
                previous = self.indexer.latest(cid)
                if previous:
                    settings = json.loads(previous['budget_json'])
                    target = json.loads(previous['target_json'])
                    if (settings.get('trigger') == 'open' and previous['status'] in ('failed','interrupted')
                            and isinstance(target,list) and set(target) & set(source['appended'])):
                        skipped += 1  # Failed/unknown paid ranges require an explicit retry.
                        self._update(skipped=skipped, errorCode=previous['error_code'])
                        continue
                    if settings.get('trigger') == 'open':
                        age = (datetime.now(timezone.utc)-datetime.fromisoformat(previous['created_at'])).total_seconds()
                        if age < 60:
                            skipped += 1
                            self._update(skipped=skipped)
                            continue
                remaining_seconds = int(budget.seconds - (time.monotonic()-started))
                if (requests >= budget.requests or budget.input_tokens-input_tokens < 16000
                        or budget.output_tokens-output_tokens < budget.per_output or remaining_seconds <= 0):
                    self._update(status='paused', errorCode='BUDGET_EXHAUSTED')
                    return
                remaining = replace(budget, requests=budget.requests-requests,
                    input_tokens=budget.input_tokens-input_tokens,
                    output_tokens=budget.output_tokens-output_tokens, seconds=remaining_seconds)
                self._update(conversationId=cid)
                try:
                    task = self.indexer.start(cid, budget=remaining, trigger='open', allow_reuse=False)
                except IndexErrorState as error:
                    skipped += 1
                    self._update(skipped=skipped, errorCode=str(error))
                    if str(error) == 'TASK_BUSY':
                        self._update(status='paused')
                        return
                    continue
                if task['status'] == 'no_changes':
                    continue
                self.indexer.future.result()
                task = self.indexer.latest(cid)
                requests += task['requests']
                input_tokens += task['input_tokens']
                output_tokens += task['output_tokens']
                if task['status'] == 'completed':
                    completed += 1
                self._update(requests=requests, completed=completed,
                    inputTokens=input_tokens, outputTokens=output_tokens,
                    errorCode=task['error_code'])
                if task['status'] == 'paused':
                    self._update(status='paused')
                    return
                if task['error_code'] in ('AUTH_FAILED','CONFIG_MISSING','INSUFFICIENT_BALANCE','RATE_LIMITED','MODEL_UNAVAILABLE','REQUEST_TIMEOUT'):
                    self._update(status='failed')
                    return
            self._update(status='completed', conversationId=None)
        except Exception as error:
            self._update(status='failed', errorCode=str(error) if isinstance(error,IndexErrorState) else 'INDEX_TASK_FAILED')
        finally:
            lock.close()

    def close(self):
        self.executor.shutdown(wait=True)
