"""Interruption/replay tests use tiny synthetic weights, never a model download or GPU."""
import contextlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import types
import unittest
from unittest.mock import patch

import numpy as np
import torch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "explorer"))
from cache_job import Job, Paused, VERSION, launch, main, run, run_stages
from cache_storage import atomic_json, atomic_write, job_lock
from cache_builders import activations, connections, grid_cells, layout, lens, steer, load_part
from model_config import DEFAULT_MODEL, ROOT, Weights, data_paths, validate_config


class CacheTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.cfg = dict(model_type="qwen3_5_text", num_hidden_layers=3, hidden_size=8, intermediate_size=25)
        self.seed = torch.Generator().manual_seed(41)
        self.weights = {}
        for l in range(3):
            prefix = f"model.language_model.layers.{l}."
            for name, shape in (("down", (8, 25)), ("gate", (25, 8)), ("up", (25, 8))):
                self.weights[prefix + f"mlp.{name}_proj.weight"] = torch.randn(*shape, generator=self.seed) * 0.1
            self.weights[prefix + "post_attention_layernorm.weight"] = torch.zeros(8)

    def job(self, name):
        directory = self.root / name
        directory.mkdir()
        atomic_json(directory / "job.json", {"version": VERSION, "cache": str(directory / "cache"),
                                            "model": "test/model", "revision": "test-revision",
                                            "batch": 4, "tokens": 1024, "stages": ["lens"]})
        return Job(directory)

    def fake_runtime(self):
        class Layer(torch.nn.Module):
            def __init__(self):
                super().__init__()
                self.mlp = torch.nn.Module()
                self.mlp.down_proj = torch.nn.Linear(25, 8, bias=False)

            def forward(self, x):
                return x + self.mlp.down_proj(x.repeat(1, 1, 4)[..., :25])

        class LM(torch.nn.Module):
            def __init__(self):
                super().__init__()
                self.layers = torch.nn.ModuleList([Layer() for _ in range(3)])
                self.norm = torch.nn.Identity()

            def forward(self, input_ids, **kwargs):
                x = torch.nn.functional.one_hot(input_ids % 8, 8).float()
                for layer in self.layers:
                    x = layer(x)
                return types.SimpleNamespace(last_hidden_state=x)

        torch.manual_seed(3)
        lm = LM()
        class Tokenizer:
            pad_token_id = 0
            def __call__(self, prompt): return types.SimpleNamespace(input_ids=[2, 3, 4])
        return types.SimpleNamespace(lm=lm, model=types.SimpleNamespace(lm_head=torch.nn.Linear(8, 32)),
                                     tok=Tokenizer(), chat_ids=lambda c: [1, 2], dev="cpu", vocab_strings=lambda: [])

    def resumed_equals_fresh(self, stage, builder, output):
        interrupted, fresh = self.job("interrupted"), self.job("fresh")
        original = interrupted.progress
        count = 0
        def pause_after_first(*args, **kwargs):
            nonlocal count
            original(*args, **kwargs)
            count += 1
            if count == 1:
                atomic_json(interrupted.directory / "pause", {})
        interrupted.progress = pause_after_first
        with contextlib.redirect_stdout(io.StringIO()), self.assertRaises(Paused):
            builder(interrupted)
        completed = {p: p.stat().st_mtime_ns for p in (interrupted.directory / "parts").rglob("*.npz")}
        self.assertTrue(completed)
        (interrupted.directory / "pause").unlink()
        interrupted.progress = original
        with contextlib.redirect_stdout(io.StringIO()):
            builder(interrupted)
            builder(fresh)
        # Existing checkpoint units are read, not recomputed (running aggregate is intentionally replaced).
        for path, modified in completed.items():
            if path.name != "running.npz":
                self.assertEqual(path.stat().st_mtime_ns, modified)
        a, b = load_part(interrupted.cache / output), load_part(fresh.cache / output)
        self.assertEqual(a.keys(), b.keys())
        for key in a:
            np.testing.assert_allclose(a[key], b[key], atol=1e-5, rtol=1e-5)

    def test_lens_resume(self):
        self.resumed_equals_fresh("lens", lambda j: lens(j, self.fake_runtime(), self.cfg), "lens_index.npz")

    def test_signed_steering_resume(self):
        self.resumed_equals_fresh("steer", lambda j: steer(j, self.fake_runtime(), self.cfg), "steer_index.npz")

    def test_worker_runtime_receives_pinned_identity_and_cache(self):
        from cache_builders import build
        job = self.job("job")
        snapshot = self.root / "snapshot"
        snapshot.mkdir()
        atomic_json(snapshot / "config.json", self.cfg)
        job.manifest.update(config=self.cfg, snapshot=str(snapshot))
        captured = {}
        def runtime(*args, **kwargs):
            captured.update(kwargs)
            return types.SimpleNamespace(ensure_loaded=lambda: None)
        with patch.dict(sys.modules, {"runtime": types.SimpleNamespace(Runtime=runtime)}), patch("cache_builders.lens"):
            build(job, "lens")
        self.assertEqual(captured, {"model": "test/model", "revision": "test-revision", "cache_dir": job.cache})

    def test_chat_respects_model_specific_stop_tokens(self):
        from runtime import Runtime
        rt = Runtime.__new__(Runtime)
        rt.lock, rt.dev = threading.RLock(), "cpu"
        rt.ensure_loaded = lambda: None
        rt.messages_ids = lambda messages: [1, 2]
        rt.tok = types.SimpleNamespace(pad_token_id=0, eos_token_id=4, unk_token_id=None,
                                       convert_tokens_to_ids=lambda text: 6)
        calls = []
        class Model:
            generation_config = types.SimpleNamespace(eos_token_id=[4, 5])
            def __call__(self, **kwargs):
                calls.append(1)
                logits = torch.zeros(3, 1, 8)
                logits[:, :, 5] = 1
                return types.SimpleNamespace(logits=logits, past_key_values=None)
        rt.model = Model()
        self.assertEqual(list(rt.steer_multi([], [[], [], []], max_new=3)), [(None, None)])
        self.assertEqual(len(calls), 1)

    def test_reads_layout_resume(self):
        weights = types.SimpleNamespace(tensor=lambda name: self.weights[name])
        umap = types.SimpleNamespace(UMAP=lambda **kwargs: types.SimpleNamespace(fit_transform=lambda z: z[:, :2]))
        with patch.dict(sys.modules, {"umap": umap}):
            self.resumed_equals_fresh("layout_reads", lambda j: layout(j, "layout_reads", self.cfg, weights), "layout_reads.npz")

    def test_connections_resume(self):
        weights = types.SimpleNamespace(tensor=lambda name: self.weights[name])
        with patch("torch.cuda.is_available", return_value=False), patch("torch.backends.mps.is_available", return_value=False):
            self.resumed_equals_fresh("connections", lambda j: connections(j, self.cfg, weights), "connections.npz")

    def test_layout_resume_and_padded_grid(self):
        weights = types.SimpleNamespace(tensor=lambda name: self.weights[name])
        umap = types.SimpleNamespace(UMAP=lambda **kwargs: types.SimpleNamespace(fit_transform=lambda z: z[:, :2]))
        with patch.dict(sys.modules, {"umap": umap}):
            self.resumed_equals_fresh("layout_writes", lambda j: layout(j, "layout_writes", self.cfg, weights), "layout_writes.npz")
        cells = grid_cells(np.random.default_rng(0).normal(size=(12288, 2)))
        np.testing.assert_array_equal(np.sort(cells), np.arange(12288))

    def test_activation_resume(self):
        def builder(job):
            source = job.part("activations", "tokens")
            if not source.exists(): job.save(source, ids=np.arange(1024, dtype=np.int32))
            def acts(ids, **kw):
                value = torch.arange(25).float() + ids[0]
                return {l: (value, None, -value, None) for l in range(3)}
            activations(job, types.SimpleNamespace(all_activations=acts), self.cfg)
        self.resumed_equals_fresh("activations", builder, "act_scale.npz")

    def test_atomic_failure_preserves_old_output(self):
        target = self.root / "output"
        target.write_bytes(b"good")
        def fail(f):
            f.write(b"partial")
            raise RuntimeError("simulated power loss before rename")
        with self.assertRaises(RuntimeError): atomic_write(target, fail)
        self.assertEqual(target.read_bytes(), b"good")
        self.assertEqual(list(self.root.glob("*.tmp-*")), [])

    def test_worker_lock_rejects_duplicate_and_releases(self):
        path = self.root / "lock"
        with job_lock(path):
            with self.assertRaises(RuntimeError):
                with job_lock(path): pass
        with job_lock(path): pass

    def test_paths_and_compatibility(self):
        self.assertEqual(data_paths(DEFAULT_MODEL, None)["cache"], ROOT / "explorer/cache")
        self.assertNotEqual(data_paths("Qwen/other", "a"), data_paths("Qwen/other", "b"))
        self.assertNotEqual(data_paths(DEFAULT_MODEL, "a"), data_paths(DEFAULT_MODEL, None))
        self.assertEqual(validate_config(self.cfg), self.cfg)
        for bad in ({**self.cfg, "model_type": "qwen3_moe"}, {**self.cfg, "intermediate_size": 100000}):
            with self.assertRaises(ValueError): validate_config(bad)

    def test_single_and_sharded_weights(self):
        from safetensors.torch import save_file
        save_file(self.weights, self.root / "model.safetensors")
        name = next(iter(self.weights))
        torch.testing.assert_close(Weights(self.root).tensor(name), self.weights[name])
        atomic_json(self.root / "model.safetensors.index.json", {"weight_map": {k: "model.safetensors" for k in self.weights}})
        torch.testing.assert_close(Weights(self.root).tensor(name), self.weights[name])

    def test_stage_marker_is_written_only_after_success(self):
        job = self.job("job")
        with patch("cache_job.subprocess.run", side_effect=RuntimeError("failed")):
            with self.assertRaises(RuntimeError): run_stages(job)
        self.assertFalse((job.directory / "lens.done.json").exists())

    def test_changed_settings_are_rejected(self):
        job = self.job("job")
        manifest = job.manifest.copy()
        manifest["batch"] = 8
        atomic_json(job.directory / "job.json", manifest)
        with self.assertRaisesRegex(ValueError, "settings changed"):
            Job(job.directory)

    def test_launch_validates_before_spawning_or_clearing_pause(self):
        job = self.job("job")
        atomic_json(job.directory / "pause", {})
        with patch.object(Job, "validate_environment", side_effect=ValueError("package changed")), patch("cache_job.subprocess.Popen") as spawn:
            with self.assertRaisesRegex(ValueError, "package changed"):
                launch(job.directory, True)
        spawn.assert_not_called()
        self.assertTrue((job.directory / "pause").exists())
        missing = self.root / "missing"
        with self.assertRaises(FileNotFoundError):
            launch(missing, True)
        self.assertFalse(missing.exists())

    def test_pause_and_status_do_not_require_original_packages(self):
        job = self.job("job")
        atomic_json(job.directory / "status.json", {"status": "created"})
        with patch.object(Job, "validate_environment", side_effect=ValueError("package changed")), contextlib.redirect_stdout(io.StringIO()):
            for command in ("pause", "status"):
                with patch.object(sys, "argv", ["cache_job.py", command, str(job.directory)]):
                    main()
        self.assertTrue((job.directory / "pause").exists())

    def test_pending_pause_does_not_hide_worker_failure(self):
        job = self.job("job")
        atomic_json(job.directory / "pause", {})
        with patch("cache_job.run_stages", side_effect=RuntimeError("disk full")):
            with self.assertRaisesRegex(RuntimeError, "disk full"):
                run(job.directory)
        state = json.loads((job.directory / "status.json").read_text())
        self.assertEqual(state["status"], "failed")
        self.assertIn("disk full", state["error"])

    def test_cooperative_child_pause_is_reported_as_paused(self):
        job = self.job("job")
        def child(*args, **kwargs):
            atomic_json(job.directory / "pause", {})
            raise subprocess.CalledProcessError(2, ["cache-worker"])
        with patch("cache_job.subprocess.run", side_effect=child):
            run(job.directory)
        state = json.loads((job.directory / "status.json").read_text())
        self.assertEqual(state["status"], "paused")
        self.assertNotIn("error", state)

    def test_finished_stage_output_is_verified_on_resume(self):
        job = self.job("job")
        calls = []
        def build(*args, **kwargs):
            self.assertEqual(kwargs["env"]["EXPLORER_MODEL"], "test/model")
            self.assertEqual(kwargs["env"]["EXPLORER_REVISION"], "test-revision")
            calls.append(1)
            job.save(job.cache / "lens_index.npz", up=np.ones(3))
        with patch("cache_job.subprocess.run", side_effect=build):
            run_stages(job)
            run_stages(job)
            self.assertEqual(len(calls), 1)
            (job.cache / "lens_index.npz").write_bytes(b"corrupt")
            run_stages(job)
            self.assertEqual(len(calls), 2)


if __name__ == "__main__":
    unittest.main()
