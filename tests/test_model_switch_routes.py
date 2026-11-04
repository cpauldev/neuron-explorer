"""Exercise workspace publication and rollback without allocating model weights."""
from pathlib import Path
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

from server_fixture import load_server


class FakeRuntime:
    def __init__(self, *args, **kwargs):
        self.loaded = self.unloaded = self.closed = 0
        self.status = 'ready'
    def ensure_loaded(self): self.loaded += 1
    def unload(self): self.unloaded += 1
    def close(self): self.closed += 1


class WorkspaceSwitchTests(unittest.IsolatedAsyncioTestCase):
    async def test_publish_uses_existing_paths_and_clears_model_specific_state(self):
        server = load_server()
        old = FakeRuntime()
        with tempfile.TemporaryDirectory() as folder:
            paths = {key: Path(folder) / key for key in ('stats', 'cache', 'runs', 'names')}
            server._infer['old'] = 'activation'
            server._chats['old'] = {'history': 'old model'}
            with patch.object(server, 'rt', old), patch.object(server, 'NO_MODEL', False), patch.object(server, 'Runtime', FakeRuntime), patch.object(server, 'data_paths', return_value=paths) as data_paths, patch.object(server.agent_pool, 'close', AsyncMock()):
                await server.switch_model({'model': 'Qwen/new', 'revision': 'pinned', 'path': folder})
                self.assertEqual(server.MODEL, 'Qwen/new')
                self.assertEqual(server.REVISION, 'pinned')
                self.assertEqual(server.AGENT_DIR, str(paths['cache'] / 'agent'))
                self.assertEqual(server.rt.loaded, 1)
                self.assertFalse(server._infer)
                self.assertFalse(server._chats)
                data_paths.assert_called_once_with('Qwen/new', 'pinned')
        self.assertEqual(old.unloaded, 1)
        self.assertEqual(old.closed, 1)

    async def test_load_failure_restores_old_runtime_without_publishing_new_identity(self):
        server = load_server()
        original = server.MODEL
        old = FakeRuntime()
        candidate = FakeRuntime()
        def fail(): raise RuntimeError('insufficient memory')
        candidate.ensure_loaded = fail
        with tempfile.TemporaryDirectory() as folder:
            paths = {key: Path(folder) / key for key in ('stats', 'cache', 'runs', 'names')}
            with patch.object(server, 'rt', old), patch.object(server, 'NO_MODEL', False), patch.object(server, 'Runtime', return_value=candidate), patch.object(server, 'data_paths', return_value=paths), patch.object(server.agent_pool, 'close', AsyncMock()):
                with self.assertRaisesRegex(RuntimeError, 'insufficient memory'):
                    await server.switch_model({'model': 'Qwen/new', 'revision': 'pinned', 'path': folder})
                self.assertIs(server.rt, old)
                self.assertEqual(server.MODEL, original)
        self.assertEqual(candidate.closed, 1)
        self.assertEqual(old.loaded, 1)
        self.assertEqual(old.closed, 0)
