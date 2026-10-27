"""Shared HTTP-test fixtures; loading the server never loads model weights or calls a provider."""
import importlib.util
from pathlib import Path
import sys
import threading
import types
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'explorer'))


class JsonRequest:
    def __init__(self, body=None, **fields):
        self.body = fields if body is None else body

    async def json(self):
        return self.body


def load_server():
    # Keep native NumPy modules outside patch.dict's temporary module registry.
    # Unloading/reimporting its extension is unsupported in one test process.
    __import__('numpy')
    class Runtime:
        def __init__(self, *a): self.status, self.lock, self.heads = 'no model', threading.RLock(), None
        def vocab_strings(self): return []

    cfg = types.SimpleNamespace(num_hidden_layers=32, hidden_size=2560, intermediate_size=9216,
                                layer_types=['linear_attention'] * 32, num_attention_heads=16,
                                num_key_value_heads=4, linear_num_key_heads=16, linear_num_value_heads=32)
    transformers = types.ModuleType('transformers')
    transformers.AutoConfig = types.SimpleNamespace(from_pretrained=lambda *a, **kw: types.SimpleNamespace(
        get_text_config=lambda: cfg, to_dict=lambda: {"text_config": {"model_type": "qwen3_5_text", **vars(cfg)}}))
    runtime = types.ModuleType('runtime')
    runtime.NO_MODEL, runtime.Runtime, runtime.CACHE = True, Runtime, str(ROOT / 'explorer' / 'cache')
    spec = importlib.util.spec_from_file_location('agent_test_server', ROOT / 'explorer' / 'server.py')
    module = importlib.util.module_from_spec(spec)
    with patch.dict(sys.modules, {'transformers': transformers, 'runtime': runtime}):
        spec.loader.exec_module(module)
    return module
