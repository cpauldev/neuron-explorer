import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'explorer'))
from agent_history import Journal


class JournalTests(unittest.TestCase):
    def test_imported_events_do_not_invent_generation_timestamps(self):
        with tempfile.TemporaryDirectory() as root:
            journal = Journal(root, 'owned')
            imported = journal.append({'t': 'text', 'text': 'old', 'at': None})
            current = journal.append({'t': 'done'})
            self.assertIsNone(imported['at'])
            self.assertGreater(current['at'], 0)
            self.assertIsNone(Journal(root, 'owned').events[0]['at'])

    def test_recovers_partial_write_and_rewinds_only_latest_turn(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / 'events' / 'owned.jsonl'
            path.parent.mkdir()
            events = [{'t': 'user', 'text': '一'}, {'t': 'text', 'text': 'first'}, {'t': 'done'},
                      {'t': 'user', 'text': 'second'}, {'t': 'text', 'text': 'partial'}]
            path.write_text(''.join(json.dumps({**e, 'seq': i + 1}) + '\n' for i, e in enumerate(events)) + '{"broken":', encoding='utf-8')
            restored = Journal(root, 'owned')
            self.assertEqual(restored.cursor, 5)
            restored.rewind()
            self.assertEqual(restored.cursor, 3)
            restored.append({'t': 'user', 'text': 'replacement'})
            self.assertEqual(Journal(root, 'owned').events[-1]['seq'], 4)
            self.assertEqual(Journal(root, 'owned').events[0]['text'], '一')

    def test_recovers_incomplete_utf8_tail(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / 'events' / 'owned.jsonl'
            path.parent.mkdir()
            path.write_bytes(b'{"t":"user","text":"complete","seq":1}\n' + b'{"text":"\xe4\xb8')
            restored = Journal(root, 'owned')
            self.assertEqual(restored.cursor, 1)
            self.assertEqual(restored.events[0]['text'], 'complete')

    def test_empty_rewind_does_not_reimport_legacy_history(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / 'events' / 'owned.jsonl'
            path.parent.mkdir()
            path.write_text('{"seq":1,"t":"user","text":"legacy"}\n', encoding='utf-8')
            journal = Journal(root, 'owned')
            journal.rewind()
            self.assertEqual(Journal(root, 'owned').events, [])
            self.assertIn('legacy', path.read_text())
