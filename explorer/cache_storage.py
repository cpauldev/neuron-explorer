"""Atomic cache files and OS-owned locks, independent of worker orchestration and model loading."""
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import uuid


def digest(path):
    with Path(path).open("rb") as f:
        return hashlib.file_digest(f, "sha256").hexdigest()


def atomic_json(path, value):
    atomic_write(path, lambda f: f.write(json.dumps(value, indent=2).encode()))


def atomic_npz(path, **arrays):
    import numpy as np
    atomic_write(path, lambda f: np.savez_compressed(f, **arrays))


def atomic_write(path, writer):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp-" + uuid.uuid4().hex)
    try:
        with temporary.open("wb") as f:
            writer(f)
            f.flush()
            os.fsync(f.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


@contextmanager
def job_lock(path):
    """OS-owned lock: a crash releases it; a stale PID can never authorize a kill."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+b") as f:
        if os.fstat(f.fileno()).st_size == 0:
            f.write(b"0")
            f.flush()
        f.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            raise RuntimeError(f"Another process holds {path}. Stop the live model or wait for the cache worker.") from exc
        try:
            yield
        finally:
            f.seek(0)
            if os.name == "nt":
                msvcrt.locking(f.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(f, fcntl.LOCK_UN)
