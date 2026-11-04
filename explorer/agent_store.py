"""Transactional Explorer history and turn receipts, independent of provider files."""
from contextlib import contextmanager
import json
from pathlib import Path
import sqlite3
import time


class AssistantStore:
    def __init__(self, root):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.path = self.root / 'assistant.sqlite3'
        with self.connect() as db:
            if db.execute('PRAGMA user_version').fetchone()[0] not in (0, 1):
                raise RuntimeError('Assistant database was created by a newer Explorer version.')
            db.execute('PRAGMA journal_mode=WAL')
            db.executescript('''
                CREATE TABLE IF NOT EXISTS sessions(chat TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS deleted_chats(chat TEXT PRIMARY KEY);
                CREATE TABLE IF NOT EXISTS events(
                    chat TEXT NOT NULL, seq INTEGER NOT NULL, value TEXT NOT NULL,
                    PRIMARY KEY(chat, seq));
                CREATE TABLE IF NOT EXISTS turns(
                    request_id TEXT PRIMARY KEY, chat TEXT NOT NULL, fingerprint TEXT NOT NULL,
                    cursor INTEGER NOT NULL, state TEXT NOT NULL, provider_turn TEXT,
                    updated REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS approvals(
                    id TEXT PRIMARY KEY, request_id TEXT, command TEXT NOT NULL,
                    cwd TEXT NOT NULL, state TEXT NOT NULL);
                PRAGMA user_version=1;
            ''')

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=10)
        try:
            db.execute('PRAGMA foreign_keys=ON')
            with db:
                yield db
        finally:
            db.close()

    def session(self, chat):
        with self.connect() as db:
            if db.execute('SELECT 1 FROM deleted_chats WHERE chat=?', (chat,)).fetchone():
                return {}
            row = db.execute('SELECT value FROM sessions WHERE chat=?', (chat,)).fetchone()
        if row:
            return json.loads(row[0])
        legacy = self.root / 'sessions' / f'{chat}.json'
        if legacy.exists():
            value = json.loads(legacy.read_text(encoding='utf-8'))
            self.save_session(chat, value)
            return value
        return {}

    def save_session(self, chat, value):
        with self.connect() as db:
            self.check_not_deleted(db, chat)
            db.execute('INSERT OR REPLACE INTO sessions VALUES (?,?)', (chat, json.dumps(value)))

    @staticmethod
    def check_not_deleted(db, chat):
        if db.execute('SELECT 1 FROM deleted_chats WHERE chat=?', (chat,)).fetchone():
            raise ValueError('This chat was deleted. Start a new conversation.')

    def check_chat(self, chat):
        with self.connect() as db:
            self.check_not_deleted(db, chat)

    def delete(self, chat):
        """Remove local history; retain IDs and fingerprints to prevent re-import/retry."""
        import uuid
        if not isinstance(chat, str) or str(uuid.UUID(chat)) != chat:
            raise ValueError('Invalid chat ID.')
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            db.execute('INSERT OR IGNORE INTO deleted_chats VALUES (?)', (chat,))
            db.execute('DELETE FROM approvals WHERE request_id IN (SELECT request_id FROM turns WHERE chat=?)', (chat,))
            db.execute('DELETE FROM events WHERE chat=?', (chat,))
            db.execute('DELETE FROM sessions WHERE chat=?', (chat,))
            # Retain idempotency receipts so a delayed submission cannot repeat a deleted turn.
            db.execute("UPDATE turns SET state='deleted',provider_turn=NULL WHERE chat=?", (chat,))
        for folder, suffix in (('sessions', '.json'), ('events', '.jsonl')):
            (self.root / folder / f'{chat}{suffix}').unlink(missing_ok=True)

    def sessions(self):
        for path in (self.root / 'sessions').glob('*.json'):
            try:
                import uuid
                if str(uuid.UUID(path.stem)) == path.stem:
                    self.session(path.stem)
            except (ValueError, OSError):
                continue
        with self.connect() as db:
            return [(chat, json.loads(value)) for chat, value in db.execute('SELECT chat,value FROM sessions')]

    def receipt(self, request_id, fingerprint):
        with self.connect() as db:
            row = db.execute('SELECT chat,cursor,fingerprint,state FROM turns WHERE request_id=?',
                             (request_id,)).fetchone()
        if row:
            if row[2] != fingerprint:
                raise ValueError('request_id was already used for a different message')
            return {'chat': row[0], 'cursor': row[1], 'state': row[3]}
        return None

    def reserve(self, request_id, chat, fingerprint, session, user):
        """Commit the acceptance receipt, session and user event together before execution."""
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            self.check_not_deleted(db, chat)
            cursor = db.execute('SELECT COALESCE(MAX(seq),0) FROM events WHERE chat=?', (chat,)).fetchone()[0]
            db.execute('INSERT INTO turns VALUES (?,?,?,?,?,?,?)',
                       (request_id, chat, fingerprint, cursor, 'queued', None, time.time()))
            db.execute('INSERT OR REPLACE INTO sessions VALUES (?,?)', (chat, json.dumps(session)))
            event = {'at': time.time(), **user, 'seq': cursor + 1}
            db.execute('INSERT INTO events VALUES (?,?,?)', (chat, cursor + 1, json.dumps(event, ensure_ascii=False)))
        return cursor, event

    def transition(self, request_id, state, provider_turn=None):
        if request_id:
            with self.connect() as db:
                # Late approval cleanup must not reopen a settled or recovered turn.
                db.execute("UPDATE turns SET state=?,provider_turn=COALESCE(?,provider_turn),updated=? WHERE request_id=? AND state IN ('queued','running','awaiting_approval')",
                           (state, provider_turn, time.time(), request_id))

    def recover(self, chat):
        """An interrupted process cannot prove whether a submitted operation executed."""
        with self.connect() as db:
            db.execute("UPDATE turns SET state='unknown',updated=? WHERE chat=? AND state IN ('queued','running','awaiting_approval')",
                       (time.time(), chat))
            db.execute("UPDATE approvals SET state='expired' WHERE state='pending' AND request_id IN (SELECT request_id FROM turns WHERE chat=?)", (chat,))

    def approval(self, aid, request_id, command, cwd):
        with self.connect() as db:
            db.execute('INSERT INTO approvals VALUES (?,?,?,?,?)', (aid, request_id, command, cwd, 'pending'))

    def decide(self, aid, allow):
        with self.connect() as db:
            changed = db.execute("UPDATE approvals SET state=? WHERE id=? AND state='pending'",
                                 ('allowed' if allow else 'declined', aid)).rowcount
        return bool(changed)
