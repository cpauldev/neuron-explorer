import asyncio
from pathlib import Path
from types import SimpleNamespace
import sys
import unittest
from unittest.mock import patch
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'explorer'))
from claude_agent import ClaudeClient, legacy_session, sdk_record
from claude_agent_sdk import StreamEvent, ResultMessage, AssistantMessage, TextBlock, ToolUseBlock, ToolResultBlock, UserMessage
from agent_common import AgentError


def result(sid):
    return ResultMessage(subtype='success', duration_ms=1, duration_api_ms=1,
                         is_error=False, num_turns=1, session_id=sid)


class FakeSDK:
    instances = []
    def __init__(self, options):
        self.options, self.messages = options, asyncio.Queue()
        self.connected_task = None
        self.disconnected_task = None
        self.sent = []
        self.instances.append(self)
    async def connect(self): self.connected_task = asyncio.current_task()
    async def query(self, prompt):
        async for m in prompt:
            self.sent.append(m)
            await self.messages.put(StreamEvent(uuid='event', session_id=self.options.session_id or self.options.resume,
                event={'type': 'content_block_delta', 'delta': {'type': 'text_delta', 'text': m['message']['content'][0]['text']}}))
            await self.messages.put(result(self.options.session_id or self.options.resume))
    async def receive_messages(self):
        while True: yield await self.messages.get()
    async def disconnect(self): self.disconnected_task = asyncio.current_task()


class ClaudeTests(unittest.IsolatedAsyncioTestCase):
    async def test_real_sdk_parses_stream_and_cleans_up_its_transport(self):
        import json
        from dataclasses import asdict
        from claude_agent_sdk import ClaudeSDKClient as RealSDK

        class Transport:
            def __init__(self):
                self.messages = asyncio.Queue()
                self.closed = False
            async def connect(self): pass
            def is_ready(self): return not self.closed
            async def end_input(self): pass
            async def close(self): self.closed = True
            async def write(self, data):
                message = json.loads(data)
                if message['type'] == 'control_request':
                    await self.messages.put({'type': 'control_response', 'response': {
                        'subtype': 'success', 'request_id': message['request_id'], 'response': {}}})
                elif message['type'] == 'user':
                    await self.messages.put({'type': 'stream_event', 'uuid': 'event', 'session_id': sid,
                        'event': {'type': 'content_block_delta', 'delta': {'type': 'text_delta', 'text': 'typed response'}}})
                    await self.messages.put({'type': 'result', **asdict(result(sid))})
            async def read_messages(self):
                while True:
                    yield await self.messages.get()

        sid = str(uuid.uuid4())
        transport = Transport()
        client = ClaudeClient('.', asyncio.Queue())
        with patch('claude_agent.ClaudeSDKClient', side_effect=lambda options: RealSDK(options, transport=transport)):
            await client.open_thread('.', sid, 8791, 'research')
            try:
                await client.call('turn/start', {'input': [{'type': 'text', 'text': 'hello'}]})
                _, event = await asyncio.wait_for(client.queue.get(), 3)
                self.assertEqual(event['text'], 'typed response')
                _, event = await asyncio.wait_for(client.queue.get(), 3)
                self.assertEqual(event['status'], 'completed')
            finally:
                await client.close()
        self.assertTrue(transport.closed)

    async def test_two_turns_share_client_and_cleanup_in_owner_task(self):
        client = ClaudeClient('.', asyncio.Queue())
        with patch('claude_agent.ClaudeSDKClient', FakeSDK):
            await client.open_thread('.', str(uuid.uuid4()), 8791, 'research')
            self.assertEqual(client.options.tools, [])
            self.assertTrue(client.options.strict_mcp_config)
            self.assertEqual(client.options.setting_sources, [])
            self.assertTrue(client.options.verbatim_prompts)
            self.assertEqual((await client._permission('Bash', {}, None)).behavior, 'deny')
            self.assertEqual((await client._permission('mcp__explorer__overview', {}, None)).behavior, 'allow')
            try:
                for text in ('first', 'second'):
                    await client.call('turn/start', {'input': [{'type': 'text', 'text': text}]})
                    events = []
                    while not events or events[-1]['t'] != 'done':
                        _, event = await asyncio.wait_for(client.queue.get(), 2)
                        events.append(event)
                    self.assertEqual(events[0]['text'], text)
                    client.turn = None
                sdk = client.sdk
                self.assertEqual(len(sdk.sent), 2)
            finally:
                await client.close()
            self.assertIs(sdk.connected_task, sdk.disconnected_task)
            self.assertFalse(client.alive)

    async def test_sdk_failure_is_reported_and_client_is_not_reused(self):
        class BrokenSDK(FakeSDK):
            async def receive_messages(self):
                yield await self.messages.get()
                raise RuntimeError('connection failed')
        client = ClaudeClient('.', asyncio.Queue())
        with patch('claude_agent.ClaudeSDKClient', BrokenSDK):
            await client.open_thread('.', str(uuid.uuid4()), 8791, 'research')
            await client.call('turn/start', {'input': [{'type':'text','text':'hello'}]})
            await asyncio.sleep(.02)
            self.assertFalse(client.alive)
            self.assertTrue(any(e and 'connection failed' in e.get('error','') for _, e in list(client.queue._queue)))
            await client.close()

    async def test_rewind_forks_at_previous_message_and_rejects_stale_text(self):
        client = ClaudeClient('.', asyncio.Queue())
        client.thread = str(uuid.uuid4())
        original = client.thread
        messages = [SimpleNamespace(type='user', uuid='u1', message={'content':'first'}),
                    SimpleNamespace(type='assistant', uuid='a1', message={'content':[{'type':'text','text':'answer'}]}),
                    SimpleNamespace(type='user', uuid='u2', message={'content':'second'})]
        with patch('claude_agent.session_messages', return_value=messages), patch('claude_agent.fork_session', return_value=SimpleNamespace(session_id='branched')) as fork:
            with self.assertRaisesRegex(AgentError, 'changed'):
                await client.rewind('first')
            fork.assert_not_called()
            self.assertEqual(await client.rewind('second'), 'branched')
            fork.assert_called_once_with(original, directory='.', up_to_message_id='a1')
            self.assertEqual(client.thread, 'branched')
        with patch('claude_agent.session_messages', return_value=messages[:1]):
            self.assertIsNone(await client.rewind('first'))

    async def test_history_and_legacy_import_check_ownership_via_sdk(self):
        sid = str(uuid.uuid4())
        messages = [SimpleNamespace(type='user', uuid='u', message={'content':'hello'})]
        with patch('claude_agent.get_session_info', return_value=SimpleNamespace(cwd=str(Path.cwd()))), patch('claude_agent.get_session_messages', return_value=messages):
            self.assertEqual(legacy_session(sid, str(Path.cwd()))['last_message'], 'hello')
            self.assertIsNone(legacy_session(sid, str(Path.cwd().parent)))
            client = ClaudeClient(str(Path.cwd()), asyncio.Queue())
            self.assertEqual((await client.history(sid))[0], {'t':'user','text':'hello'})

    def test_typed_tool_blocks_keep_the_existing_browser_contract(self):
        from claude_agent import browser_events
        assistant = AssistantMessage(content=[TextBlock('hello'), ToolUseBlock('call','mcp__explorer__overview',{})], model='test')
        event = list(browser_events(sdk_record(assistant)))
        self.assertEqual(event[0]['name'], 'overview')
        user = UserMessage(content=[ToolResultBlock('call', 'metadata')])
        self.assertEqual(list(browser_events(sdk_record(user)))[0]['output'], 'metadata')
