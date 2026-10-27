"""Resumable offline cache jobs. Run with --help; no web server is required."""
import argparse
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import subprocess
import sys
import time

from model_config import DEFAULT_MODEL, ROOT, data_paths, snapshot, validate_config
from cache_storage import atomic_json, atomic_npz, digest, job_lock

STAGES = ("layout_writes", "layout_reads", "connections", "lens", "steer", "activations")
VERSION = 1  # Bump when algorithms or checkpoint formats change.


class Paused(Exception):
    pass


class Job:
    def __init__(self, directory):
        self.directory = Path(directory).resolve()
        self.manifest = json.loads((self.directory / "job.json").read_text())
        if self.manifest["version"] != VERSION:
            raise ValueError("Checkpoint version changed; create a new job.")
        identity = hashlib.sha256(json.dumps(self.manifest, sort_keys=True).encode()).hexdigest()
        seal = self.directory / "identity.json"
        if seal.exists() and json.loads(seal.read_text()) != identity:
            raise ValueError("Job model/settings changed; create a new job rather than mixing checkpoints.")
        if not seal.exists():
            atomic_json(seal, identity)
        self.cache = Path(self.manifest["cache"])
        self.started = time.monotonic()
        self.session_done = 0

    def validate_environment(self):
        for package, version in self.manifest.get("packages", {}).items():
            if importlib.metadata.version(package) != version:
                raise ValueError(f"{package} changed since job creation; restore version {version} before resuming.")

    def boundary(self):
        if (self.directory / "pause").exists():
            raise Paused()

    def progress(self, stage, done, total, *, measured=True):
        if measured:
            self.session_done += 1
            if self.session_done == 1:
                self.started = time.monotonic()
        elapsed = time.monotonic() - self.started
        state = {"status": "running", "pid": os.getpid(), "stage": stage,
                 "completed_units": done, "total_units": total, "updated": time.time()}
        # Measure completed new units; omit loading and checkpoint replay from the estimate.
        if self.session_done > 1:
            state["eta_seconds"] = elapsed / (self.session_done - 1) * (total - done)
        atomic_json(self.directory / "status.json", state)
        print(json.dumps(state), flush=True)

    def save(self, path, **arrays):
        atomic_npz(path, **arrays)

    def part(self, stage, name):
        return self.directory / "parts" / stage / f"{name}.npz"


def run(directory):
    job = Job(directory)
    job.validate_environment()
    with job_lock(job.directory / "worker.lock"):
        try:
            run_stages(job)
        except (Paused, KeyboardInterrupt):
            atomic_json(job.directory / "status.json", {"status": "paused", "updated": time.time()})
        except Exception as exc:
            atomic_json(job.directory / "status.json", {"status": "failed", "error": str(exc), "updated": time.time()})
            raise


def run_stages(job):
    job.boundary()
    for stage in job.manifest["stages"]:
        marker = job.directory / f"{stage}.done.json"
        output = job.cache / {"lens": "lens_index.npz", "steer": "steer_index.npz",
                              "activations": "act_scale.npz"}.get(stage, f"{stage}.npz")
        if marker.exists() and output.exists():
            if json.loads(marker.read_text()).get("sha256") == digest(output):
                continue
        job.boundary()
        atomic_json(job.directory / "status.json", {"status": "running", "stage": stage,
                                                   "phase": "loading", "pid": os.getpid(), "updated": time.time()})
        # A fresh process per stage releases all GPU memory before the next stage.
        command = [sys.executable, str(Path(__file__).resolve()), "_stage", str(job.directory), "--stage", stage]
        try:
            subprocess.run(command, check=True, cwd=ROOT,
                           env={**os.environ, "EXPLORER_CACHE_WORKER": "1", "EXPLORER_NO_MODEL": "",
                                "EXPLORER_MODEL": job.manifest["model"], "EXPLORER_REVISION": job.manifest["revision"]})
        except subprocess.CalledProcessError as exc:
            if exc.returncode == 2 and (job.directory / "pause").exists():
                raise Paused() from None
            raise
        job.boundary()
        atomic_json(marker, {"completed": time.time(), "sha256": digest(output)})
    atomic_json(job.directory / "status.json", {"status": "completed", "updated": time.time()})


def launch(directory, background):
    job = Job(directory)
    job.validate_environment()
    directory = job.directory
    # Detect duplicate launch before removing a requested pause.
    with job_lock(directory / "worker.lock"):
        with job_lock(directory / "stage.lock"):
            (directory / "pause").unlink(missing_ok=True)
    if not background:
        return run(directory)
    kwargs = {"start_new_session": True} if os.name != "nt" else {
        "creationflags": subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW}
    with (directory / "worker.log").open("ab", buffering=0) as log:
        proc = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "_run", str(directory)],
                                cwd=ROOT, stdin=subprocess.DEVNULL, stdout=log, stderr=log, **kwargs)
    print(f"Started background worker {proc.pid}. Progress: {directory / 'status.json'}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    create = sub.add_parser("create", help="Download/resolve weights and create a job; does not compute caches")
    create.add_argument("--model", default=DEFAULT_MODEL)
    create.add_argument("--revision", default="main")
    create.add_argument("--stages", nargs="+", choices=STAGES, default=list(STAGES))
    create.add_argument("--batch", type=int, default=16)
    create.add_argument("--tokens", type=int, default=10000)
    create.add_argument("--job", type=Path, required=True)
    for name in ("start", "resume", "pause", "status", "_run", "_stage"):
        p = sub.add_parser(name)
        p.add_argument("job", type=Path)
        if name in ("start", "resume"):
            p.add_argument("--background", action="store_true")
        if name == "_stage":
            p.add_argument("--stage", choices=STAGES, required=True)
    a = parser.parse_args()
    if a.command != "create" and not (a.job / "job.json").is_file():
        parser.error("Job does not exist; create it before starting or controlling it.")
    if a.command == "create":
        if a.batch <= 0 or a.tokens < 2:
            parser.error("--batch must be positive and --tokens must be at least 2")
        if a.job.exists():
            parser.error("Job directory already exists; use resume, or choose another directory.")
        root = snapshot(a.model, a.revision)
        cfg = json.loads((root / "config.json").read_text())
        validate_config(cfg)
        revision = root.name  # snapshot_download resolves mutable branch names to commit hashes
        cache = data_paths(a.model, revision)["cache"]
        a.job.mkdir(parents=True)
        manifest = {"version": VERSION, "model": a.model, "revision": revision, "snapshot": str(root),
                    "config": cfg, "cache": str(cache), "stages": list(dict.fromkeys(a.stages)),
                    "batch": a.batch, "tokens": a.tokens,
                    "packages": {name: importlib.metadata.version(name) for name in
                                 ("torch", "transformers", "numpy", "umap-learn", "datasets")}}
        atomic_json(a.job / "job.json", manifest)
        Job(a.job)
        atomic_json(a.job / "status.json", {"status": "created"})
        print(f"Created {a.job.resolve()}. Server: EXPLORER_MODEL={a.model} EXPLORER_REVISION={revision}")
    elif a.command in ("start", "resume"):
        launch(a.job, a.background)
    elif a.command == "pause":
        atomic_json(a.job / "pause", {"requested": time.time()})
        print("Pause requested. Worker exits after its current checkpoint; wait for status=paused before resuming.")
    elif a.command == "status":
        state = json.loads((a.job / "status.json").read_text())
        try:
            with job_lock(a.job / "worker.lock"):
                with job_lock(a.job / "stage.lock"):
                    if state.get("status") == "running":
                        state["status"] = "interrupted"
        except RuntimeError:
            pass
        print(json.dumps(state, indent=2))
    elif a.command == "_run":
        run(a.job)
    else:
        job = Job(a.job)
        job.validate_environment()
        os.environ.update(EXPLORER_MODEL=job.manifest["model"], EXPLORER_REVISION=job.manifest["revision"])
        try:
            # The child owns these locks too: killing its supervisor cannot permit a second writer/model.
            with job_lock(job.directory / "stage.lock"), job_lock(job.cache / ".builder.lock"), job_lock(ROOT / "explorer/cache/.device.lock"):
                os.environ["EXPLORER_CACHE_WORKER"] = "1"
                from cache_builders import build
                build(job, a.stage)
        except Paused:
            sys.exit(2)


if __name__ == "__main__":
    main()
