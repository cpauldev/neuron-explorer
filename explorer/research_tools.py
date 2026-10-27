"""Shared filesystem policy and approved shell execution for either assistant."""
import asyncio
import codecs
import os
from pathlib import Path
import shutil
import tempfile

from agent_common import process_options, stop_process

SCOPES = ('project', 'home')
MAX_TEXT = 256_000

def scoped_path(root, access, value='.'):
    if access not in SCOPES:
        raise ValueError('choose project or home file access')
    root = Path(root).resolve()
    path = Path(value).expanduser()
    path = (root / path).resolve() if not path.is_absolute() else path.resolve()
    roots = [root] + ([Path.home().resolve()] if access == 'home' else [])
    if not any(path == allowed or allowed in path.parents for allowed in roots):
        raise ValueError('path is outside the selected file scope')
    return path


def file_operation(root, access, operation, path='.', content=None):
    target = scoped_path(root, access, path)
    if operation == 'list':
        entries = sorted(target.iterdir(), key=lambda p: p.name.lower())
        return {'path': str(target), 'entries': [{'name': p.name, 'directory': p.is_dir(), 'symlink': p.is_symlink()}
                for p in entries[:400]], 'truncated': len(entries) > 400}
    if operation == 'read':
        with target.open('rb') as f:
            raw = f.read(MAX_TEXT + 1)
        truncated = len(raw) > MAX_TEXT
        # A byte limit can bisect a valid UTF-8 character; buffer that final fragment rather than rejecting the file.
        text = codecs.getincrementaldecoder('utf-8')().decode(raw[:MAX_TEXT], final=not truncated)
        return {'path': str(target), 'text': text, 'truncated': truncated}
    if operation == 'write':
        if not isinstance(content, str) or len(content.encode('utf-8')) > MAX_TEXT:
            raise ValueError('file content must be UTF-8 text up to 256 KB')
        if '.git' in target.parts:
            raise ValueError('direct writes into .git are not supported')
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding='utf-8')
        return {'path': str(target), 'written': True}
    raise ValueError('unknown file operation')


async def run_shell(command, cwd, timeout, work, cancel):
    """The caller must obtain explicit user approval before invoking this function.

    cwd is a starting directory, not an OS security boundary. Arbitrary shell
    commands run with the current user's permissions on every supported platform.
    """
    if cancel.is_set():
        return {'cancelled': True}
    if os.name == 'nt':
        shell = shutil.which('powershell') or shutil.which('pwsh')
        if not shell:
            raise ValueError('PowerShell is required for shell experiments on Windows')
        args = [shell, '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command]
    else:
        args = [shutil.which('bash') or '/bin/sh', '-c', command]
    Path(work).mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryFile(dir=work) as output:
        proc = await asyncio.create_subprocess_exec(*args, cwd=str(cwd), stdin=asyncio.subprocess.DEVNULL,
            stdout=output, stderr=asyncio.subprocess.STDOUT, **process_options())
        finished = asyncio.create_task(proc.wait())
        cancelled = asyncio.create_task(cancel.wait())
        try:
            done, _ = await asyncio.wait([finished, cancelled], timeout=timeout, return_when=asyncio.FIRST_COMPLETED)
            interrupted = cancelled in done or not done
            if interrupted:
                await stop_process(proc)
            output.seek(0)
            raw = output.read(64_001)
            return {'exit_code': proc.returncode, 'output': raw[:64_000].decode('utf-8', errors='replace'),
                    'truncated': len(raw) > 64_000, 'cancelled': cancel.is_set(), 'timed_out': not done}
        finally:
            if proc.returncode is None:
                await stop_process(proc)
            for task in (finished, cancelled):
                task.cancel()
            await asyncio.gather(finished, cancelled, return_exceptions=True)
