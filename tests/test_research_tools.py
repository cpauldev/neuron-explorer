import asyncio
import json
import os
from pathlib import Path
import tempfile
import socket
import sys
import threading
import unittest
from unittest.mock import AsyncMock, patch

from server_fixture import JsonRequest, load_server

from research_tools import file_operation, scoped_path, run_shell


server = load_server()


class FileScopeTests(unittest.TestCase):
    def test_truncated_utf8_read_does_not_split_a_character(self):
        with tempfile.TemporaryDirectory() as folder:
            (Path(folder) / 'text.txt').write_text('abc🐕', encoding='utf-8')
            with patch('research_tools.MAX_TEXT', 4):
                result = file_operation(folder, 'project', 'read', 'text.txt')
            self.assertEqual(result['text'], 'abc')
            self.assertTrue(result['truncated'])

    def test_project_paths_traversal_and_home_opt_in(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / 'project'; root.mkdir()
            home = Path(folder) / 'home'; home.mkdir()
            with patch('research_tools.Path.home', return_value=home):
                file_operation(root, 'project', 'write', 'work/probe.py', 'print(1)')
                self.assertEqual(file_operation(root, 'project', 'read', 'work/probe.py')['text'], 'print(1)')
                for path in ('../home/private.txt', str(home / 'private.txt')):
                    with self.assertRaisesRegex(ValueError, 'outside'):
                        scoped_path(root, 'project', path)
                file_operation(root, 'home', 'write', str(home / 'probe.txt'), 'allowed')
                self.assertEqual((home / 'probe.txt').read_text(), 'allowed')
                with self.assertRaisesRegex(ValueError, 'outside'):
                    scoped_path(root, 'home', str(Path(folder) / 'other'))
                with self.assertRaises(ValueError): scoped_path(root, 'invalid', '.')

    def test_symlink_cannot_escape_file_scope(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / 'project'; root.mkdir()
            outside = Path(folder) / 'outside'; outside.mkdir()
            try:
                (root / 'link').symlink_to(outside, target_is_directory=True)
            except OSError:
                self.skipTest('OS does not grant symlink creation')
            with self.assertRaisesRegex(ValueError, 'outside'):
                file_operation(root, 'project', 'write', 'link/escape.txt', 'blocked')
            self.assertFalse((outside / 'escape.txt').exists())


class ApprovalTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.queue = asyncio.Queue()
        self.cancel = asyncio.Event()
        self.chat = {'queue': self.queue, 'cancel': self.cancel, 'access': 'project', 'approvals': {}}
        server._chats['test-chat'] = self.chat
        self.patches = [patch.object(server, 'ROOT', self.temp.name), patch.object(server, 'AGENT_DIR', self.temp.name)]
        for p in self.patches: p.start()

    async def asyncTearDown(self):
        server._chats.pop('test-chat', None)
        for p in self.patches: p.stop()
        self.temp.cleanup()

    async def test_command_never_runs_before_approval_or_after_decline(self):
        runner = AsyncMock(return_value={'exit_code': 0, 'output': 'ok'})
        with patch.object(server, 'run_shell', runner):
            task = asyncio.create_task(server.agent_shell(JsonRequest(chat='test-chat', command='echo probe')))
            kind, event = await asyncio.wait_for(self.queue.get(), 2)
            self.assertEqual(event['t'], 'approval')
            runner.assert_not_called()
            await server.agent_approval(JsonRequest(chat='test-chat', id=event['id'], allow=False))
            self.assertIn('declined', (await task)['error'])
            runner.assert_not_called()
            task = asyncio.create_task(server.agent_shell(JsonRequest(chat='test-chat', command='echo approved')))
            _, event = await self.queue.get()
            await server.agent_approval(JsonRequest(chat='test-chat', id=event['id'], allow=True))
            self.assertEqual((await task)['output'], 'ok')
            runner.assert_awaited_once()
            self.assertEqual(runner.call_args.args[0], 'echo approved')
            stale = await server.agent_approval(JsonRequest(chat='test-chat', id=event['id'], allow=True))
            self.assertEqual(stale.status_code, 409)

    async def test_cancelled_approval_cannot_run_in_next_turn(self):
        runner = AsyncMock()
        with patch.object(server, 'run_shell', runner):
            task = asyncio.create_task(server.agent_shell(JsonRequest(chat='test-chat', command='echo stale')))
            _, event = await self.queue.get()
            pending = self.chat['approvals'][event['id']]
            self.cancel.set()
            pending.set_result(True)
            # Simulate a new turn replacing mutable state while the old request wakes.
            self.chat.update(cancel=asyncio.Event(), approvals={})
            self.assertIn('stopped', (await task)['error'])
            runner.assert_not_called()

    async def test_tool_cannot_choose_its_own_file_scope(self):
        outside = self.root.parent / 'outside-probe.txt'
        response = await server.agent_files(JsonRequest(chat='test-chat', operation='write', path=str(outside), content='blocked', access='home'))
        self.assertEqual(response.status_code, 400)
        self.assertIn('outside', json.loads(response.body)['error'])


class ShellTests(unittest.IsolatedAsyncioTestCase):
    async def test_output_timeout_and_cancellation(self):
        with tempfile.TemporaryDirectory() as folder:
            command = "Write-Output 'research-ok'" if os.name == 'nt' else "printf research-ok"
            result = await run_shell(command, folder, 10, folder, asyncio.Event())
            self.assertEqual(result['exit_code'], 0)
            self.assertIn('research-ok', result['output'])
            sleeping = 'Start-Sleep -Seconds 30' if os.name == 'nt' else 'sleep 30'
            result = await run_shell(sleeping, folder, 1, folder, asyncio.Event())
            self.assertTrue(result['timed_out'])
            cancel = asyncio.Event()
            task = asyncio.create_task(run_shell(sleeping, folder, 20, folder, cancel))
            await asyncio.sleep(.2)
            cancel.set()
            result = await task
            self.assertTrue(result['cancelled'])


class McpIntegrationTests(unittest.IsolatedAsyncioTestCase):
    async def test_real_mcp_file_tools_and_browser_shell_approval(self):
        import httpx
        import uvicorn
        import uuid
        script = Path(__file__).resolve().parents[1] / 'explorer' / 'agent_mcp.py'
        with tempfile.TemporaryDirectory() as folder:
            sock = socket.socket(); sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
            cid = str(uuid.uuid4())
            queue, cancel = asyncio.Queue(), asyncio.Event()
            server._chats[cid] = {'queue': queue, 'cancel': cancel, 'access': 'project', 'approvals': {}}
            patches = [patch.object(server, 'ROOT', folder), patch.object(server, 'AGENT_DIR', folder),
                       patch.object(server, 'LOCAL_HOSTS', {f'127.0.0.1:{port}'})]
            for p in patches: p.start()
            web = uvicorn.Server(uvicorn.Config(server.app, log_level='error', lifespan='off'))
            thread = threading.Thread(target=lambda: web.run(sockets=[sock]), daemon=True)
            thread.start()
            proc = None
            try:
                for _ in range(100):
                    if web.started: break
                    await asyncio.sleep(.02)
                env = {**os.environ, 'EXPLORER_URL': f'http://127.0.0.1:{port}', 'EXPLORER_CHAT': cid}
                proc = await asyncio.create_subprocess_exec(sys.executable, str(script), env=env,
                    stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)

                async def send(id_, method, params):
                    proc.stdin.write((json.dumps({'id': id_, 'method': method, 'params': params}) + '\n').encode())
                    await proc.stdin.drain()

                async def receive():
                    return json.loads(await asyncio.wait_for(proc.stdout.readline(), 15))

                await send(1, 'initialize', {'protocolVersion': '2025-06-18'})
                self.assertIn('result', await receive())
                await send(2, 'tools/list', {})
                names = {tool['name'] for tool in (await receive())['result']['tools']}
                self.assertTrue({'read_file', 'write_file', 'list_files', 'run_shell'} <= names)
                await send(3, 'tools/call', {'name': 'write_file', 'arguments': {'path': 'probe.txt', 'content': 'evidence'}})
                self.assertFalse((await receive())['result']['isError'])
                await send(4, 'tools/call', {'name': 'read_file', 'arguments': {'path': 'probe.txt'}})
                result = (await receive())['result']
                self.assertIn('evidence', result['content'][0]['text'])
                command = "Set-Content -LiteralPath 'shell-probe.txt' -Value 'ran'; Write-Output 'mcp-shell-ok'" if os.name == 'nt' else 'printf ran > shell-probe.txt; printf mcp-shell-ok'
                await send(5, 'tools/call', {'name': 'run_shell', 'arguments': {'command': command}})
                # The web server runs in another thread, so inspect pending state with a bounded poll.
                for _ in range(200):
                    if server._chats[cid]['approvals']: break
                    await asyncio.sleep(.02)
                self.assertFalse((Path(folder) / 'shell-probe.txt').exists())
                aid = next(iter(server._chats[cid]['approvals']))
                async with httpx.AsyncClient(base_url=f'http://127.0.0.1:{port}') as http:
                    reply = await http.post('/api/agent/approval', json={'chat': cid, 'id': aid, 'allow': True})
                    self.assertEqual(reply.status_code, 200)
                    result = (await receive())['result']
                    self.assertFalse(result['isError'])
                    self.assertIn('mcp-shell-ok', result['content'][0]['text'])
                    self.assertTrue((Path(folder) / 'shell-probe.txt').exists())
                    await send(6, 'tools/call', {'name': 'run_shell', 'arguments': {'command': 'echo declined'}})
                    for _ in range(200):
                        if server._chats[cid]['approvals']: break
                        await asyncio.sleep(.02)
                    aid = next(iter(server._chats[cid]['approvals']))
                    await http.post('/api/agent/approval', json={'chat': cid, 'id': aid, 'allow': False})
                    result = (await receive())['result']
                    self.assertTrue(result['isError'])
                    self.assertIn('no command was run', result['content'][0]['text'])
            finally:
                cancel.set()
                if proc:
                    proc.stdin.close()
                    await asyncio.wait_for(proc.wait(), 5)
                web.should_exit = True
                await asyncio.to_thread(thread.join, 5)
                sock.close()
                server._chats.pop(cid, None)
                for p in reversed(patches): p.stop()


if __name__ == '__main__': unittest.main()
