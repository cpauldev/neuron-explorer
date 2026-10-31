import asyncio
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'explorer'))
from agent_models import model_catalog, validate_model, _cache
from codex_agent import CodexClient
from claude_agent import ClaudeClient


class ModelTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        _cache.clear()

    async def test_codex_discovery_paginates_deduplicates_and_closes_without_thread(self):
        class Client:
            closed = 0
            def __init__(self, *_): pass
            async def start(self): pass
            async def call(self, method, params):
                self.assert_method = method
                if params['cursor'] is None:
                    return {'data': [{'model': 'real-model', 'displayName': 'Real model'}], 'nextCursor': 'more'}
                return {'data': [{'model': 'real-model'}, {'model': 'other-model'}]}
            async def close(self): Client.closed += 1
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, {}, clear=True):
            result = await model_catalog('codex', folder, Client)
            self.assertEqual([m['id'] for m in result['models']], ['default', 'real-model', 'other-model'])
            self.assertEqual(Client.closed, 1)
            self.assertIsNone(result['warning'])

    async def test_failed_discovery_keeps_default_and_configured_model(self):
        class Client:
            closed = False
            def __init__(self, *_): pass
            async def start(self): raise OSError('CLI unavailable')
            async def close(self): Client.closed = True
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, {'EXPLORER_CODEX_MODEL': 'configured-model'}):
            result = await model_catalog('codex', folder, Client)
            self.assertEqual([m['id'] for m in result['models']], ['default', 'configured-model'])
            self.assertIn('CLI unavailable', result['warning'])
            self.assertTrue(Client.closed)

    async def test_model_override_reaches_both_clients_without_global_env_changes(self):
        from unittest.mock import AsyncMock
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, {'EXPLORER_CODEX_MODEL': 'server-default', 'EXPLORER_CLAUDE_MODEL': 'server-default'}):
            codex = CodexClient(folder, asyncio.Queue())
            codex.model = 'chosen-model'
            codex.call = AsyncMock(side_effect=[{'config': {}}, {'thread': {'id': 'owned'}}])
            await codex.open_thread(folder, 'chat', 8791, 'instructions')
            self.assertEqual(codex.call.call_args.args[1]['model'], 'chosen-model')
            claude = ClaudeClient(folder, asyncio.Queue())
            claude.model = 'sonnet'
            await claude.open_thread(folder, 'chat', 8791, 'instructions')
            self.assertEqual(claude.args[-2:], ['--model', 'sonnet'])
            self.assertEqual(os.environ['EXPLORER_CODEX_MODEL'], 'server-default')

    async def test_cli_default_is_explicit_when_resuming_after_an_override(self):
        from unittest.mock import AsyncMock
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, {}, clear=True):
            codex = CodexClient(folder, asyncio.Queue())
            codex.model = None
            codex.call = AsyncMock(side_effect=[{'config': {}}, {'data': [{'model': 'actual-default', 'isDefault': True}]}, {'thread': {'id': 'owned'}}])
            await codex.open_thread(folder, 'chat', 8791, 'instructions', 'owned')
            self.assertEqual(codex.call.call_args.args[0], 'thread/resume')
            self.assertEqual(codex.call.call_args.args[1]['model'], 'actual-default')
            claude = ClaudeClient(folder, asyncio.Queue())
            await claude.open_thread(folder, 'chat', 8791, 'instructions', 'owned')
            self.assertEqual(claude.args[-2:], ['--model', 'default'])

    def test_model_identifier_rejects_flags_and_structured_values(self):
        for bad in ('--flag', '', {}, 4, 'a\nb', 'x' * 161):
            with self.assertRaises(ValueError): validate_model(bad)
        self.assertEqual(validate_model('sonnet[1m]'), 'sonnet[1m]')
        self.assertIsNone(validate_model(None))
