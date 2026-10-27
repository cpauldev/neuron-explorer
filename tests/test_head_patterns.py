"""Check attention reconstruction without model weights or a GPU."""
from pathlib import Path
import sys
import threading
import types
import unittest

import numpy as np
import torch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'explorer'))
from runtime import Runtime


class PatternTests(unittest.TestCase):
    def setUp(self):
        self.runtime = Runtime.__new__(Runtime)
        self.runtime.lock = threading.RLock()
        self.rng = torch.Generator().manual_seed(17)

    def random(self, *shape):
        return torch.randn(*shape, generator=self.rng)

    def test_large_backbone_bases_use_cpu_without_changing_roles(self):
        rt = self.runtime
        attention = types.SimpleNamespace(head_dim=2, q_proj=torch.nn.Linear(8, 8, bias=False),
                                         k_proj=torch.nn.Linear(8, 2, bias=False),
                                         v_proj=torch.nn.Linear(8, 2, bias=False),
                                         o_proj=torch.nn.Linear(4, 8, bias=False))
        layer = types.SimpleNamespace(self_attn=attention, input_layernorm=torch.nn.LayerNorm(8),
                                      post_attention_layernorm=torch.nn.LayerNorm(8),
                                      mlp=types.SimpleNamespace(down_proj=torch.nn.Linear(25, 8, bias=False),
                                                               gate_proj=torch.nn.Linear(8, 25, bias=False),
                                                               up_proj=torch.nn.Linear(8, 25, bias=False)))
        rt.model, rt.dev = object(), 'cuda'  # No CUDA device may be touched in this test.
        rt.lm = types.SimpleNamespace(config=types.SimpleNamespace(hidden_size=4096), layers=[layer, layer])
        roles = rt.neuron_head_roles(0, 0)
        self.assertEqual(rt._hb[0].device.type, 'cpu')
        self.assertTrue(all(b.device.type == 'cpu' for b, _ in rt._qkb.values()))
        rt._hb = rt._qkb = None
        rt.dev, rt.lm.config.hidden_size = 'cpu', 8
        self.assertEqual(rt.neuron_head_roles(0, 0), roles)

    def check_rows(self, head_count):
        all_patterns = self.runtime.layer_patterns(0)
        for head in range(head_count):
            pattern = self.runtime.head_pattern(0, head)
            np.testing.assert_allclose(pattern, all_patterns[head], atol=1e-6)
            np.testing.assert_allclose(np.triu(pattern, 1), 0, atol=1e-7)
            np.testing.assert_allclose(np.abs(pattern).sum(-1), 1, atol=1e-6)
            for pos in range(len(pattern)):
                np.testing.assert_allclose(self.runtime.head_row(0, head, pos), pattern[pos, :pos+1], atol=1e-6)

    def test_full_attention_grouped_keys_and_causal_rows(self):
        self.runtime.heads = {'q': {0: {'kind': 'full', 'q': self.random(4, 6, 3),
                                      'k': self.random(2, 6, 3), 'scale': 3**-.5}}}
        self.check_rows(4)
        self.assertTrue((self.runtime.head_pattern(0, 0) >= 0).all())

    def test_linear_rows_reconstruct_delta_rule_state(self):
        q = torch.nn.functional.normalize(self.random(2, 6, 3), dim=-1)
        k = torch.nn.functional.normalize(self.random(2, 6, 3), dim=-1)
        beta = torch.rand(4, 6, generator=self.rng)
        logd = -torch.rand(4, 6, generator=self.rng)
        self.runtime.heads = {'q': {0: {'kind': 'linear', 'q': q, 'k': k, 'rep': 2,
                                      'beta': beta, 'logd': logd}}}
        self.check_rows(4)
        values = self.random(4, 6, 2)
        for head in range(4):
            state = torch.zeros(3, 2)
            for pos in range(6):
                key = k[head//2, pos]
                state *= logd[head, pos].exp()
                state += beta[head, pos] * key[:, None] * (values[head, pos] - key @ state)[None]
                expected = q[head//2, pos] @ state
                reconstructed = self.runtime.raw_row(0, head, pos) @ values[head, :pos+1]
                torch.testing.assert_close(reconstructed, expected, atol=1e-6, rtol=1e-5)
