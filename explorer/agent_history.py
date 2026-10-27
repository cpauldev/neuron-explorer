"""Explorer-owned event journals. Provider transcripts and credentials stay private to their CLI."""
import json
from pathlib import Path


class Journal:
    def __init__(self, root, chat):
        self.path = Path(root) / 'events' / f'{chat}.jsonl'
        self.events = []
        if self.path.exists():
            for line in self.path.read_text(encoding='utf-8', errors='replace').splitlines():
                try:
                    event = json.loads(line)
                    if event['seq'] != len(self.events) + 1:
                        break
                    self.events.append(event)
                except (ValueError, KeyError, TypeError):
                    break
            # A crash may leave a partial last line. Repair before appending.
            self._rewrite()

    @property
    def cursor(self):
        return len(self.events)

    def append(self, event):
        event = {**event, 'seq': self.cursor + 1}
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.path.open('a', encoding='utf-8') as f:
            f.write(json.dumps(event, ensure_ascii=False) + '\n')
        self.events.append(event)
        return event

    def rewind(self):
        for i in range(self.cursor - 1, -1, -1):
            if self.events[i].get('t') == 'user':
                del self.events[i:]
                self._rewrite()
                break

    def _rewrite(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix('.tmp')
        temporary.write_text(''.join(json.dumps(e, ensure_ascii=False) + '\n' for e in self.events), encoding='utf-8')
        temporary.replace(self.path)
