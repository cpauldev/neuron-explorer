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
    def test_preserves_explicit_public_message_phase_and_item_identity(self):
        for phase in ('commentary', 'final_answer', None):
            item = {'type': 'agentMessage', 'id': 'msg1', 'phase': phase, 'text': 'public'}
            for method in ('item/started', 'item/completed'):
                self.assertEqual(browser_event({'method': method, 'params': {'item': item}}),
                                 {'t': 'text_phase', 'id': 'msg1', 'phase': phase})
        self.assertEqual(browser_event({'method': 'item/agentMessage/delta', 'params': {'itemId': 'msg1', 'delta': 'hello'}}),
                         {'t': 'text', 'id': 'msg1', 'text': 'hello'})

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

    async def test_official_sdk_transport_streams_and_denies_native_approval(self):
        from openai_codex.client import CodexClient as RealClient
        from openai_codex import CodexConfig
        with tempfile.TemporaryDirectory() as folder:
            script = Path(folder) / 'fake_codex.py'
            script.write_text('''import sys,json
for line in sys.stdin:
 m=json.loads(line); method=m.get('method'); i=m.get('id')
 def out(v): print(json.dumps(v),flush=True)
 if method=='initialize': out({'id':i,'result':{'serverInfo':{'version':'0.163.0'}}})
 elif method=='model/list':
  out({'id':'approval','method':'item/commandExecution/requestApproval','params':{}})
  out({'id':i,'result':{'data':[],'nextCursor':None}})
 elif i=='approval': out({'method':'item/agentMessage/delta','params':{'delta':m['result']['decision']}})
 elif method=='thread/read': out({'id':i,'error':{'code':-1,'message':'expected error'}})
 elif method=='turn/interrupt': out({'id':i,'result':{}})
 elif method=='turn/start':
  turn={'id':'turn1','items':[],'status':'inProgress','error':None}
  out({'method':'item/agentMessage/delta','params':{'threadId':'owned','turnId':'turn1','itemId':'text1','delta':'early turn text'}})
  out({'id':i,'result':{'turn':turn}})
  out({'method':'item/agentMessage/delta','params':{'threadId':'owned','turnId':'turn1','itemId':'text1','delta':' later text'}})
  turn['status']='completed'
  out({'method':'turn/completed','params':{'threadId':'owned','turn':turn}})
''', encoding='utf-8')
            def factory(config, approval_handler):
                self.assertIsNone(config.codex_bin)
                return RealClient(CodexConfig(launch_args_override=(sys.executable, str(script)), cwd=folder),
                                  approval_handler=approval_handler)
            client = CodexClient(folder, asyncio.Queue())
            with patch('codex_agent.SdkClient', factory), patch.dict(os.environ, {}, clear=True):
                try:
                    await client.start()
                    self.assertEqual((await client.call('model/list', {}))['data'], [])
                    kind, event = await asyncio.wait_for(client.queue.get(), 5)
                    self.assertEqual(event, {'t': 'text', 'text': 'decline'})
                    with self.assertRaisesRegex(AgentError, 'expected error'):
                        await client.call('thread/read', {'threadId': 'owned'})
                    await client.call('turn/start', {'threadId':'owned','input':[{'type':'text','text':'hello'}]})
                    events = []
                    while not events or events[-1].get('t') != 'done':
                        kind, event = await asyncio.wait_for(client.queue.get(), 5)
                        self.assertEqual(kind, 'event')
                        events.append(event)
                    self.assertEqual([e['text'] for e in events if e['t'] == 'text'], ['early turn text', ' later text'])
                    self.assertEqual(events[-1]['status'], 'completed')
                    client.turn = None
                finally:
                    await client.close()
            self.assertFalse(client.alive)

    async def test_timeout_closes_connection_and_does_not_replay(self):
        from unittest.mock import Mock
        import threading
        from openai_codex import CodexError
        stopped = threading.Event()
        def request(*args, **kwargs):
            stopped.wait(3)
            raise CodexError('closed')
        sdk = Mock(request=request, close=Mock(side_effect=stopped.set))
        client = CodexClient('.', asyncio.Queue())
        client.sdk = sdk
        with self.assertRaisesRegex(AgentError, 'outcome may be unknown'):
            await client.call('model/list', {}, timeout=.02)
        sdk.close.assert_called_once()
        self.assertIsNone(client.sdk)

    def test_all_native_client_requests_fail_closed(self):
        client = CodexClient('.', asyncio.Queue())
        self.assertEqual(client._approval('item/permissions/requestApproval', {}), {'permissions': {}, 'scope': 'turn'})
        self.assertEqual(client._approval('item/tool/requestUserInput', {}), {'answers': {}})
        with self.assertRaises(AgentError):
            client._approval('new/unknownApproval', {})
