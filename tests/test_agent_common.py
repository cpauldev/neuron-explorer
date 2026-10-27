import asyncio
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'explorer'))
from agent_common import AgentError, AgentPool, explorer_mcp, process_options, stop_process, tool_output


class CommonTests(unittest.IsolatedAsyncioTestCase):
    async def test_process_cleanup_targets_the_tree(self):
        proc = AsyncMock(pid=12345, returncode=None)
        if os.name == 'nt':
            killer = AsyncMock()
            with patch('agent_common.asyncio.create_subprocess_exec', return_value=killer) as spawn:
                await stop_process(proc)
            self.assertEqual(spawn.call_args.args, ('taskkill', '/PID', '12345', '/T', '/F'))
        else:
            with patch('agent_common.os.killpg') as kill:
                await stop_process(proc)
            self.assertEqual(kill.call_args.args[0], 12345)
        proc.wait.assert_awaited_once()

    def test_shared_mcp_and_output_contract(self):
        config = explorer_mcp(Path.cwd(), 'owned-chat', 8792)
        self.assertEqual(config['command'], sys.executable)
        self.assertEqual(config['env'], {'EXPLORER_URL': 'http://127.0.0.1:8792', 'EXPLORER_CHAT': 'owned-chat'})
        self.assertEqual(tool_output('abc', 2), 'ab … (3 chars)')
        self.assertEqual(tool_output('ok'), 'ok')
        self.assertTrue('creationflags' in process_options() if os.name == 'nt' else process_options()['start_new_session'])


class PoolTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.now, self.created = 0, []
        self.pool = AgentPool(idle_seconds=10, max_idle=1, clock=lambda: self.now)

    def factory(self):
        client = AsyncMock(alive=True, queue=asyncio.Queue())
        async def close(): client.alive = False
        client.close.side_effect = close
        self.created.append(client)
        return client

    async def acquire(self, chat='chat', policy=('codex', 'project')):
        return await self.pool.acquire(chat, policy, self.factory, AsyncMock(return_value='owned-thread'))

    async def test_reuses_client_and_drops_idle_events(self):
        first = await self.acquire()
        with self.assertRaisesRegex(AgentError, 'already running'):
            await self.acquire()
        await self.pool.release('chat', first['client'], True)
        first['client'].queue.put_nowait(('event', {'t': 'text', 'text': 'old'}))
        again = await self.acquire()
        self.assertIs(again, first)
        self.assertTrue(again['client'].queue.empty())
        self.assertEqual(len(self.created), 1)
        await self.pool.release('chat', again['client'], False)
        again['client'].close.assert_awaited_once()

    async def test_policy_changes_and_dead_clients_resume_with_new_process(self):
        first = await self.acquire()
        await self.pool.release('chat', first['client'], True)
        changed = await self.acquire(policy=('codex', 'home'))
        self.assertIsNot(changed['client'], first['client'])
        first['client'].close.assert_awaited_once()
        await self.pool.release('chat', changed['client'], True)
        changed['client'].alive = False
        recovered = await self.acquire(policy=('codex', 'home'))
        self.assertIsNot(recovered['client'], changed['client'])
        await self.pool.close()

    async def test_idle_limit_expiration_and_shutdown(self):
        first = await self.acquire('first')
        await self.pool.release('first', first['client'], True)
        self.now = 1
        second = await self.acquire('second')
        await self.pool.release('second', second['client'], True)
        self.assertNotIn('first', self.pool.clients)
        first['client'].close.assert_awaited_once()
        self.now = 12
        await self.pool.reap()
        self.assertEqual(self.pool.clients, {})
        active = await self.acquire()
        self.now = 100
        await self.pool.reap()
        self.assertTrue(active['client'].alive, 'expiration must not interrupt an active reply')
        await self.pool.close()
        self.assertFalse(active['client'].alive)

    async def test_cancelled_configuration_closes_partial_process(self):
        entered = asyncio.Event()
        async def connect(client):
            entered.set()
            await asyncio.Event().wait()
        task = asyncio.create_task(self.pool.acquire('chat', (), self.factory, connect))
        await entered.wait()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError): await task
        self.created[0].close.assert_awaited_once()
        self.assertEqual(self.pool.clients, {})

    async def test_reaper_rechecks_clients_that_become_active_while_closing_another(self):
        self.pool.max_idle = 2
        first = await self.acquire('first')
        await self.pool.release('first', first['client'], True)
        self.now = 1
        second = await self.acquire('second')
        await self.pool.release('second', second['client'], True)
        entered, release = asyncio.Event(), asyncio.Event()
        async def close():
            entered.set()
            await release.wait()
            first['client'].alive = False
        first['client'].close.side_effect = close
        self.now = 10
        reaping = asyncio.create_task(self.pool.reap())
        await entered.wait()
        self.assertIs(await self.acquire('second'), second)
        self.now = 12
        release.set()
        await reaping
        self.assertTrue(second['client'].alive)
        self.assertTrue(second['busy'])
        await self.pool.close()

    async def test_cancelled_reaper_finishes_process_cleanup(self):
        entry = await self.acquire()
        await self.pool.release('chat', entry['client'], True)
        entered, release = asyncio.Event(), asyncio.Event()
        async def close():
            entered.set()
            await release.wait()
            entry['client'].alive = False
        entry['client'].close.side_effect = close
        self.now = 11
        reaping = asyncio.create_task(self.pool.reap())
        await entered.wait()
        reaping.cancel()
        await asyncio.sleep(0)
        self.assertFalse(reaping.done())
        release.set()
        with self.assertRaises(asyncio.CancelledError): await reaping
        self.assertFalse(entry['client'].alive)
