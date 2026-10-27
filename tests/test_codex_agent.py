"""Run with python -m unittest discover -s tests (web tests need project deps)."""
import asyncio
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'explorer'))
from agent_common import AgentError
from codex_agent import CodexClient, browser_event, thread_config


class EventTests(unittest.TestCase):
    def test_tool_lifecycle_and_failure(self):
        item = {'type': 'mcpToolCall', 'id': 'call1', 'tool': 'overview', 'arguments': {}}
        self.assertEqual(browser_event({'method': 'item/started', 'params': {'item': item}})['name'], 'overview')
        item.update(result={'content': [{'type': 'text', 'text': 'tool failed'}], 'isError': True})
        event = browser_event({'method': 'item/completed', 'params': {'item': item}})
        self.assertTrue(event['error'])
        self.assertEqual(event['output'], 'tool failed')

    def test_retry_is_not_reported_as_a_terminal_error(self):
        self.assertIsNone(browser_event({'method': 'error', 'params': {'willRetry': True}}))
        event = browser_event({'method': 'turn/completed', 'params': {'turn': {'status': 'failed', 'error': {'message': 'quota'}}}})
        self.assertEqual(event['error'], 'quota')

    def test_config_disables_inherited_tools_without_mutating_input(self):
        effective = {'mcp_servers': {'other': {'enabled': True}, 'explorer': {}}, 'plugins': {'example': {}, 'plugin@vendor.test': {}}}
        config = thread_config(effective, str(Path.cwd()), 'chat1', 8791)
        self.assertFalse(config['mcp_servers.other.enabled'])
        self.assertFalse(config['plugins.example.enabled'])
        self.assertFalse(config['plugins."plugin@vendor.test".enabled'])
        self.assertFalse(config['features.shell_tool'])
        self.assertTrue(config['mcp_servers.explorer']['required'])
        self.assertEqual(config['mcp_servers.explorer']['env']['EXPLORER_CHAT'], 'chat1')
        self.assertTrue(effective['mcp_servers']['other']['enabled'])


class TransportTests(unittest.IsolatedAsyncioTestCase):
    async def test_owned_history_translation_excludes_private_reasoning(self):
        from unittest.mock import AsyncMock
        client = CodexClient(str(Path.cwd()), asyncio.Queue())
        record = {'cwd': str(Path.cwd()), 'turns': [{'status': 'completed', 'items': [
            {'type': 'userMessage', 'content': [{'type': 'text', 'text': '[The person has L7 N1 open in the explorer.]\n\nhello'}]},
            {'type': 'reasoning', 'text': 'private'}, {'type': 'agentMessage', 'text': 'answer'},
            {'type': 'mcpToolCall', 'id': 'call1', 'tool': 'overview', 'arguments': {}, 'result': {'content': [{'type': 'text', 'text': 'model'}]}},
        ]}]}
        client.call = AsyncMock(return_value={'thread': record})
        events = await client.history('owned')
        self.assertEqual([e['t'] for e in events], ['user', 'text', 'tool', 'tool_result', 'done'])
        self.assertEqual(events[0]['text'], 'hello')
        self.assertNotIn('private', str(events))
        record['cwd'] = str(Path.cwd().parent)
        with self.assertRaisesRegex(AgentError, 'working directory'):
            await client.history('owned')

    async def test_handshake_rpc_errors_stream_and_permission_denial(self):
        # A real child process exercises framing and the reader without a login or network.
        with tempfile.TemporaryDirectory() as folder:
            script = Path(folder) / 'fake_codex.py'
            script.write_text('''import sys,json
def out(m):print(json.dumps(m),flush=True)
for line in sys.stdin:
 m=json.loads(line);method=m.get('method');i=m.get('id')
 if method=='initialize':out({'id':i,'result':{}})
 elif method=='echo':out({'id':i,'result':m['params']})
 elif method=='fail':out({'id':i,'error':{'code':-1,'message':'expected error'}})
 elif method=='turn/interrupt':
  out({'id':i,'result':{}})
  out({'method':'item/agentMessage/delta','params':{'delta':'interrupted'}})
 elif method=='events':
  out({'method':'item/agentMessage/delta','params':{'delta':'hello'}})
  out({'id':'approval','method':'item/commandExecution/requestApproval','params':{}})
  out({'id':i,'result':{}})
 elif i=='approval':out({'method':'item/agentMessage/delta','params':{'delta':m['result']['decision']}})
 elif method=='exit':sys.exit(0)
''', encoding='utf-8')
            spawn = asyncio.create_subprocess_exec

            async def fake_spawn(*args, **kwargs):
                return await spawn(sys.executable, str(script), **kwargs)

            queue = asyncio.Queue()
            client = CodexClient(folder, queue)
            with patch('codex_agent.asyncio.create_subprocess_exec', fake_spawn), patch.dict(os.environ, {'EXPLORER_CODEX_BIN': sys.executable}):
                try:
                    await client.start()
                    self.assertEqual(await client.call('echo', {'a': 2}), {'a': 2})
                    with self.assertRaisesRegex(AgentError, 'expected error'):
                        await client.call('fail', {})
                    await client.call('events', {})
                    values = []
                    while 'decline' not in values:
                        kind, event = await asyncio.wait_for(queue.get(), 3)
                        if kind == 'event' and event['t'] == 'text':
                            values.append(event['text'])
                    self.assertEqual(values, ['hello', 'decline'])
                    with self.assertRaisesRegex(AgentError, 'stopped unexpectedly'):
                        await client.call('exit', {})
                finally:
                    await client.close()
            self.assertIsNotNone(client.proc.returncode)

            # Graceful close interrupts a running turn before shutting down stdio.
            client = CodexClient(folder, asyncio.Queue())
            with patch('codex_agent.asyncio.create_subprocess_exec', fake_spawn), patch.dict(os.environ, {'EXPLORER_CODEX_BIN': sys.executable}):
                await client.start()
                client.thread, client.turn = 'owned-thread', 'active-turn'
                await client.close()
            events = []
            while not client.queue.empty():
                kind, event = client.queue.get_nowait()
                if kind == 'event': events.append(event)
            self.assertIn({'t': 'text', 'text': 'interrupted'}, events)


if __name__ == '__main__':
    unittest.main()
