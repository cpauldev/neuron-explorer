import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'explorer'))
from agent_store import AssistantStore
from agent_history import Journal


class StoreTests(unittest.TestCase):
    def test_delete_removes_content_and_blocks_legacy_import_and_delayed_receipts(self):
        import uuid
        with tempfile.TemporaryDirectory() as root:
            chat = str(uuid.uuid4())
            store = AssistantStore(root)
            journal = Journal(root, chat)
            _, event = store.reserve('request', chat, 'fingerprint', {'provider': 'claude'},
                                     {'t': 'user', 'text': 'private question'})
            journal.events.append(event)
            store.approval('approval', 'request', 'command', '.')
            store.save_session('other', {'provider': 'codex'})
            for folder, suffix in (('sessions', '.json'), ('events', '.jsonl')):
                path = Path(root) / folder / f'{chat}{suffix}'
                path.parent.mkdir(exist_ok=True)
                path.write_text('{}', encoding='utf-8')
            store.delete(chat)
            restarted = AssistantStore(root)
            self.assertEqual(restarted.session(chat), {})
            self.assertEqual(restarted.sessions(), [('other', {'provider': 'codex'})])
            self.assertEqual(restarted.receipt('request', 'fingerprint')['state'], 'deleted')
            with restarted.connect() as db:
                self.assertEqual(db.execute('SELECT COUNT(*) FROM events WHERE chat=?', (chat,)).fetchone()[0], 0)
                self.assertEqual(db.execute('SELECT COUNT(*) FROM approvals').fetchone()[0], 0)
            self.assertFalse(journal.path.exists())
            with self.assertRaisesRegex(ValueError, 'deleted'):
                journal.append({'t': 'text', 'text': 'late result'})
            with self.assertRaisesRegex(ValueError, 'deleted'):
                restarted.save_session(chat, {'provider': 'claude'})
            with self.assertRaisesRegex(ValueError, 'deleted'):
                Journal(root, chat)
            # Even an external provider re-creating a migration source cannot restore the chat.
            legacy = Path(root) / 'sessions' / f'{chat}.json'
            legacy.write_text('{"provider":"claude"}', encoding='utf-8')
            self.assertEqual(restarted.session(chat), {})

    def test_receipt_survives_restart_and_cannot_be_reused_for_another_message(self):
        with tempfile.TemporaryDirectory() as root:
            journal = Journal(root, 'chat')
            store = AssistantStore(root)
            cursor, user = store.reserve('request', 'chat', 'fingerprint', {'provider': 'codex'}, {'t': 'user', 'text': 'hello'})
            journal.events.append(user)
            self.assertEqual(cursor, 0)
            store.transition('request', 'running', 'provider-turn')
            store.approval('approval', 'request', 'echo test', '.')
            store.transition('request', 'awaiting_approval')
            restarted = AssistantStore(root)
            restarted.recover('chat')
            self.assertEqual(restarted.receipt('request', 'fingerprint')['state'], 'unknown')
            self.assertFalse(restarted.decide('approval', True))
            with self.assertRaisesRegex(ValueError, 'different message'):
                restarted.receipt('request', 'another-message')
            self.assertEqual(Journal(root, 'chat').events, [user])
            journal.append({'t': 'done', 'status': 'interrupted'}, request_id='request')
            self.assertEqual(restarted.receipt('request', 'fingerprint')['state'], 'interrupted')
            restarted.transition('request', 'running')
            self.assertEqual(restarted.receipt('request', 'fingerprint')['state'], 'interrupted')

    def test_legacy_sessions_import_once_and_changes_are_stored_in_database(self):
        with tempfile.TemporaryDirectory() as root:
            import uuid
            chat = str(uuid.uuid4())
            path = Path(root) / 'sessions' / f'{chat}.json'
            path.parent.mkdir()
            path.write_text(json.dumps({'provider': 'claude', 'thread': 'old'}), encoding='utf-8')
            store = AssistantStore(root)
            self.assertEqual(store.session(chat)['thread'], 'old')
            store.save_session(chat, {'provider': 'claude', 'thread': 'branched'})
            self.assertEqual(AssistantStore(root).sessions()[0][1]['thread'], 'branched')
            self.assertEqual(json.loads(path.read_text())['thread'], 'old')
