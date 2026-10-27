"""Model identity and data paths shared by the server and offline cache workers."""
import hashlib
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MODEL = "Qwen/Qwen3.5-4B"
MODEL = os.environ.get("EXPLORER_MODEL", DEFAULT_MODEL)
REVISION = os.environ.get("EXPLORER_REVISION") or None


def model_key(model, revision=None):
    identity = json.dumps([model, revision], separators=(",", ":"))
    label = "".join(c if c.isalnum() or c in "-_." else "-" for c in model)[-70:]
    return f"{label}-{hashlib.sha256(identity.encode()).hexdigest()[:12]}"


def data_paths(model=MODEL, revision=REVISION):
    """Keep shipped 4B paths; every other model/revision gets an isolated workspace."""
    legacy = model == DEFAULT_MODEL and revision is None
    base = ROOT if legacy else ROOT / "explorer" / "cache" / "models" / model_key(model, revision)
    return {
        "cache": ROOT / "explorer" / "cache" if legacy else base,
        "runs": base / "runs", "stats": base / "stats",
        "names": ROOT / "explorer" / "names.json" if legacy else base / "names.json",
    }


def validate_config(config):
    """Attention reconstruction and intervention hooks require this exact model family."""
    text = config.get("text_config", config)
    if text.get("model_type") != "qwen3_5_text":
        raise ValueError("Supported architecture: Qwen3.5 dense text backbone (qwen3_5_text), not MoE or GGUF.")
    for key in ("num_hidden_layers", "hidden_size", "intermediate_size"):
        if not isinstance(text.get(key), int) or text[key] <= 0:
            raise ValueError(f"Invalid model dimension: {key}")
    # Current binary browser protocols use signed int16 neuron and grid indices.
    import math
    if text["num_hidden_layers"] > 127 or math.ceil(math.sqrt(text["intermediate_size"])) ** 2 > 32768:
        raise ValueError("Model exceeds the explorer's layer/neuron index limits.")
    return text


def snapshot(model, revision=None):
    from huggingface_hub import hf_hub_download, snapshot_download
    path = Path(model)
    if path.is_dir():
        raise ValueError("Use a Hugging Face repository ID and revision; mutable local folders are not cache identities.")
    config = Path(hf_hub_download(model, "config.json", revision=revision))
    validate_config(json.loads(config.read_text()))
    return Path(snapshot_download(model, revision=config.parent.name,
                                  allow_patterns=["*.safetensors", "*.json", "*.jinja", "*.txt", "*.model"]))


class Weights:
    """Read sharded and single-file Safetensors without loading a full model."""
    def __init__(self, root):
        self.root = Path(root)
        index = self.root / "model.safetensors.index.json"
        if index.exists():
            self.index = json.loads(index.read_text())["weight_map"]
        else:
            from safetensors import safe_open
            with safe_open(self.root / "model.safetensors", framework="pt") as f:
                self.index = dict.fromkeys(f.keys(), "model.safetensors")

    def tensor(self, name):
        from safetensors import safe_open
        with safe_open(self.root / self.index[name], framework="pt") as f:
            return f.get_tensor(name)
