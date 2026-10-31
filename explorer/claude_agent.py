"""Claude CLI adapter for the same browser event protocol used by Codex."""
import asyncio
from collections import deque
import json
import os
from pathlib import Path
import shutil
import uuid

from agent_common import AgentError, explorer_mcp, process_options, stop_process, tool_output


def claude_command():
    binary = os.environ.get('EXPLORER_CLAUDE_BIN') or shutil.which('claude')
    if not binary:
        raise AgentError('Claude CLI not found. Install Claude Code and sign in, or choose Codex.')
    path = Path(binary)
    if os.name == 'nt' and path.suffix.lower() in ('.cmd', '.bat', '.ps1'):
        # Execute the npm installation directly, without interpolating arguments into cmd.exe.
        package = path.parent / 'node_modules' / '@anthropic-ai' / 'claude-code'
        native = package / 'bin' / 'claude.exe'
        if native.exists():
            return [str(native)]
        script = package / 'cli.js'
        node = shutil.which('node')
        if script.exists() and node:
            return [node, str(script)]
        raise AgentError('Set EXPLORER_CLAUDE_BIN to the Claude executable; this launcher cannot be run directly.')
    return [binary]


def session_file(sid):
    # Caller supplies only an explorer-owned session UUID.
    uuid.UUID(sid)
    return next((Path.home() / '.claude' / 'projects').glob(f'*/{sid}.jsonl'), None)


def session_record(line):
    """Ignore incomplete/non-record lines without rewriting the original log."""
    try:
        value = json.loads(line)
        return value if isinstance(value, dict) else {}
    except ValueError:
        return {}


def user_text(message):
    """Get a real user turn, excluding metadata and tool-result messages."""
    if message.get('type') != 'user' or message.get('isMeta'):
        return None
    body = message.get('message')
    if not isinstance(body, dict):
        return None
    content = body.get('content')
    if isinstance(content, list):
        if any(isinstance(c, dict) and c.get('type') == 'tool_result' for c in content):
            return None
        content = next((c.get('text', '') for c in content if isinstance(c, dict) and c.get('type') == 'text'), '')
    return content if isinstance(content, str) else None


def legacy_session(sid, cwd):
    """Recover old explorer chats only when Claude's log confirms their working directory."""
    path = session_file(sid)
    if path is None:
        return None
    owned, latest = False, None
    with path.open(encoding='utf-8') as f:
        for line in f:
            message = session_record(line)
            if message.get('cwd') and os.path.normcase(os.path.abspath(message['cwd'])) == os.path.normcase(os.path.abspath(cwd)):
                owned = True
            content = user_text(message)
            if content is not None:
                latest = content
    if not owned:
        return None
    result = {'provider': 'claude', 'thread': sid}
    if latest is not None:
        if latest.startswith('[The person has ') and '\n\n' in latest:
            latest = latest.split('\n\n', 1)[1]
        result.update(last_turn='legacy-latest', last_message=latest)
    return result


def browser_events(message):
    kind = message.get('type')
    if kind == 'stream_event':
        event = message.get('event', {})
        if event.get('type') == 'content_block_delta' and event.get('delta', {}).get('type') == 'text_delta':
            yield {'t': 'text', 'text': event['delta']['text']}
    elif kind == 'assistant':
        for block in message.get('message', {}).get('content', []):
            if block.get('type') == 'tool_use':
                yield {'t': 'tool', 'id': block.get('id'), 'name': block['name'].removeprefix('mcp__explorer__'),
                       'input': block.get('input', {})}
    elif kind == 'user':
        for block in message.get('message', {}).get('content', []):
            if isinstance(block, dict) and block.get('type') == 'tool_result':
                output = block.get('content', '')
                if isinstance(output, list):
                    output = '\n'.join(c.get('text', '') for c in output if isinstance(c, dict))
                output = str(output)
                yield {'t': 'tool_result', 'id': block.get('tool_use_id'), 'error': bool(block.get('is_error')),
                       'output': tool_output(output)}
    elif kind == 'result':
        if message.get('is_error'):
            yield {'t': 'error', 'error': str(message.get('result') or 'Claude request failed')[:600]}
        yield {'t': 'done', 'status': 'failed' if message.get('is_error') else 'completed', 'cost': message.get('total_cost_usd')}


class ClaudeClient:
    def __init__(self, cwd, queue):
        self.cwd, self.queue = cwd, queue
        self.proc = None
        self.tasks = []
        self.stderr = deque(maxlen=30)
        self.thread = self.turn = None
        self.finished = True

    @property
    def alive(self):
        return bool(self.proc and self.proc.returncode is None and self.tasks and all(not t.done() for t in self.tasks))

    async def start(self):
        self.command = claude_command()

    async def history(self, thread):
        def read():
            if not legacy_session(thread, self.cwd):
                raise AgentError('This conversation does not belong to the explorer working directory.')
            events = []
            with session_file(thread).open(encoding='utf-8') as f:
                for line in f:
                    record = session_record(line)
                    text = user_text(record)
                    if text is not None:
                        if text.startswith('[The person has ') and '\n\n' in text:
                            text = text.split('\n\n', 1)[1]
                        events.append({'t': 'user', 'text': text})
                    elif record.get('type') == 'assistant':
                        for block in record.get('message', {}).get('content', []):
                            if block.get('type') == 'text':
                                events.append({'t': 'text', 'text': block.get('text', '')})
                    events.extend(browser_events(record))
            if events:
                events.append({'t': 'done', 'status': 'completed'})
            return events
        return await asyncio.to_thread(read)

    async def open_thread(self, root, chat, port, instructions, thread=None):
        self.thread, self.chat = thread or chat, chat
        prompt = Path(self.cwd) / f'system_prompt-{chat}-claude.md'
        prompt.write_text(instructions, encoding='utf-8')
        mcp = {'mcpServers': {'explorer': explorer_mcp(root, chat, port)}}
        self.args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
                     '--include-partial-messages', '--system-prompt-file', str(prompt),
                     '--mcp-config', json.dumps(mcp), '--strict-mcp-config', '--tools', '',
                     '--allowedTools', 'mcp__explorer', '--setting-sources', '',
                     '--settings', json.dumps({'enabledPlugins': {}})]
        model = getattr(self, 'model', None) or os.environ.get('EXPLORER_CLAUDE_MODEL') or 'default'
        if model:
            self.args += ['--model', model]
        return self.thread

    async def call(self, method, params):
        if method != 'turn/start':
            raise AgentError(f'Unsupported Claude operation: {method}')
        if self.turn:
            raise AgentError('This Claude conversation is already running.')
        if not self.alive:
            resume = ['--resume', self.thread] if session_file(self.thread) else ['--session-id', self.thread]
            try:
                self.proc = await asyncio.create_subprocess_exec(
                    *self.command, *self.args, *resume, cwd=self.cwd,
                    stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE, limit=1 << 24, **process_options())
            except OSError as e:
                raise AgentError(f'Cannot start Claude CLI: {e}. Check your Claude installation or choose Codex.') from e
            self.tasks = [asyncio.create_task(self._read()), asyncio.create_task(self._stderr())]
        self.turn = str(uuid.uuid4())
        self.finished = False
        self.proc.stdin.write((json.dumps({'type': 'user', 'message': {'role': 'user', 'content': params['input']}}) + '\n').encode())
        await self.proc.stdin.drain()
        return {'turn': {'id': self.turn}}

    async def _stderr(self):
        async for line in self.proc.stderr:
            self.stderr.append(line.decode(errors='replace').rstrip())

    async def _read(self):
        try:
            async for line in self.proc.stdout:
                try:
                    message = json.loads(line)
                except ValueError:
                    continue
                for event in browser_events(message):
                    if event['t'] == 'done':
                        self.finished = True
                        self.turn = None
                    self.queue.put_nowait(('event', event))
            code = await self.proc.wait()
            if not self.finished:
                await self.tasks[1]  # collect diagnostics before reporting an early CLI exit
                self.queue.put_nowait(('event', {'t': 'error', 'error': '\n'.join(self.stderr)[-600:] or f'Claude exited {code} without a result'}))
        finally:
            self.queue.put_nowait(('closed', None))

    async def rewind(self, text):
        """Claude has no public revert endpoint; back up and trim its latest user turn."""
        path = session_file(self.thread)
        if path is None:
            raise AgentError('Claude session not found; start a new conversation.')
        lines = path.read_text(encoding='utf-8').splitlines(True)
        at = None
        for i in range(len(lines) - 1, -1, -1):
            content = user_text(session_record(lines[i]))
            if content is None:
                continue
            if content.strip() == text.strip() or content.strip().endswith('\n\n' + text.strip()):
                at = i
            break  # never trim an earlier match after a newer user turn
        if at is None:
            raise AgentError('Latest Claude turn not found; reload the conversation before editing.')
        shutil.copy2(path, path.with_name(path.name + f'.bak-{uuid.uuid4().hex[:8]}'))
        keep = lines[:at]
        if any(user_text(session_record(line)) is not None for line in keep):
            path.write_text(''.join(keep), encoding='utf-8')
        else:
            path.unlink()  # a fresh --session-id is needed after reverting the first turn

    async def close(self):
        if self.proc is not None and self.proc.returncode is None:
            self.proc.stdin.close()
            try:
                await asyncio.wait_for(self.proc.wait(), .25)
            except asyncio.TimeoutError:
                await stop_process(self.proc)
        for task in self.tasks:
            task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)
