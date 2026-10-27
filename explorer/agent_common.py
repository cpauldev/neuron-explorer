"""Shared CLI transport configuration and process cleanup for assistant providers."""
import asyncio
import os
from pathlib import Path
import signal
import subprocess
import sys
import time


class AgentError(RuntimeError):
    """An assistant transport or session could not complete an operation."""


class AgentPool:
    """Reuse healthy configured clients; callers serialize turns for each chat.

    Only idle clients are expired or evicted. Stop, errors and policy changes
    discard the process; the provider's saved thread remains resumable.
    """
    def __init__(self, idle_seconds=300, max_idle=4, clock=time.monotonic):
        self.idle_seconds, self.max_idle, self.clock = idle_seconds, max_idle, clock
        self.clients = {}

    async def acquire(self, chat, policy, factory, connect):
        entry = self.clients.get(chat)
        if entry and entry['busy']:
            raise AgentError('This assistant conversation is already running.')
        if entry and (entry['policy'] != policy or not entry['client'].alive
                      or self.clock() - entry['used'] >= self.idle_seconds):
            await self.discard(chat)
            entry = None
        if entry:
            # Never replay idle notifications as part of the next reply.
            while not entry['client'].queue.empty():
                entry['client'].queue.get_nowait()
            entry['busy'] = True
            return entry
        client = factory()
        try:
            thread = await connect(client)
        except BaseException:
            await client.close()
            raise
        entry = {'client': client, 'thread': thread, 'policy': policy, 'busy': True, 'used': self.clock()}
        self.clients[chat] = entry
        return entry

    async def release(self, chat, client, reusable):
        entry = self.clients.get(chat)
        if not entry or entry['client'] is not client:
            await client.close()
        elif not reusable or not client.alive:
            await self.discard(chat)
        else:
            entry.update(busy=False, used=self.clock())
            await self.reap()

    async def discard(self, chat):
        entry = self.clients.pop(chat, None)
        if entry:
            closing = asyncio.create_task(entry['client'].close())
            try:
                await asyncio.shield(closing)
            except asyncio.CancelledError:
                await closing
                raise

    async def reap(self):
        idle = sorted(((chat, entry) for chat, entry in self.clients.items() if not entry['busy']),
                      key=lambda pair: pair[1]['used'])
        for chat, entry in idle:
            # Closing another process can yield while this one becomes active.
            if self.clients.get(chat) is not entry or entry['busy']:
                continue
            if (sum(not e['busy'] for e in self.clients.values()) > self.max_idle or not entry['client'].alive
                    or self.clock() - entry['used'] >= self.idle_seconds):
                await self.discard(chat)

    async def close(self):
        await asyncio.gather(*(self.discard(chat) for chat in list(self.clients)))


def explorer_mcp(root, chat, port):
    return {
        'command': sys.executable,
        'args': [str(Path(root) / 'explorer' / 'agent_mcp.py')],
        'env': {'EXPLORER_URL': f'http://127.0.0.1:{port}', 'EXPLORER_CHAT': chat},
    }


def process_options():
    """Hide Windows console windows; isolate Unix children for group cancellation."""
    return {'creationflags': subprocess.CREATE_NO_WINDOW} if os.name == 'nt' else {'start_new_session': True}


def tool_output(text, limit=1500):
    return text[:limit] + (f' … ({len(text)} chars)' if len(text) > limit else '')


async def stop_process(proc):
    """Stop the entire process tree, including CLI-launched MCP servers and shells."""
    if proc.returncode is not None:
        return
    if os.name == 'nt':
        killer = await asyncio.create_subprocess_exec(
            'taskkill', '/PID', str(proc.pid), '/T', '/F',
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
            creationflags=subprocess.CREATE_NO_WINDOW)
        await killer.wait()
    else:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    try:
        await asyncio.wait_for(proc.wait(), 3)
    except asyncio.TimeoutError:
        if proc.returncode is None:
            proc.kill()
        await proc.wait()
