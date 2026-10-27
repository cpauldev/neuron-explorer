import asyncio
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'explorer'))
from claude_agent import ClaudeClient, legacy_session
from agent_common import AgentError


class ClaudeTests(unittest.IsolatedAsyncioTestCase):
    async def test_two_turns_use_one_streaming_process(self):
        with tempfile.TemporaryDirectory() as folder:
            script = Path(folder) / 'fake_persistent_claude.py'
            script.write_text('''import json,sys
for line in sys.stdin:
 m=json.loads(line)
 text=m['message']['content'][0]['text']
 print(json.dumps({'type':'stream_event','event':{'type':'content_block_delta','delta':{'type':'text_delta','text':text}}}),flush=True)
 print(json.dumps({'type':'result','is_error':False}),flush=True)
''', encoding='utf-8')
            client = ClaudeClient(folder, asyncio.Queue())
            with patch('claude_agent.claude_command', return_value=[sys.executable, str(script)]), patch('claude_agent.session_file', return_value=None):
                try:
                    await client.start()
                    await client.open_thread(folder, str(uuid.uuid4()), 8791, 'research prompt')
                    pid = None
                    for prompt in ('first', 'second'):
                        await client.call('turn/start', {'input': [{'type':'text','text':prompt}]})
                        if pid is None: pid = client.proc.pid
                        self.assertEqual(client.proc.pid, pid)
                        text = ''
                        while True:
                            kind, event = await asyncio.wait_for(client.queue.get(), 3)
                            self.assertEqual(kind, 'event')
                            if event['t'] == 'text': text += event['text']
                            if event['t'] == 'done': break
                        self.assertEqual(text, prompt)
                        self.assertTrue(client.alive)
                        self.assertIsNone(client.turn)
                finally: await client.close()
            self.assertFalse(client.alive)

    async def test_rewind_rejects_stale_text_and_keeps_malformed_lines(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'session.jsonl'
            records = [{'type': 'user', 'message': {'content': t}} for t in ['first', 'second']]
            original = 'partial log line\nnull\n' + ''.join(json.dumps(m) + '\n' for m in records)
            path.write_text(original, encoding='utf-8')
            client = ClaudeClient(folder, asyncio.Queue())
            with patch('claude_agent.session_file', return_value=path):
                with self.assertRaisesRegex(AgentError, 'Latest Claude turn'):
                    await client.rewind('first')
                self.assertEqual(path.read_text(encoding='utf-8'), original)
                self.assertEqual(list(Path(folder).glob('*.bak-*')), [])
                await client.rewind('second')
                self.assertIn('partial log line', path.read_text(encoding='utf-8'))
                self.assertNotIn('second', path.read_text(encoding='utf-8'))

    async def test_legacy_chat_import_requires_explorer_working_directory(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'session.jsonl'
            cid = str(uuid.uuid4())
            entry = {'type': 'user', 'cwd': folder, 'message': {'content': '[The person has L22 N1 open in the explorer.]\n\nhello'}}
            path.write_text(json.dumps(entry) + '\n', encoding='utf-8')
            with patch('claude_agent.session_file', return_value=path):
                self.assertIsNone(legacy_session(cid, str(Path(folder) / 'another-project')))
                imported = legacy_session(cid, folder)
                self.assertEqual(imported['provider'], 'claude')
                self.assertEqual(imported['last_message'], 'hello')
                client = ClaudeClient(folder, asyncio.Queue())
                events = await client.history(cid)
                self.assertEqual(events, [{'t': 'user', 'text': 'hello'}, {'t': 'done', 'status': 'completed'}])
                client.cwd = str(Path(folder) / 'another-project')
                with self.assertRaisesRegex(AgentError, 'working directory'):
                    await client.history(cid)

    async def test_cli_transport_uses_shared_tools_and_streaming(self):
        with tempfile.TemporaryDirectory() as folder:
            script = Path(folder) / 'fake_claude.py'
            script.write_text('''import json,sys
m=json.loads(sys.stdin.readline())
def out(m):print(json.dumps(m),flush=True)
out({'type':'stream_event','event':{'type':'content_block_delta','delta':{'type':'text_delta','text':'hello'}}})
out({'type':'assistant','message':{'content':[{'type':'tool_use','id':'call1','name':'mcp__explorer__overview','input':{}}]}})
out({'type':'user','message':{'content':[{'type':'tool_result','tool_use_id':'call1','content':'metadata'}]}})
out({'type':'result','is_error':False,'total_cost_usd':0.01})
''', encoding='utf-8')
            queue = asyncio.Queue()
            client = ClaudeClient(folder, queue)
            with patch('claude_agent.claude_command', return_value=[sys.executable, str(script)]), patch('claude_agent.session_file', return_value=None):
                try:
                    await client.start()
                    cid = str(uuid.uuid4())
                    await client.open_thread(folder, cid, 8791, 'research prompt')
                    self.assertEqual(client.args[client.args.index('--tools') + 1], '')
                    self.assertIn('--strict-mcp-config', client.args)
                    self.assertNotIn('--add-dir', client.args)
                    self.assertEqual(client.args[client.args.index('--setting-sources') + 1], '')
                    self.assertEqual((Path(folder) / f'system_prompt-{cid}-claude.md').read_text(encoding='utf-8'), 'research prompt')
                    await client.call('turn/start', {'input': [{'type': 'text', 'text': 'hello'}]})
                    events = []
                    while not events or events[-1]['t'] != 'done':
                        kind, event = await asyncio.wait_for(queue.get(), 3)
                        if kind == 'event': events.append(event)
                    self.assertEqual([e['t'] for e in events], ['text', 'tool', 'tool_result', 'done'])
                    self.assertEqual(events[1]['name'], 'overview')
                finally:
                    await client.close()
            self.assertIsNotNone(client.proc.returncode)

    async def test_rewind_backs_up_history_and_removes_only_latest_turn(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'session.jsonl'
            messages = [{'type': 'user', 'message': {'content': [{'type': 'text', 'text': t}]}} for t in ['first', 'second']]
            path.write_text(''.join(json.dumps(m) + '\n' for m in messages), encoding='utf-8')
            client = ClaudeClient(folder, asyncio.Queue())
            client.thread = str(uuid.uuid4())
            with patch('claude_agent.session_file', return_value=path):
                await client.rewind('second')
                self.assertIn('first', path.read_text())
                self.assertNotIn('second', path.read_text())
                self.assertEqual(len(list(Path(folder).glob('*.bak-*'))), 1)
                await client.rewind('first')
                self.assertFalse(path.exists())


if __name__ == '__main__':
    unittest.main()
