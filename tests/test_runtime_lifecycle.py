"""Model switching must release retained tensors before reclaiming device memory."""
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import weakref

import torch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'explorer'))
from runtime import Runtime


class RuntimeLifecycleTests(unittest.TestCase):
    def test_unload_releases_attention_bases_before_emptying_device_cache(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime = Runtime(directory, cache_dir=directory)
            runtime._hb = (torch.empty(2, 2), torch.empty(2, 2), [])
            runtime._qkb = {'q': (torch.empty(2, 2), [])}
            retained = [weakref.ref(runtime._hb[0]), weakref.ref(runtime._qkb['q'][0])]

            def check_released():
                self.assertTrue(all(reference() is None for reference in retained))

            try:
                with patch('runtime.torch.cuda.is_available', return_value=True), \
                     patch('runtime.torch.cuda.empty_cache', side_effect=check_released) as empty, \
                     patch('runtime.torch.backends.mps.is_available', return_value=False):
                    runtime.unload()
                    empty.assert_called_once()
                self.assertEqual(runtime.status, 'idle')
            finally:
                runtime.close()
