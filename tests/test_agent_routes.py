"""Exercise the HTTP integration without downloading or loading Qwen."""
import base64
import asyncio
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import uuid

from fastapi.testclient import TestClient
from pypdf import PdfWriter

from server_fixture import JsonRequest, load_server
from agent_common import AgentError


server = load_server()


class FakeCodex:
    calls = []
    closed = 0

    def __init__(self, cwd, queue):
        self.queue, self.turn, self.alive = queue, None, False
    async def start(self): pass
    async def open_thread(self, root, chat, port, instructions, thread=None):
        self.calls.append(('resume' if thread else 'start', thread))
        self.calls.append(('model', getattr(self, 'model', None)))
        return thread or 'owned-thread'
    async def call(self, method, params):
        self.calls.append((method, params))
        if method == 'turn/start':
            self.queue.put_nowait(('ui', {'action': 'camera', 'mode': 'home'}))
            self.queue.put_nowait(('event', {'t': 'text', 'text': 'hello'}))
            self.queue.put_nowait(('event', {'t': 'done', 'status': 'completed'}))
            return {'turn': {'id': 'turn1'}}
        return {}
    async def history(self, thread): return []
    async def close(self): FakeCodex.closed += 1


class FakeClaude(FakeCodex):
    calls = []
    closed = 0

    async def open_thread(self, root, chat, port, instructions, thread=None):
        self.calls.append(('resume' if thread else 'start', thread))
        self.calls.append(('model', getattr(self, 'model', None)))
        return thread or 'claude-thread'

    async def rewind(self, message): self.calls.append(('claude/rewind', message))
    async def close(self): FakeClaude.closed += 1


class RouteTests(unittest.TestCase):
    def test_repeated_stop_and_caller_disconnect_do_not_cancel_cleanup_twice(self):
        async def run():
            entered, release = asyncio.Event(), asyncio.Event()
            async def worker():
                try: await asyncio.Event().wait()
                finally:
                    entered.set()
                    await release.wait()
            job = asyncio.create_task(worker())
            await asyncio.sleep(0)
            chat = {'job': job}
            first = asyncio.create_task(server.stop_agent_turn(chat))
            await entered.wait()
            second = asyncio.create_task(server.stop_agent_turn(chat))
            await asyncio.sleep(0)
            self.assertEqual(job.cancelling(), 1)
            first.cancel()
            with self.assertRaises(asyncio.CancelledError): await first
            self.assertFalse(job.done())
            release.set()
            await second
            self.assertTrue(job.cancelled())
            self.assertFalse(server.busy_chat(chat))
        asyncio.run(run())

    def test_warm_clients_keep_thread_context_and_restart_on_scope_change_or_stop(self):
        class WarmClient(FakeCodex):
            created = []
            def __init__(self, cwd, queue):
                super().__init__(cwd, queue)
                self.alive, self.hold = True, False
                self.held_started = asyncio.Event()
                self.created.append(self)
            async def close(self): self.alive = False
            async def call(self, method, params):
                if self.hold and method == 'turn/start':
                    self.held_started.set()
                    return {'turn': {'id': 'held-turn'}}
                return await super().call(method, params)

        async def run():
            async def send(provider, chat=None, access='project'):
                result = await server.agent_send(JsonRequest(provider=provider, chat=chat, access=access, message='hello'))
                self.assertIsInstance(result, dict)
                await server._chats[result['chat']]['job']
                return result['chat']

            for provider in ('codex', 'claude'):
                cid = await send(provider)
                first = server.agent_pool.clients[cid]['client']
                await send(provider, cid)
                self.assertIs(server.agent_pool.clients[cid]['client'], first)
                await send(provider, cid, 'home')
                changed = server.agent_pool.clients[cid]['client']
                self.assertIsNot(changed, first)
                self.assertFalse(first.alive)
                self.assertEqual(server.agent_pool.clients[cid]['thread'], 'owned-thread')
                changed.hold = True
                await server.agent_send(JsonRequest(provider=provider, chat=cid, access='home', message='hold'))
                await asyncio.wait_for(changed.held_started.wait(), 2)
                pending = asyncio.get_running_loop().create_future()
                server._chats[cid]['approvals']['pending'] = pending
                await server.agent_interrupt(JsonRequest(chat=cid))
                self.assertFalse(pending.result())
                self.assertFalse(changed.alive)
                self.assertNotIn(cid, server.agent_pool.clients)
                history = await server.agent_history(cid)
                self.assertEqual(history['events'][-1]['status'], 'interrupted')
                await send(provider, cid, 'home')
                self.assertEqual(server.agent_session(cid)[1]['thread'], 'owned-thread')
            await server.stop_agent_jobs()
            self.assertEqual(server.agent_pool.clients, {})

        with patch.object(server, 'CodexClient', WarmClient), patch.object(server, 'ClaudeClient', WarmClient):
            asyncio.run(run())

    def test_completion_waits_for_provider_cleanup(self):
        async def run():
            closing, release = asyncio.Event(), asyncio.Event()

            class ClosingCodex(FakeCodex):
                async def close(self):
                    closing.set()
                    await release.wait()

            with patch.object(server, 'CodexClient', ClosingCodex):
                started = await server.agent_send(JsonRequest({'provider': 'codex', 'message': 'first'}))
                await closing.wait()
                cid = started['chat']
                history = await server.agent_history(cid)
                self.assertTrue(history['running'])
                self.assertNotIn('done', [e['t'] for e in history['events']])
                response = await server.agent_events(cid, history['cursor'])
                listener = response.body_iterator
                self.assertEqual(await anext(listener), '\n')
                release.set()
                await server._chats[cid]['job']
                self.assertEqual(json.loads(await anext(listener))['t'], 'done')
                await listener.aclose()
                self.assertFalse((await server.agent_history(cid))['running'])
                next_turn = await server.agent_send(JsonRequest({'provider': 'codex', 'chat': cid, 'message': 'second'}))
                self.assertEqual(next_turn['chat'], cid)
                await server._chats[cid]['job']

        asyncio.run(run())

    def test_stop_finds_active_legacy_stream_after_completed_background_job(self):
        async def run():
            async def wait(): await asyncio.Event().wait()
            completed = asyncio.create_task(asyncio.sleep(0))
            await completed
            active = asyncio.create_task(wait())
            await server.stop_agent_turn({'job': completed, 'active_task': active})
            self.assertTrue(active.cancelled())
        asyncio.run(run())

    def test_head_row_handles_partial_display_units(self):
        captures = {'ids': [1, 2, 3], 'T': 3, 'q': {0: {}}}
        with patch.object(server.rt, 'heads', captures), patch.object(server.rt, 'head_row', return_value=[1.0], create=True), \
             patch.dict(server._infer, {'ids': captures['ids'], 'units': [('prefix', [0, 1]), ('word', [2])]}):
            self.assertEqual(server.head_row(0, 0, 0), {'units': [1.0, None]})

    def test_interrupted_head_profile_cache_is_rebuilt_atomically(self):
        path = Path(self.temp.name) / 'head_profiles.json'
        for broken in ('{"partial":', '[]'):
            path.write_text(broken, encoding='utf-8')
            with patch.object(server, 'CACHE', self.temp.name), patch.object(server, 'HEAD_TEXTS', []), \
                 patch.object(server, '_hprof', {}):
                result = server._head_profiles()
                self.assertEqual(result['heads'], {})
                self.assertEqual(json.loads(path.read_text(encoding='utf-8')), result)
                self.assertFalse(path.with_suffix('.json.tmp').exists())

    def test_background_reply_survives_listener_disconnect_and_replays(self):
        class SlowCodex(FakeCodex):
            async def call(self, method, params):
                if method == 'turn/start':
                    self.queue.put_nowait(('event', {'t': 'text', 'text': 'first'}))
                    return {'turn': {'id': 'turn1'}}
                return {}

        async def run():
            body = {'provider': 'codex', 'message': 'keep going'}
            started = await server.agent_send(JsonRequest(body))
            cid = started['chat']
            await asyncio.sleep(0)
            c = server._chats[cid]
            duplicate = await server.agent_send(JsonRequest({**body, 'chat': cid}))
            self.assertEqual(duplicate.status_code, 409)
            response = await server.agent_events(cid)
            listener = response.body_iterator
            self.assertEqual(json.loads(await anext(listener))['t'], 'user')
            await listener.aclose()
            self.assertTrue(server.busy_chat(c), 'disconnect must leave the reply running')
            self.assertEqual(FakeCodex.closed, 0)
            snapshot = await server.agent_history(cid)
            cursor = snapshot['cursor']
            c['queue'].put_nowait(('event', {'t': 'text', 'text': 'second'}))
            c['queue'].put_nowait(('event', {'t': 'done'}))
            await c['job']
            response = await server.agent_events(cid, cursor)
            replay = [json.loads(line) async for line in response.body_iterator]
            self.assertEqual([e['t'] for e in replay], ['text', 'done'])
            self.assertTrue(all(e['seq'] > cursor for e in replay))
            self.assertFalse(server.busy_chat(c))
            server._chats.clear()  # a server restart can still read the owned history
            restored = await server.agent_history(cid)
            self.assertEqual([e['text'] for e in restored['events'] if e['t'] == 'text'], ['first', 'second'])
            self.assertEqual((await server.agent_chats())['chats'][0]['title'], 'keep going')
            await server.agent_rewind(JsonRequest({'chat': cid, 'provider': 'codex', 'text': 'keep going'}))
            self.assertEqual((await server.agent_history(cid))['events'], [])

        with patch.object(server, 'CodexClient', SlowCodex):
            asyncio.run(run())

    def test_background_stop_declines_approvals_and_closes_provider(self):
        ready = asyncio.Event()
        class WaitingClaude(FakeClaude):
            async def call(self, method, params):
                ready.set()
                return {'turn': {'id': 'turn1'}}

        async def run():
            started = await server.agent_send(JsonRequest({'provider': 'claude', 'message': 'work'}))
            cid = started['chat']
            await asyncio.wait_for(ready.wait(), 2)
            c = server._chats[cid]
            pending = asyncio.get_running_loop().create_future()
            c['approvals']['pending'] = pending
            self.assertTrue((await server.agent_history(cid))['running'])
            await server.agent_interrupt(JsonRequest({'chat': cid}))
            self.assertFalse(pending.result())
            self.assertTrue(c['cancel'].is_set())
            self.assertFalse(server.busy_chat(c))
            history = await server.agent_history(cid)
            self.assertEqual(history['events'][-2]['t'], 'stopped')
            self.assertEqual(history['events'][-1]['t'], 'done')
            self.assertEqual(history['approvals'], [])

        with patch.object(server, 'ClaudeClient', WaitingClaude):
            asyncio.run(run())
        self.assertEqual(FakeClaude.closed, 1)

    def test_history_ownership_import_and_invalid_inputs(self):
        cid = self.chat()[0]['chat']
        self.assertEqual(self.client.get('/api/agent/history', params={'chat': str(uuid.uuid4())}).status_code, 400)
        self.assertEqual(self.client.get('/api/agent/history', params={'chat': '../secret'}).status_code, 400)
        self.assertEqual(self.client.post('/api/agent/history/import', json={'chat': cid, 'messages': [{'t': 'html', 'text': '<script>'}]}).status_code, 400)
        messages = [{'t': 'user', 'text': 'old prompt'}, {'t': 'text', 'text': 'old answer'}]
        self.assertTrue(self.client.post('/api/agent/history/import', json={'chat': cid, 'messages': messages}).json()['ok'])
        self.assertEqual(self.client.post('/api/agent/history/import', json={'chat': cid, 'messages': messages}).status_code, 409)
        self.assertEqual(self.client.get('/api/agent/events', params={'chat': cid, 'after': -1}).status_code, 400)
        for patch_body in ({'message': ''}, {'message': 1}, {'attachment_names': [3]}, {'shown': {}}, {'layer': 32, 'head': 0}, {'layer': 0, 'head': -1}):
            body = {'provider': 'codex', 'message': 'test', **patch_body}
            self.assertEqual(self.client.post('/api/agent/send', json=body).status_code, 400)

    def test_malformed_uploads_return_client_errors(self):
        for body in ([], {}, {'data': '!bad base64!'}, {'data': 1}, {'data': '', 'name': '..'},
                     {'data': '', 'name': 'file', 'type': []}):
            r = self.client.post('/api/agent/upload', json=body)
            self.assertEqual(r.status_code, 400, r.text)
            self.assertIn('error', r.json())

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        FakeCodex.calls, FakeCodex.closed = [], 0
        FakeClaude.calls, FakeClaude.closed = [], 0
        server._chats.clear()
        self.patches = [patch.object(server, 'AGENT_DIR', self.temp.name),
                        patch.object(server, 'UPLOADS', str(Path(self.temp.name) / 'uploads')),
                        patch.object(server, 'CodexClient', FakeCodex),
                        patch.object(server, 'ClaudeClient', FakeClaude)]
        for p in self.patches: p.start()
        self.client = TestClient(server.app, base_url='http://127.0.0.1:8791')

    def tearDown(self):
        self.client.close()
        for p in reversed(self.patches): p.stop()
        self.temp.cleanup()

    def chat(self, **body):
        r = self.client.post('/api/agent/chat', json={'provider': 'codex', 'message': 'hello', **body})
        self.assertEqual(r.status_code, 200, r.text)
        return [json.loads(line) for line in r.text.splitlines()]

    def test_selected_model_is_applied_and_restored_with_conversation(self):
        events = self.chat(model='test-model')
        cid = events[0]['chat']
        self.assertIn(('model', 'test-model'), FakeCodex.calls)
        history = self.client.get('/api/agent/history', params={'chat': cid}).json()
        self.assertEqual(history['model'], 'test-model')
        self.chat(chat=cid)
        self.assertEqual([value for name, value in FakeCodex.calls if name == 'model'], ['test-model', 'test-model'])
        result = self.client.post('/api/agent/chat', json={'provider': 'codex', 'message': 'bad model', 'model': '--unsafe-option'})
        self.assertEqual(result.status_code, 400)

    def test_stream_resume_and_revert_owned_history(self):
        events = self.chat()
        cid = events[0]['chat']
        self.assertEqual([e['t'] for e in events], ['chat', 'ui', 'text', 'done'])
        self.chat(chat=cid)
        self.assertIn(('resume', 'owned-thread'), FakeCodex.calls)
        r = self.client.post('/api/agent/rewind', json={'provider': 'codex', 'chat': cid, 'text': 'hello'})
        self.assertEqual(r.json(), {'ok': True, 'cut': True})
        self.assertIn(('thread/revert', {'threadId': 'owned-thread', 'beforeTurnId': 'turn1'}), FakeCodex.calls)
        self.assertEqual(FakeCodex.closed, 3)

    def test_rejects_arbitrary_thread_ids_and_cross_origin(self):
        for cid in ['../../secret', str(uuid.uuid4()), 'someone-elses-thread']:
            r = self.client.post('/api/agent/chat', json={'chat': cid, 'message': 'hello'})
            self.assertEqual(r.status_code, 400)
        r = self.client.post('/api/agent/chat', json={'message': 'hello'}, headers={'Origin': 'https://example.com'})
        self.assertEqual(r.status_code, 403)
        self.assertEqual(FakeCodex.calls, [])

    def test_provider_selection_keeps_sessions_and_rewind_separate(self):
        codex = self.chat(provider='codex')[0]['chat']
        claude = self.chat(provider='claude')[0]['chat']
        self.assertNotEqual(codex, claude)
        self.assertEqual(server.agent_session(claude)[1]['provider'], 'claude')
        self.chat(provider='claude', chat=claude)
        self.assertIn(('resume', 'claude-thread'), FakeClaude.calls)
        for cid, provider in [(codex, 'claude'), (claude, 'codex')]:
            r = self.client.post('/api/agent/chat', json={'provider': provider, 'chat': cid, 'message': 'wrong provider'})
            self.assertEqual(r.status_code, 400)
        r = self.client.post('/api/agent/rewind', json={'provider': 'claude', 'chat': claude, 'text': 'hello'})
        self.assertEqual(r.json(), {'ok': True, 'cut': True})
        self.assertIn(('claude/rewind', 'hello'), FakeClaude.calls)
        self.assertFalse(any(method == 'thread/revert' for method, _ in FakeClaude.calls))
        r = self.client.post('/api/agent/chat', json={'provider': 'unknown', 'message': 'hello'})
        self.assertEqual(r.status_code, 400)

    def test_requests_without_a_provider_keep_main_claude_default(self):
        r = self.client.post('/api/agent/chat', json={'message': 'hello'})
        self.assertEqual(r.status_code, 200)
        events = [json.loads(line) for line in r.text.splitlines()]
        self.assertEqual(events[0]['provider'], 'claude')
        self.assertTrue(FakeClaude.calls)
        self.assertFalse(FakeCodex.calls)

    def test_failed_start_is_streamed_and_cleaned_up(self):
        async def fail(*args): raise AgentError('Please run codex login')
        with patch.object(FakeCodex, 'start', fail):
            events = self.chat()
        self.assertEqual(events[0]['t'], 'error')
        self.assertIn('codex login', events[0]['error'])
        self.assertEqual(FakeCodex.closed, 1)

    def test_closing_stream_releases_the_chat_and_client(self):
        async def run():
            response = await server.agent_chat(JsonRequest({'provider': 'codex', 'message': 'interrupt this turn'}))
            iterator = response.body_iterator
            cid = json.loads(await anext(iterator))['chat']
            await anext(iterator)  # turn/start succeeded; UI event is being streamed
            await iterator.aclose()
            self.assertNotIn('active_task', server._chats[cid])
            self.assertFalse(server._chats[cid]['lock'].locked())
            self.assertEqual(server.agent_session(cid)[1]['last_turn'], 'turn1')

        asyncio.run(run())
        self.assertEqual(FakeCodex.closed, 1)

    def test_attachments_and_stale_rewind(self):
        def upload(name, kind, raw):
            return self.client.post('/api/agent/upload', json={'name': name, 'type': kind, 'data': base64.b64encode(raw).decode()}).json()['id']
        txt = upload('notes.txt', 'text/plain', b'attachment evidence')
        img = upload('image.png', 'image/png', b'placeholder')
        events = self.chat(attachments=[txt, img])
        sent = next(p for m, p in FakeCodex.calls if m == 'turn/start')['input']
        self.assertIn('attachment evidence', sent[1]['text'])
        self.assertEqual(sent[2]['type'], 'localImage')
        cid = events[0]['chat']
        r = self.client.post('/api/agent/rewind', json={'provider': 'codex', 'chat': cid, 'text': 'stale message'})
        self.assertEqual(r.status_code, 409)
        writer = PdfWriter(); writer.add_blank_page(width=100, height=100)
        buf = io.BytesIO(); writer.write(buf)
        pdf = upload('scan.pdf', 'application/pdf', buf.getvalue())
        r = self.client.post('/api/agent/chat', json={'provider': 'codex', 'message': 'read', 'attachments': [pdf]})
        self.assertEqual(r.status_code, 400)
        self.assertIn('no extractable text', r.json()['error'])
        self.chat(provider='claude', attachments=[pdf, img])
        sent = next(p for m, p in FakeClaude.calls if m == 'turn/start')['input']
        self.assertEqual(sent[1]['type'], 'document')
        self.assertEqual(sent[2]['type'], 'image')


if __name__ == '__main__':
    unittest.main()
