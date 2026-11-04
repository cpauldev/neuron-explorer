"""Exercise FastAPI startup and shutdown without loading model weights."""
import types
import unittest
from unittest.mock import AsyncMock, patch

from server_fixture import load_server


class LifespanTests(unittest.IsolatedAsyncioTestCase):
    async def test_lifespan_starts_preload_and_cleans_up_the_reaper_and_pool(self):
        server = load_server()
        pool = types.SimpleNamespace(reap=AsyncMock(), close=AsyncMock())
        with patch.object(server, 'agent_pool', pool), patch.object(server, 'preload') as preload:
            async with server.app.router.lifespan_context(server.app):
                preload.assert_called_once()
                reaper = server.agent_reaper
                self.assertFalse(reaper.done())
                pool.close.assert_not_awaited()
            self.assertTrue(reaper.cancelled())
            pool.close.assert_awaited_once()

    async def test_failed_startup_still_cleans_up_started_resources(self):
        server = load_server()
        pool = types.SimpleNamespace(reap=AsyncMock(), close=AsyncMock())
        with patch.object(server, 'agent_pool', pool), \
             patch.object(server, 'preload', side_effect=RuntimeError('startup failed')):
            with self.assertRaisesRegex(RuntimeError, 'startup failed'):
                async with server.app.router.lifespan_context(server.app):
                    self.fail('Failed startup must not serve requests')
            self.assertTrue(server.agent_reaper.cancelled())
            pool.close.assert_awaited_once()
