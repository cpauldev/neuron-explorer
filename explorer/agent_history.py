"""Explorer event journal backed by SQLite; legacy JSONL is imported once."""
import json
import time
from pathlib import Path
from agent_store import AssistantStore


class Journal:
    def __init__(self, root, chat, notify=None):
        self.store, self.chat = AssistantStore(root), chat
        self.notify = notify
        self.path = Path(root) / 'events' / f'{chat}.jsonl'  # read-only migration source
        with self.store.connect() as db:
            self.store.check_not_deleted(db, chat)
            rows = list(db.execute('SELECT value FROM events WHERE chat=? ORDER BY seq', (chat,)))
            self.events = [json.loads(row[0]) for row in rows]
            # A marker prevents a deliberately emptied journal from importing again.
            db.execute('CREATE TABLE IF NOT EXISTS journal_imports(chat TEXT PRIMARY KEY)')
            imported = db.execute('SELECT 1 FROM journal_imports WHERE chat=?', (chat,)).fetchone()
            if not imported:
                if not self.events and self.path.exists():
                    for line in self.path.read_text(encoding='utf-8', errors='replace').splitlines():
                        try:
                            event = json.loads(line)
                            if event['seq'] != len(self.events) + 1:
                                break
                            db.execute('INSERT INTO events VALUES (?,?,?)', (chat, event['seq'], json.dumps(event, ensure_ascii=False)))
                            self.events.append(event)
                        except (ValueError, KeyError, TypeError):
                            break
                db.execute('INSERT INTO journal_imports VALUES (?)', (chat,))

    @property
    def cursor(self):
        return len(self.events)

    def append(self, event, request_id=None):
        with self.store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            self.store.check_not_deleted(db, self.chat)
            seq = db.execute('SELECT COALESCE(MAX(seq),0)+1 FROM events WHERE chat=?', (self.chat,)).fetchone()[0]
            event = {'at': time.time(), **event, 'seq': seq}
            db.execute('INSERT INTO events VALUES (?,?,?)', (self.chat, seq, json.dumps(event, ensure_ascii=False)))
            if request_id:
                db.execute('UPDATE turns SET state=?,updated=? WHERE request_id=?',
                           (event.get('status') or 'completed', time.time(), request_id))
        self.events.append(event)
        if self.notify:
            self.notify()
        return event

    def rewind(self):
        for i in range(self.cursor - 1, -1, -1):
            if self.events[i].get('t') == 'user':
                with self.store.connect() as db:
                    db.execute('DELETE FROM events WHERE chat=? AND seq>?', (self.chat, i))
                del self.events[i:]
                if self.notify:
                    self.notify()
                break
