"""Read-only snapshots of resumable jobs; never loads model weights or imports builders."""
import base64
import json
from pathlib import Path
import re

import numpy as np

from cache_job import read_status
from model_config import validate_config


class BuildMonitor:
    def __init__(self, root):
        self.root = Path(root).resolve()

    def directory(self, name):
        if not re.fullmatch(r"[\w-]+", name):
            raise ValueError("Invalid build ID")
        path = (self.root / name).resolve()
        if path.parent != self.root or not (path / "job.json").is_file():
            raise ValueError("Build not found")
        return path

    def manifest(self, name):
        return json.loads((self.directory(name) / "job.json").read_text())

    def jobs(self):
        result = []
        for path in sorted(self.root.glob("*/job.json")):
            try:
                manifest = self.manifest(path.parent.name)
                result.append({"id": path.parent.name, "model": manifest["model"]})
            except (OSError, ValueError, KeyError):
                continue
        return result

    def snapshot(self, name):
        directory = self.directory(name)
        manifest = self.manifest(name)
        config = validate_config(manifest["config"])
        layers, neurons = config["num_hidden_layers"], config["intermediate_size"]
        state, running = read_status(directory)
        stages = []
        for stage in manifest["stages"]:
            counts = [0] * layers
            parts = directory / "parts" / stage
            version = 0
            marker = directory / f"{stage}.done.json"
            complete = marker.is_file()
            for path in (() if complete else parts.glob("*.npz")):
                match = re.fullmatch(r"(\d+)(?:-(\d+))?\.npz", path.name)
                if not match:
                    continue
                layer = int(match[1])
                if layer >= layers:
                    continue
                if stage.startswith("layout_"):
                    version = max(version, path.stat().st_mtime_ns)
                    counts[layer] = neurons
                elif stage in ("steer", "lens") and match[2] is not None:
                    width = manifest["batch"] if stage == "steer" else 1024
                    counts[layer] += min(width, neurons - int(match[2]))
            if complete:
                counts = [neurons] * layers
                version = marker.stat().st_mtime_ns
            elif stage == "connections":
                checkpoint = directory / "parts/connections/running.npz"
                if checkpoint.is_file():
                    with np.load(checkpoint, allow_pickle=False) as arrays:
                        next_layer = int(arrays["next_layer"])
                    counts = [neurons if layer < next_layer else 0 for layer in range(layers)]
            stages.append({"id": stage, "complete": complete, "neurons": counts, "version": str(version)})
        active = None
        stage = state.get("stage")
        saved = next((s for s in stages if s["id"] == stage), None)
        if running and saved and not saved["complete"]:
            if stage.startswith("layout_") or stage in ("steer", "lens"):
                layer = next((i for i, count in enumerate(saved["neurons"]) if count < neurons), None)
                if layer is not None:
                    start = saved["neurons"][layer]
                    width = manifest["batch"] if stage == "steer" else 1024 if stage == "lens" else neurons
                    active = {"layer": layer, "start": start, "end": min(neurons, start + width)}
        edge_path = directory / "parts/connections/running.npz"
        if not edge_path.is_file():
            edge_path = Path(manifest["cache"]) / "connections.npz"
        return {"id": name, "model": manifest["model"], "revision": manifest.get("revision"), "state": state, "running": running,
                "edge_version": str(edge_path.stat().st_mtime_ns) if edge_path.is_file() else "",
                "pause_requested": (directory / "pause").exists(), "stages": stages, "active": active,
                "arch": {"n_layers": layers, "inter": neurons, "hidden": config["hidden_size"],
                         "layer_types": config["layer_types"], "attn_heads": config["num_attention_heads"],
                         "kv_heads": config["num_key_value_heads"], "linear_k_heads": config["linear_num_key_heads"],
                         "linear_v_heads": config["linear_num_value_heads"]}}

    def layout(self, name, kind):
        if kind not in ("writes", "reads"):
            raise ValueError("Layout kind must be writes or reads")
        manifest = self.manifest(name)
        config = validate_config(manifest["config"])
        layers, neurons = config["num_hidden_layers"], config["intermediate_size"]
        cells = np.tile(np.arange(neurons, dtype=np.int16), (layers, 1))
        final = Path(manifest["cache"]) / f"layout_{kind}.npz"
        if final.is_file():
            with np.load(final, allow_pickle=False) as arrays:
                cells[:] = arrays["cell"]
        for layer in range(layers):
            path = self.directory(name) / "parts" / f"layout_{kind}" / f"{layer}.npz"
            if path.is_file():
                with np.load(path, allow_pickle=False) as arrays:
                    cells[layer] = arrays["cell"]
        return {"cell": base64.b64encode(cells.astype("<i2").tobytes()).decode()}

    def edges(self, name):
        """A bounded sample of real saved edges, not a fabricated activity animation."""
        directory = self.directory(name)
        manifest = self.manifest(name)
        path = directory / "parts/connections/running.npz"
        if not path.is_file():
            path = Path(manifest["cache"]) / "connections.npz"
        if not path.is_file():
            return {"version": "", "edges": []}
        version = str(path.stat().st_mtime_ns)
        with np.load(path, allow_pickle=False) as arrays:
            layer, neuron, score, sign = (arrays[f"down_{key}"] for key in ("layer", "n", "z", "sign"))
            edges = []
            for source in range(len(layer)):
                for target, n, z, s in zip(layer[source, 0, :4], neuron[source, 0, :4],
                                            score[source, 0, :4], sign[source, 0, :4]):
                    if z > 0:
                        edges.extend((source, 0, int(target), int(n), min(32767, round(float(z) * 10)) * int(s), 0))
        return {"version": version, "edges": edges}
