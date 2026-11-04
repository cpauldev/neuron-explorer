import asyncio
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'explorer'))
from local_models import LocalModels, ModelGate, checkpoint_ready
from model_config import model_key


class LocalModelTests(unittest.IsolatedAsyncioTestCase):
    def test_only_complete_supported_checkpoints_are_offered(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            (path / 'config.json').write_text(json.dumps({'model_type': 'qwen3_5_text',
                'num_hidden_layers': 2, 'hidden_size': 4, 'intermediate_size': 8}))
            (path / 'tokenizer.json').touch()
            (path / 'model.safetensors.index.json').write_text(json.dumps({'weight_map': {'a': 'part.safetensors'}}))
            self.assertFalse(checkpoint_ready(path))
            (path / 'part.safetensors').touch()
            self.assertTrue(checkpoint_ready(path))
            (path / 'config.json').write_text('{"model_type":"llama"}')
            self.assertFalse(checkpoint_ready(path))

    async def test_switch_is_exclusive_and_publishes_only_on_success(self):
        current = ['old', None]
        entered, release = asyncio.Event(), asyncio.Event()
        async def switch(entry):
            entered.set()
            await release.wait()
            current[:] = [entry['model'], entry['revision']]
        manager = LocalModels(lambda: tuple(current), switch, lambda: False)
        entry = {'id': model_key('new'), 'model': 'new', 'revision': None, 'path': 'local'}
        generation = manager.generation
        with patch.object(manager, 'catalog', return_value=[entry]), patch('local_models.checkpoint_ready', return_value=True):
            await manager.start(entry['id'])
            await entered.wait()
            self.assertEqual(manager.generation, generation)
            self.assertEqual(current[0], 'old')
            with self.assertRaises(ValueError): await manager.start(entry['id'])
            release.set()
            await manager.task
        self.assertEqual(manager.phase, 'idle')
        self.assertNotEqual(manager.generation, generation)
        self.assertEqual(current[0], 'new')

    async def test_busy_requests_and_chats_reject_switch(self):
        manager = LocalModels(lambda: ('old', None), None, lambda: True)
        with self.assertRaisesRegex(ValueError, 'Finish'): await manager.start('new')
        manager.busy = lambda: False
        manager.active = 1
        with self.assertRaisesRegex(ValueError, 'Finish'): await manager.start('new')

    def test_discovery_is_cached_and_does_not_expose_snapshot_paths(self):
        from types import SimpleNamespace
        revision = SimpleNamespace(snapshot_path='local', refs={'main'}, commit_hash='abc')
        repo = SimpleNamespace(repo_id='Qwen/test', repo_type='model', revisions=[revision])
        manager = LocalModels(lambda: ('Qwen/test', None), None, lambda: False)
        with patch('huggingface_hub.scan_cache_dir', return_value=SimpleNamespace(repos=[repo])) as scan, patch('local_models.checkpoint_ready', return_value=True):
            state = manager.state()
            manager.state()
        scan.assert_called_once()
        self.assertNotIn('path', state['models'][0])

    async def test_failure_keeps_generation_and_previous_model(self):
        async def fail(entry): raise RuntimeError('load failed')
        manager = LocalModels(lambda: ('old', None), fail, lambda: False)
        entry = {'id': 'new', 'path': 'local'}
        generation = manager.generation
        with patch.object(manager, 'catalog', return_value=[entry]), patch('local_models.checkpoint_ready', return_value=True), self.assertLogs('local_models', level='ERROR'):
            await manager.start('new')
            await manager.task
        self.assertEqual(manager.generation, generation)
        self.assertEqual(manager.phase, 'idle')
        self.assertIn('previous model', manager.error)

    async def test_gate_rejects_stale_clients_and_loading_but_allows_status(self):
        manager = LocalModels(lambda: ('old', None), None, lambda: False)
        async def app(scope, receive, send):
            await send({'type': 'http.response.start', 'status': 200, 'headers': []})
            await send({'type': 'http.response.body', 'body': b'ok'})
        gate = ModelGate(app, manager)
        async def request(path, headers=[]):
            messages = []
            async def send(message): messages.append(message)
            await gate({'type':'http', 'path':path, 'headers':headers}, None, send)
            return messages[0]['status']
        self.assertEqual(await request('/api/infer', [(b'x-explorer-generation', b'old')]), 409)
        manager.phase = 'loading'
        self.assertEqual(await request('/api/index'), 409)
        self.assertEqual(await request('/api/status'), 200)
        manager.phase = 'idle'
        self.assertEqual(await request('/api/index'), 200)
        self.assertEqual(manager.active, 0)
