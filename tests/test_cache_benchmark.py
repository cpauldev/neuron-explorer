"""Benchmark selection, projections and unattended orchestration; no real GPU or downloads."""
import contextlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'explorer'))
from benchmark_cache import (SampleComplete, SampleJob, Stopped, chunk_starts, evenly_spaced,
                             layer_groups, project, supervise)
from cache_job import STAGES
from cache_storage import atomic_json


class BenchmarkTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.manifest = {'model': 'test/model', 'revision': 'pin', 'snapshot': str(self.root),
                         'batch': 16, 'packages': {}, 'config': {'model_type': 'qwen3_5_text',
                         'num_hidden_layers': 6, 'hidden_size': 8, 'intermediate_size': 32}}

    def test_selection_covers_positions_without_duplicates_or_overrun(self):
        self.assertEqual(evenly_spaced(range(32), 3), [0, 16, 31])
        self.assertEqual(evenly_spaced(range(2), 5), [0, 1])
        self.assertEqual(evenly_spaced([], 3), [])
        for neurons, batch in ((12288, 16), (9216, 16), (25, 4), (3, 16)):
            starts = chunk_starts(neurons, batch, 3)
            self.assertEqual(starts, sorted(set(starts)))
            self.assertEqual(starts[0], 0)
            self.assertEqual(starts[-1], ((neurons - 1) // batch) * batch)
            self.assertTrue(all(0 <= s < neurons and s % batch == 0 for s in starts))

    def test_compiled_groups_use_metadata_and_validate_the_boundary(self):
        self.assertEqual(layer_groups(self.manifest), [{'name': 'learned', 'first': 0, 'last': 6}])
        atomic_json(self.root / 'chipformer.json', {'qwen_layers_from': 2})
        self.assertEqual([g['last'] - g['first'] for g in layer_groups(self.manifest)], [2, 4])
        for invalid in (-1, 6, True):
            atomic_json(self.root / 'chipformer.json', {'qwen_layers_from': invalid})
            with self.assertRaises(ValueError):
                layer_groups(self.manifest)

    def test_projection_weights_strata_and_adds_setup_only_once(self):
        groups = [{'name': 'compiled', 'first': 0, 'last': 2}, {'name': 'learned', 'first': 2, 'last': 6}]
        samples = [{'layer': l, 'seconds': s} for l, s in ((0, 1), (1, 3), (2, 10), (5, 14))]
        self.assertEqual(project(self.manifest, groups, 'layout_reads', samples, 5, 3)['estimated_seconds'], 59)
        self.assertEqual(project(self.manifest, groups, 'steer', samples, 5, 3)['estimated_seconds'], 111)
        connections = [{'layer': l, 'seconds': 2 * l + 3} for l in (1, 2, 5)]
        self.assertEqual(project(self.manifest, groups, 'connections', connections, 5, 7)['estimated_seconds'], 52)
        with self.assertRaisesRegex(ValueError, 'Missing learned'):
            project(self.manifest, groups, 'lens', samples[:2], 0, 0)

    def test_sample_boundary_and_stop_cannot_reach_full_export(self):
        job = SampleJob(self.root, self.root / 'sample', self.manifest, 'steer', 1)
        job.boundary()
        job.part('steer', '2-16')
        with patch('torch.cuda.is_available', return_value=False), contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(SampleComplete):
                job.progress('steer', 1, 100)
        self.assertEqual(job.samples[0]['layer'], 2)
        atomic_json(self.root / 'stop', {})
        with self.assertRaises(Stopped):
            job.boundary()
        with self.assertRaisesRegex(ValueError, 'Nonfinite'):
            job.save(self.root / 'invalid.npz', value=float('nan'))
        self.assertFalse((self.root / 'invalid.npz').exists())

    def test_supervisor_runs_every_stage_alternates_order_and_resumes(self):
        parameters = {'models': {'first': self.manifest, 'second': self.manifest}, 'timeout': 3600}
        atomic_json(self.root / 'corpus.json', {})
        calls = []

        def execute(out, arguments, log, environment, timeout):
            _, _, name, stage = arguments
            calls.append((name, stage))
            atomic_json(out / name / stage / 'result.json', {
                'status': 'completed', 'estimated_seconds': 10, 'wall_seconds': 3,
                'process_overhead_seconds': 2, 'peak_allocated_gib': 1,
                'chat': [{'dose': 0, 'seconds': 1, 'tokens': [5, 5, 5]}]})
            return 5

        with patch('benchmark_cache.ROOT', self.root), patch('benchmark_cache.child', side_effect=execute) as child:
            supervise(self.root, parameters)
            self.assertEqual(len(calls), 12)
            for index, stage in enumerate(STAGES):
                expected = ['first', 'second'] if index % 2 == 0 else ['second', 'first']
                self.assertEqual(calls[index * 2:index * 2 + 2], [(n, stage) for n in expected])
            self.assertEqual(json.loads((self.root / 'status.json').read_text())['status'], 'completed')
            child.reset_mock()
            supervise(self.root, parameters)
            child.assert_not_called()
        summary = json.loads((self.root / 'summary.json').read_text())
        self.assertEqual(summary['estimated_hours'], {'first': 60 / 3600, 'second': 60 / 3600})
        self.assertTrue((self.root / 'report.md').exists())


if __name__ == '__main__':
    unittest.main()
