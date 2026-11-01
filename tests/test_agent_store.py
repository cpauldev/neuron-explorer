import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'explorer'))
from agent_store import AssistantStore
from agent_history import Journal


class StoreTests(unittest.TestCase):
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
