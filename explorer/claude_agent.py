"""Claude Agent SDK adapter for Explorer's provider-neutral event stream."""
import asyncio
from dataclasses import asdict
import os
import logging
from pathlib import Path
import re
import tempfile
import uuid

from anyio import CancelScope
from claude_agent_sdk import (
    ClaudeAgentOptions, ClaudeSDKClient, AssistantMessage, UserMessage,
    SystemMessage, ResultMessage, StreamEvent, PermissionResultDeny, PermissionResultAllow,
    get_session_info, get_session_messages, fork_session,
)
from agent_common import AgentError, explorer_mcp, tool_output

logger = logging.getLogger(__name__)


def claude_error(error, *, code=None):
    """Classify provider failures without mistaking launch failures for sign-in failures."""
    text = str(error)
    lower = text.lower()
    if code == 'authentication_failed' or any(marker in lower for marker in (
            'not logged in', 'please run /login', 'authentication_failed',
            'invalid api key', 'authentication failed', 'failed to authenticate',
            'oauth session expired', 'please run claude auth login')):
        return ('Claude needs authentication. Run `claude auth login` in a terminal on the '
                'machine running Neuron Explorer, then retry. If you use an API key or cloud '
                'provider, check that configuration instead.')
    if 'claude code not found at:' in lower:
        path = re.split('claude code not found at:', text, flags=re.IGNORECASE)[-1].strip()
        if Path(path).is_file():
            return ('Claude Code could not launch, although its executable exists. Check the '
                    'server logs for the underlying process error. If needed, set '
                    'EXPLORER_CLAUDE_BIN to a working Claude executable and restart the server.')
        return ('Claude Code executable was not found. Repair the Claude Agent SDK installation '
                'or set EXPLORER_CLAUDE_BIN to a working Claude executable, then restart the server.')
    if isinstance(error, (TimeoutError, asyncio.TimeoutError)):
        return 'Claude took too long to start. Check the server logs and your connection, then retry.'
    return f'Claude request failed: {text[:600]}'


def user_text(message):
    if message.get('type') != 'user' or message.get('isMeta'):
        return None
    body = message.get('message')
    if not isinstance(body, dict):
        return None
    content = body.get('content')
    if isinstance(content, list):
        if any(isinstance(c, dict) and c.get('type') == 'tool_result' for c in content):
            return None
        content = '\n'.join(c.get('text', '') for c in content if isinstance(c, dict) and c.get('type') == 'text')
    return content if isinstance(content, str) else None


def session_messages(sid, cwd):
    uuid.UUID(sid)
    info = get_session_info(sid, directory=cwd)
    if not info or not info.cwd or os.path.normcase(os.path.abspath(info.cwd)) != os.path.normcase(os.path.abspath(cwd)):
        raise AgentError('This conversation does not belong to the explorer working directory.')
    return get_session_messages(sid, directory=cwd)


def legacy_session(sid, cwd):
    """Import explorer-owned sessions through the supported SDK, never internal files."""
    try:
        messages = session_messages(sid, cwd)
    except (AgentError, ValueError):
        return None
    latest = next((user_text({'type': m.type, 'message': m.message}) for m in reversed(messages)
                   if user_text({'type': m.type, 'message': m.message}) is not None), None)
    result = {'provider': 'claude', 'thread': sid}
    if latest is not None:
        if latest.startswith('[The person has ') and '\n\n' in latest:
            latest = latest.split('\n\n', 1)[1]
        result.update(last_turn='legacy-latest', last_message=latest)
    return result


def browser_events(message):
    kind = message.get('type')
    if kind == 'provider_error':
        yield {'t': 'error', 'error': claude_error(message.get('error', ''), code=message.get('code'))}
        return
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
            yield {'t': 'error', 'error': claude_error(message.get('result') or 'Unknown provider error')}
        yield {'t': 'done', 'status': 'failed' if message.get('is_error') else 'completed', 'cost': message.get('total_cost_usd')}


def sdk_record(message):
    """Convert public SDK dataclasses; reasoning blocks are deliberately excluded."""
    if isinstance(message, StreamEvent):
        return {'type': 'stream_event', 'event': message.event}
    if isinstance(message, (AssistantMessage, UserMessage)):
        if isinstance(message, AssistantMessage) and getattr(message, 'error', None):
            return {'type': 'provider_error', 'code': message.error,
                    'error': '; '.join(block.text for block in message.content if hasattr(block, 'text'))}
        blocks = []
        for block in message.content if isinstance(message.content, list) else []:
            value = asdict(block)
            kind = type(block).__name__
            tag = {'TextBlock': 'text', 'ToolUseBlock': 'tool_use', 'ToolResultBlock': 'tool_result'}.get(kind)
            if tag:
                blocks.append({'type': tag, **value})
        return {'type': 'assistant' if isinstance(message, AssistantMessage) else 'user',
                'message': {'content': blocks}}
    if isinstance(message, ResultMessage):
        return {'type': 'result', 'is_error': message.is_error,
                'result': message.result or '; '.join(message.errors or []),
                'total_cost_usd': message.total_cost_usd}
    return {}


class ClaudeClient:
    def __init__(self, cwd, queue):
        self.cwd, self.queue = cwd, queue
        self.sdk = self.worker = None
        self.thread = self.turn = None
        self.ready = None
        self.closing = False
        self.prompt_file = None

    @property
    def alive(self):
        return bool(self.sdk and self.worker and not self.worker.done() and not self.closing)

    async def start(self):
        pass  # The worker owns SDK connect/disconnect in the same AnyIO task.

    async def history(self, thread):
        messages = await asyncio.to_thread(session_messages, thread, self.cwd)
        events = []
        for m in messages:
            record = {'type': m.type, 'message': m.message}
            text = user_text(record)
            if text is not None:
                if text.startswith('[The person has ') and '\n\n' in text:
                    text = text.split('\n\n', 1)[1]
                events.append({'t': 'user', 'text': text})
            elif m.type == 'assistant':
                for block in m.message.get('content', []):
                    if block.get('type') == 'text':
                        events.append({'t': 'text', 'text': block.get('text', '')})
            events.extend(browser_events(record))
        if events:
            events.append({'t': 'done', 'status': 'completed'})
        return events

    async def _permission(self, name, arguments, context):
        if name in self.tool_names:
            return PermissionResultAllow(updated_input=arguments)
        return PermissionResultDeny(message='Use the shared Explorer tools. Shell commands require approval in the panel.')

    async def open_thread(self, root, chat, port, instructions, thread=None):
        self.thread, self.chat = thread or chat, chat
        self.tool_names = {'mcp__explorer__' + tool['name'] for tool in self._tools()}
        # Keep the methodology out of argv: Windows limits process command length.
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', suffix='.md',
                                         prefix='explorer-claude-', delete=False) as prompt:
            prompt.write(instructions)
            self.prompt_file = prompt.name
        self.options = ClaudeAgentOptions(
            cwd=self.cwd, system_prompt={'type': 'file', 'path': self.prompt_file}, tools=[],
            mcp_servers={'explorer': explorer_mcp(root, chat, port)}, strict_mcp_config=True,
            setting_sources=[], settings='{"enabledPlugins":{}}',
            can_use_tool=self._permission, include_partial_messages=True, verbatim_prompts=True,
            model=getattr(self, 'model', None) or os.environ.get('EXPLORER_CLAUDE_MODEL') or 'default',
            cli_path=os.environ.get('EXPLORER_CLAUDE_BIN') or None,
            resume=thread, session_id=None if thread else self.thread,
        )
        return self.thread

    @staticmethod
    def _tools():
        # One authoritative tool list for both providers.
        from agent_mcp import TOOLS
        return TOOLS

    async def call(self, method, params):
        if method != 'turn/start':
            raise AgentError(f'Unsupported Claude operation: {method}')
        if self.turn:
            raise AgentError('This Claude conversation is already running.')
        self.turn = turn = str(uuid.uuid4())
        try:
            if not self.alive:
                self.closing = False
                self.ready = asyncio.get_running_loop().create_future()
                self.worker = asyncio.create_task(self._run())
                await asyncio.wait_for(asyncio.shield(self.ready), 75)
            async def prompt():
                yield {'type': 'user', 'uuid': turn,
                       'message': {'role': 'user', 'content': params['input']}}
            if not self.sdk or self.worker.done():
                raise AgentError('Claude connection closed before the turn was sent.')
            await self.sdk.query(prompt())
            return {'turn': {'id': turn}}
        except BaseException as e:
            await self.close()
            if isinstance(e, asyncio.CancelledError):
                raise
            logger.exception('Claude turn startup failed')
            raise AgentError(claude_error(e)) from e

    async def _run(self):
        sdk = ClaudeSDKClient(self.options)
        self.sdk = sdk
        try:
            await sdk.connect()
            if not self.ready.done():
                self.ready.set_result(True)
            last_error = None
            async for message in sdk.receive_messages():
                if isinstance(message, SystemMessage) and message.subtype == 'init':
                    reported = message.data.get('session_id')
                    if reported and reported != self.thread:
                        raise AgentError('Claude returned an unexpected session ID.')
                for event in browser_events(sdk_record(message)):
                    if event['t'] == 'error':
                        if event['error'] == last_error:
                            continue
                        last_error = event['error']
                    elif event['t'] == 'done':
                        last_error = None
                    self.queue.put_nowait(('event', event))
        except asyncio.CancelledError:
            raise
        except Exception as e:
            if not self.ready.done():
                self.ready.set_exception(e)
            elif not self.closing:
                logger.exception('Claude connection failed')
                self.queue.put_nowait(('event', {'t': 'error', 'error': claude_error(e)}))
        finally:
            with CancelScope(shield=True):
                await sdk.disconnect()
            self.sdk = None
            if not self.closing:
                self.queue.put_nowait(('closed', None))

    async def rewind(self, text):
        """Branch through the SDK; the original provider session stays intact."""
        messages = await asyncio.to_thread(session_messages, self.thread, self.cwd)
        at = next((i for i in range(len(messages) - 1, -1, -1)
                   if user_text({'type': messages[i].type, 'message': messages[i].message}) is not None), None)
        if at is None:
            raise AgentError('Latest Claude turn not found; reload the conversation before editing.')
        latest = user_text({'type': messages[at].type, 'message': messages[at].message}).strip()
        if latest != text.strip() and not latest.endswith('\n\n' + text.strip()):
            raise AgentError('Latest Claude turn changed; reload the conversation before editing.')
        if at == 0:
            self.thread = str(uuid.uuid4())
            return None  # Next turn creates a fresh provider session.
        forked = await asyncio.to_thread(fork_session, self.thread, directory=self.cwd,
                                        up_to_message_id=messages[at - 1].uuid)
        self.thread = forked.session_id
        return self.thread

    async def close(self):
        self.closing = True
        if self.worker:
            self.worker.cancel()
            await asyncio.gather(self.worker, return_exceptions=True)
            self.worker = None
        self.turn = None
        if self.prompt_file:
            Path(self.prompt_file).unlink(missing_ok=True)
            self.prompt_file = None
