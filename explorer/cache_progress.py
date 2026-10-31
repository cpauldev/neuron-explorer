"""Local desktop control for an existing resumable cache job."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import tkinter as tk
from tkinter import messagebox, ttk

from cache_job import launch, read_status, request_pause
from cache_storage import job_lock

STAGE_NAMES = {
    "layout_writes": "Writes layout", "layout_reads": "Reads layout",
    "connections": "Connections", "lens": "Logit lens",
    "steer": "Steering effects", "activations": "Activation ranges",
}


class ProgressWindow:
    def __init__(self, root, directory):
        self.root, self.directory = root, directory
        self.manifest = json.loads((directory / "job.json").read_text())
        self.starting_until = 0
        title = f"{self.manifest['model'].rsplit('/', 1)[-1]} cache builder"
        root.title(title)
        root.geometry("760x480")
        root.minsize(580, 360)
        frame = ttk.Frame(root, padding=18)
        frame.pack(fill="both", expand=True)
        ttk.Label(frame, text=title, font=("Segoe UI", 15, "bold")).pack(anchor="w")
        ttk.Label(frame, text="Local CPU / GPU • saved checkpoints are reused").pack(anchor="w", pady=(4, 16))
        self.status = ttk.Label(frame, text="Reading job…", font=("Segoe UI", 11))
        self.status.pack(anchor="w")
        self.progress = ttk.Progressbar(frame, maximum=100)
        self.progress.pack(fill="x", pady=10)
        self.detail = ttk.Label(frame, text="")
        self.detail.pack(anchor="w")
        controls = ttk.Frame(frame)
        controls.pack(fill="x", pady=14)
        self.resume_button = ttk.Button(controls, text="Resume", command=self.resume)
        self.resume_button.pack(side="left")
        self.pause_button = ttk.Button(controls, text="Pause", command=self.pause)
        self.pause_button.pack(side="left", padx=8)
        ttk.Button(controls, text="Open log", command=self.open_log).pack(side="right")
        ttk.Label(frame, text="Closing this window requests a pause. The current checkpoint finishes first.",
                  wraplength=700).pack(anchor="w", pady=(0, 10))
        log_frame = ttk.Frame(frame)
        log_frame.pack(fill="both", expand=True)
        self.log = tk.Text(log_frame, height=10, wrap="word", state="disabled", font=("Consolas", 9))
        scrollbar = ttk.Scrollbar(log_frame, command=self.log.yview)
        self.log.configure(yscrollcommand=scrollbar.set)
        scrollbar.pack(side="right", fill="y")
        self.log.pack(side="left", fill="both", expand=True)
        root.protocol("WM_DELETE_WINDOW", self.close)
        self.refresh()

    def resume(self):
        try:
            state, running = read_status(self.directory)
            if running:
                if (self.directory / "pause").exists():
                    messagebox.showinfo("Pause pending", "Wait for the current checkpoint to finish, then click Resume.")
                return
            if state.get("status") == "completed":
                return
            launch(self.directory, background=True)
            self.starting_until = time.monotonic() + 5
        except Exception as error:
            messagebox.showerror("Cannot resume cache build", str(error))

    def pause(self):
        try:
            request_pause(self.directory)
        except OSError as error:
            messagebox.showerror("Cannot request pause", str(error))
            return False
        return True

    def close(self):
        try:
            state, _ = read_status(self.directory)
            if state.get("status") != "completed" and not self.pause():
                return
        except Exception as error:
            messagebox.showerror("Cannot request pause", str(error))
            return
        self.root.destroy()

    def open_log(self):
        try:
            path = (self.directory / "worker.log").resolve()
            path.touch(exist_ok=True)
            if os.name == "nt":
                os.startfile(path)
            else:
                subprocess.Popen(["open" if sys.platform == "darwin" else "xdg-open", str(path)])
        except OSError as error:
            messagebox.showerror("Cannot open log", str(error))

    def refresh(self):
        try:
            state, running = read_status(self.directory)
            starting = time.monotonic() < self.starting_until
            pause_pending = running and (self.directory / "pause").exists()
            stages = self.manifest["stages"]
            stage = state.get("stage")
            name = STAGE_NAMES.get(stage, stage or "")
            if stage in stages:
                name += f" · stage {stages.index(stage) + 1} of {len(stages)}"
            status = state.get("status", "unknown")
            if pause_pending:
                label = "Pausing after current checkpoint"
            elif running:
                label = name or "Starting worker"
            elif starting:
                label = "Starting worker"
            else:
                label = {"created": "Ready to build", "paused": "Paused", "completed": "Completed",
                         "failed": "Failed", "interrupted": "Interrupted — ready to resume"}.get(status, status)
            self.status.configure(text=label)
            done, total = state.get("completed_units", 0), state.get("total_units", 0)
            known = total > 0 and (running or starting) and state.get("phase") != "loading"
            self.progress.stop()
            self.progress.configure(mode="determinate" if known or status == "completed" else "indeterminate")
            if known:
                self.progress["value"] = 100 * done / total
            elif status == "completed":
                self.progress["value"] = 100
            elif running or starting:
                self.progress.start(20)
            else:
                self.progress["value"] = 0
            detail = f"{done:,} / {total:,} checkpoints in this stage" if known else ""
            if known and "eta_seconds" in state:
                seconds = int(state["eta_seconds"])
                detail += f" · stage ETA {seconds // 3600}h {(seconds % 3600) // 60}m"
            elif running and not known:
                detail = "Loading or computing first checkpoint; progress updates after it finishes."
            elif not running:
                detail = state.get("error", "Completed checkpoints are kept for the next session.")
            self.detail.configure(text=detail, wraplength=700)
            self.resume_button.configure(state="disabled" if running or starting or status == "completed" else "normal")
            self.pause_button.configure(state="normal" if running and not pause_pending else "disabled")
            log_path = self.directory / "worker.log"
            if log_path.exists():
                with log_path.open("rb") as stream:
                    stream.seek(max(0, log_path.stat().st_size - 12000))
                    tail = stream.read().decode("utf-8", errors="replace")
                self.log.configure(state="normal")
                self.log.delete("1.0", "end")
                self.log.insert("1.0", tail)
                self.log.see("end")
                self.log.configure(state="disabled")
        except Exception as error:
            self.status.configure(text=f"Cannot read progress: {error}")
        self.root.after(1000, self.refresh)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--job", type=Path, required=True)
    args = parser.parse_args()
    args.job = args.job.resolve()
    if not (args.job / "job.json").is_file():
        parser.error("Job does not exist; create it with cache_job.py first.")
    root = tk.Tk()
    try:
        with job_lock(args.job / "desktop.lock"):
            window = ProgressWindow(root, args.job)
            root.after(100, window.resume)
            root.mainloop()
    except Exception as error:
        messagebox.showerror("Cache builder", str(error))
        root.destroy()


if __name__ == "__main__":
    main()
