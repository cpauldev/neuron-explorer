import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'explorer'))
from agent_history import Journal


class JournalTests(unittest.TestCase):
    def test_recovers_partial_write_and_rewinds_only_latest_turn(self):
        with tempfile.TemporaryDirectory() as root:
            journal = Journal(root, 'owned')
            for event in [{'t': 'user', 'text': '一'}, {'t': 'text', 'text': 'first'}, {'t': 'done'},
                          {'t': 'user', 'text': 'second'}, {'t': 'text', 'text': 'partial'}]:
                journal.append(event)
            with journal.path.open('a', encoding='utf-8') as f: f.write('{"broken":')
            restored = Journal(root, 'owned')
            self.assertEqual(restored.cursor, 5)
            restored.rewind()
            self.assertEqual(restored.cursor, 3)
            restored.append({'t': 'user', 'text': 'replacement'})
            self.assertEqual(Journal(root, 'owned').events[-1]['seq'], 4)
            self.assertEqual(json.loads(restored.path.read_text(encoding='utf-8').splitlines()[0])['text'], '一')

    def test_recovers_incomplete_utf8_tail(self):
        with tempfile.TemporaryDirectory() as root:
            journal = Journal(root, 'owned')
            journal.append({'t': 'user', 'text': 'complete'})
            with journal.path.open('ab') as f: f.write(b'{"text":"\xe4\xb8')
            restored = Journal(root, 'owned')
            self.assertEqual(restored.cursor, 1)
            self.assertEqual(restored.events[0]['text'], 'complete')
