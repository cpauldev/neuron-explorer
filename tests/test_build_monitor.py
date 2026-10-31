import base64
import json
from pathlib import Path
import sys
import tempfile
import unittest

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "explorer"))
from build_monitor import BuildMonitor
from cache_storage import atomic_json, atomic_npz, job_lock


class BuildMonitorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.job = self.root / "job"
        self.job.mkdir()
        config = dict(model_type="qwen3_5_text", num_hidden_layers=2, intermediate_size=4,
                      hidden_size=2, layer_types=["linear_attention"] * 2, num_attention_heads=1,
                      num_key_value_heads=1, linear_num_key_heads=1, linear_num_value_heads=1)
        atomic_json(self.job / "job.json", {"model": "test/model", "config": config, "batch": 2,
                                            "cache": str(self.root / "cache"),
                                            "stages": ["layout_writes", "steer", "connections"]})
        atomic_json(self.job / "status.json", {"status": "running", "stage": "layout_writes"})
        self.monitor = BuildMonitor(self.root)

    def test_layout_replays_completed_rows_and_keeps_pending_rows_in_index_order(self):
        atomic_npz(self.job / "parts/layout_writes/0.npz", cell=np.array([3, 2, 1, 0], np.int16))
        data = self.monitor.layout("job", "writes")
        cells = np.frombuffer(base64.b64decode(data["cell"]), dtype="<i2").reshape(2, 4)
        np.testing.assert_array_equal(cells, [[3, 2, 1, 0], [0, 1, 2, 3]])

    def test_active_checkpoint_and_interrupted_worker_are_distinguished(self):
        atomic_npz(self.job / "parts/layout_writes/0.npz", cell=np.arange(4))
        with job_lock(self.job / "stage.lock"):
            state = self.monitor.snapshot("job")
        self.assertTrue(state["running"])
        self.assertEqual(state["active"], {"layer": 1, "start": 0, "end": 4})
        self.assertEqual(self.monitor.snapshot("job")["state"]["status"], "interrupted")
        self.assertEqual(json.loads((self.job / "status.json").read_text())["status"], "running")

    def test_partial_neuron_batches_are_counted_without_loading_arrays(self):
        atomic_npz(self.job / "parts/steer/0-0.npz", unused=[1])
        atomic_npz(self.job / "parts/steer/0-2.npz", unused=[1])
        atomic_npz(self.job / "parts/steer/1-0.npz", unused=[1])
        state = self.monitor.snapshot("job")
        self.assertEqual(state["stages"][1]["neurons"], [4, 2])
        atomic_json(self.job / "steer.done.json", {"sha256": "example"})
        self.assertEqual(self.monitor.snapshot("job")["stages"][1]["neurons"], [4, 4])

    def test_connections_are_sampled_from_saved_arrays(self):
        shape = (2, 4, 1)
        atomic_npz(self.job / "parts/connections/running.npz", down_layer=np.ones(shape, np.int16),
                   down_n=np.full(shape, 2, np.int16), down_z=np.ones(shape), down_sign=-np.ones(shape), next_layer=2)
        data = self.monitor.edges("job")
        self.assertEqual(data["edges"][:6], [0, 0, 1, 2, -10, 0])
        self.assertTrue(data["version"])
        self.assertEqual(self.monitor.snapshot("job")["stages"][2]["neurons"], [4, 4])

    def test_published_layout_remains_available_without_per_layer_parts(self):
        atomic_npz(self.root / "cache/layout_writes.npz", cell=np.array([[3, 2, 1, 0], [1, 0, 3, 2]], np.int16))
        data = self.monitor.layout("job", "writes")
        np.testing.assert_array_equal(np.frombuffer(base64.b64decode(data["cell"]), dtype="<i2"), [3, 2, 1, 0, 1, 0, 3, 2])

    def test_paths_and_layout_arguments_are_validated(self):
        for name in ("..", "../job", "job/job", "missing"):
            with self.assertRaises(ValueError):
                self.monitor.snapshot(name)
        with self.assertRaises(ValueError):
            self.monitor.layout("job", "invalid")
        self.assertEqual(self.monitor.jobs(), [{"id": "job", "model": "test/model"}])


if __name__ == "__main__":
    unittest.main()
