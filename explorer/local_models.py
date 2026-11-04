"""Local checkpoint discovery and a single, observable model-switch transaction."""
import asyncio
import json
import time
import uuid
from pathlib import Path

from model_config import validate_config, model_key


def checkpoint_ready(path):
    path = Path(path)
    try:
        validate_config(json.loads((path / 'config.json').read_text()))
        index = path / 'model.safetensors.index.json'
        files = set(json.loads(index.read_text())['weight_map'].values()) if index.is_file() else {'model.safetensors'}
        return bool(files) and all((path / name).is_file() for name in files) and (path / 'tokenizer.json').is_file()
    except (OSError, ValueError, KeyError, TypeError):
        return False


class LocalModels:
    def __init__(self, current, switch, busy):
        self.current, self.switch, self.busy = current, switch, busy
        self.generation = uuid.uuid4().hex
        self.phase, self.error, self.target = 'idle', None, None
        self.entries, self.scanned = [], float('-inf')
        self.task = None
        self.active = 0

    def catalog(self):
        if time.monotonic() - self.scanned < 30:
            return self.entries
        from huggingface_hub import scan_cache_dir
        entries = []
        try:
            repos = scan_cache_dir().repos
        except (OSError, ValueError):
            repos = []
        for repo in repos:
            if repo.repo_type != 'model':
                continue
            for rev in repo.revisions:
                if not checkpoint_ready(rev.snapshot_path):
                    continue
                revision = None if 'main' in rev.refs else rev.commit_hash
                entries.append({'id': model_key(repo.repo_id, revision), 'model': repo.repo_id,
                                'revision': revision, 'path': str(rev.snapshot_path)})
        self.entries = sorted(entries, key=lambda item: (item['model'], item['revision'] or ''))
        self.scanned = time.monotonic()
        return self.entries

    def state(self):
        model, revision = self.current()
        entries = [{k: v for k, v in item.items() if k != 'path'} for item in self.catalog()]
        current = model_key(model, revision)
        if not any(item['id'] == current for item in entries):
            entries.insert(0, {'id': current, 'model': model, 'revision': revision})
        return {'models': entries, 'current': current, 'generation': self.generation,
                'phase': self.phase, 'error': self.error, 'target': self.target}

    async def start(self, identifier):
        if self.phase != 'idle' or self.active or self.busy():
            raise ValueError('Finish the current analysis or chat before switching models.')
        entry = next((item for item in self.catalog() if item['id'] == identifier), None)
        if entry is None or not checkpoint_ready(entry['path']):
            raise ValueError('This local checkpoint is incomplete or unavailable. Refresh the model list.')
        if identifier == model_key(*self.current()):
            return
        self.phase, self.error, self.target = 'loading', None, identifier
        self.task = asyncio.create_task(self._run(entry))

    async def _run(self, entry):
        try:
            await self.switch(entry)
            self.generation = uuid.uuid4().hex
        except Exception:
            # Detailed exceptions stay in server logs, not the model picker.
            import logging
            logging.getLogger(__name__).exception('Model switch failed')
            self.error = 'Could not load this model. The previous model is still selected. Check server logs, then retry.'
        finally:
            self.phase, self.target = 'idle', None


class ModelGate:
    """Drain finite API requests before switching; keep observer streams responsive."""
    def __init__(self, app, manager):
        self.app, self.manager = app, manager

    async def __call__(self, scope, receive, send):
        path = scope.get('path', '')
        exempt = path in ('/api/models', '/api/status', '/api/agent/events', '/api/agent/ui/events')
        guarded = scope['type'] == 'http' and path.startswith('/api/') and not exempt
        if guarded:
            headers = dict(scope.get('headers', []))
            stale = headers.get(b'x-explorer-generation', self.manager.generation.encode()) != self.manager.generation.encode()
            if self.manager.phase != 'idle' or stale:
                from starlette.responses import JSONResponse
                await JSONResponse({'error': 'Model changed or is loading. Reload the workspace.'}, status_code=409)(scope, receive, send)
                return
            self.manager.active += 1
        try:
            await self.app(scope, receive, send)
        finally:
            if guarded:
                self.manager.active -= 1
