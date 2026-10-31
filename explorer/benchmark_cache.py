"""Compare all six cache stages with isolated, representative production-builder samples.

Run with --help. Results are timing projections, never publishable model caches.
Each phase runs in a fresh process and owns the normal compute lock until it exits.
"""
import time
PROCESS_STARTED = time.perf_counter()

import argparse
import asyncio
import hashlib
import json
import math
import os
from pathlib import Path
import statistics
import subprocess
import sys
import traceback
import uuid

from cache_job import ROOT, STAGES, Job
from cache_storage import atomic_json, atomic_npz, digest, job_lock
from agent_common import process_options, stop_process
from model_config import validate_config


class SampleComplete(Exception):
    pass


class Stopped(Exception):
    pass


def evenly_spaced(values, count):
    values = list(values)
    count = min(count, len(values))
    if not count:
        return []
    if count == 1:
        return [values[len(values) // 2]]
    return [values[round(i * (len(values) - 1) / (count - 1))] for i in range(count)]


def chunk_starts(neurons, batch, per_position):
    chunks = math.ceil(neurons / batch)
    width = min(per_position, chunks)
    starts = set()
    for centre in evenly_spaced(range(chunks), 3):
        first = max(0, min(centre - width // 2, chunks - width))
        starts.update(i * batch for i in range(first, first + width))
    return sorted(starts)


def layer_groups(manifest):
    layers = validate_config(manifest['config'])['num_hidden_layers']
    metadata = Path(manifest['snapshot']) / 'chipformer.json'
    split = json.loads(metadata.read_text()).get('qwen_layers_from') if metadata.exists() else None
    if split is None:
        return [{'name': 'learned', 'first': 0, 'last': layers}]
    if type(split) is not int or not 0 < split < layers:
        raise ValueError('Invalid compiled/learned layer boundary in chipformer.json')
    return [{'name': 'compiled', 'first': 0, 'last': split},
            {'name': 'learned', 'first': split, 'last': layers}]


def project(manifest, groups, stage, samples, setup_seconds, warmup_seconds):
    """Weight each stratum by its real number of layers, neurons or layer pairs."""
    cfg = validate_config(manifest['config'])
    estimates = []
    for group in groups:
        first = max(1, group['first']) if stage == 'connections' else group['first']
        layers = list(range(first, group['last']))
        selected = [s for s in samples if s['layer'] in layers]
        if not selected:
            raise ValueError(f'Missing {group["name"]} samples for {stage}')
        per_layer = {}
        for layer in sorted({s['layer'] for s in selected}):
            per_layer[layer] = statistics.median(s['seconds'] for s in selected if s['layer'] == layer)
        if stage == 'connections':
            # A target group executes every earlier source layer, plus one checkpoint.
            # Fit pair cost + fixed group cost; do not extrapolate the first loading interval.
            xs, ys = list(per_layer), list(per_layer.values())
            if len(xs) > 1:
                xm, ym = statistics.mean(xs), statistics.mean(ys)
                slope = max(0, sum((x - xm) * (y - ym) for x, y in zip(xs, ys)) /
                            sum((x - xm) ** 2 for x in xs))
                intercept = max(0, ym - slope * xm)
            else:
                slope, intercept = ys[0] / xs[0], 0
            seconds = slope * sum(layers) + intercept * len(layers)
        else:
            units = 1 if stage.startswith('layout_') else math.ceil(
                cfg['intermediate_size'] / (manifest['batch'] if stage == 'steer' else 1024))
            seconds = statistics.mean(per_layer.values()) * units * len(layers)
        estimates.append({'group': group['name'], 'layers': len(layers),
                          'sample_layers': sorted(per_layer), 'seconds': seconds,
                          'min_unit_seconds': min(s['seconds'] for s in selected),
                          'max_unit_seconds': max(s['seconds'] for s in selected)})
    # Warm-up repeats a real first unit. Only its cold excess is additional to steady compute.
    cold_extra = max(0, warmup_seconds - samples[0]['seconds'])
    return {'groups': estimates, 'setup_seconds': setup_seconds, 'cold_extra_seconds': cold_extra,
            'estimated_seconds': setup_seconds + cold_extra + sum(e['seconds'] for e in estimates)}


class SampleJob:
    def __init__(self, out, directory, manifest, stage, limit):
        self.out, self.directory, self.stage, self.limit = out, directory, stage, limit
        self.cache = directory / 'cache'
        self.manifest = {**manifest, 'cache': str(self.cache)}
        self.samples = []
        self.started = time.perf_counter()
        self.last = None
        self.setup_seconds = 0
        self.unit = None

    def boundary(self):
        if (self.out / 'stop').exists():
            raise Stopped('Stop requested; the current checkpoint has finished.')
        if self.last is None:
            self.last = time.perf_counter()
            self.setup_seconds = self.last - self.started

    def part(self, stage, name):
        if str(name) not in ('tokens', 'running'):
            layer, _, start = str(name).partition('-')
            self.unit = ({'token_start': int(name)} if stage == 'activations' else
                         {'layer': int(layer), 'start': int(start or 0)})
        return self.directory / 'parts' / stage / f'{name}.npz'

    def save(self, path, **arrays):
        import numpy as np
        if not all(np.isfinite(value).all() for value in arrays.values()):
            raise ValueError(f'Nonfinite values in {path}')
        atomic_npz(path, **arrays)

    def progress(self, stage, done, total, **kwargs):
        import torch
        if torch.cuda.is_available():
            torch.cuda.synchronize()
        now = time.perf_counter()
        unit = {'layer': done, 'pairs': done} if stage == 'connections' else self.unit
        self.samples.append({**unit, 'seconds': now - self.last})
        if stage == 'connections':
            import numpy as np
            with np.load(self.part(stage, 'running'), allow_pickle=False) as arrays:
                if not all(np.isfinite(arrays[key]).all() for key in arrays.files):
                    raise ValueError('Nonfinite connection checkpoint.')
        atomic_json(self.directory / 'samples.json', self.samples)
        atomic_json(self.out / 'status.json', {'status': 'running', 'model': self.manifest['model'],
                    'stage': stage, 'checkpoints': len(self.samples), 'sample_limit': self.limit,
                    'phase': self.directory.name, 'updated': time.time()})
        print(json.dumps({'stage': stage, **self.samples[-1]}), flush=True)
        self.last = time.perf_counter()
        if self.limit is not None and len(self.samples) >= self.limit:
            raise SampleComplete()


def prepare_corpus(out, parameters):
    """One pinned, shuffled public corpus; identical text and token budget for both models."""
    from datasets import load_dataset
    from huggingface_hub import HfApi
    from transformers import AutoTokenizer
    info = HfApi().dataset_info('HuggingFaceFW/fineweb-edu')
    tokenizers = [AutoTokenizer.from_pretrained(m['snapshot'], local_files_only=True)
                  for m in parameters['models'].values()]
    streams = [[] for _ in tokenizers]
    texts = []
    rows = load_dataset(info.id, 'sample-10BT', revision=info.sha, split='train', streaming=True).shuffle(seed=0)
    for row in rows:
        if (out / 'stop').exists():
            raise Stopped('Stop requested during corpus preparation.')
        text = row['text']
        texts.append(text)
        for tokenizer, ids in zip(tokenizers, streams):
            ids.extend(tokenizer(text, add_special_tokens=False).input_ids + [tokenizer.eos_token_id])
        if min(map(len, streams)) >= parameters['tokens']:
            break
    if min(map(len, streams)) < parameters['tokens']:
        raise ValueError('Calibration corpus ended too early.')
    import numpy as np
    hashes = {}
    for name, ids in zip(parameters['models'], streams):
        selected = np.array(ids[:parameters['tokens']], np.int32)
        atomic_npz(out / name / 'calibration.npz', ids=selected)
        hashes[name] = hashlib.sha256(selected.tobytes()).hexdigest()
    atomic_json(out / 'corpus.json', {'dataset': info.id, 'revision': info.sha, 'shuffle_seed': 0,
                'tokens': parameters['tokens'], 'rows': len(texts), 'token_hashes': hashes,
                'text_sha256': hashlib.sha256(json.dumps(texts).encode()).hexdigest()})


def run_phase(out, name, stage, parameters):
    import torch
    from cache_builders import activations, connection_arrays, layout, lens, steer
    from model_config import Weights
    manifest = {**parameters['models'][name], 'tokens': parameters['tokens']}
    cfg = validate_config(manifest['config'])
    groups = layer_groups(manifest)
    layers = [l for g in groups for l in evenly_spaced(
        range(max(1, g['first']) if stage == 'connections' else g['first'], g['last']), parameters['layers'])]
    phase_dir = out / name / stage
    phase_dir.mkdir(parents=True, exist_ok=True)
    result = {'status': 'running', 'model': manifest['model'], 'revision': manifest['revision'],
              'stage': stage, 'layers': layers, 'groups': groups, 'batch': manifest['batch']}
    started = time.perf_counter()
    result['process_overhead_seconds'] = started - PROCESS_STARTED
    with job_lock(phase_dir / 'phase.lock'), job_lock(ROOT / 'explorer/cache/.device.lock'):
        try:
            if not torch.cuda.is_available():
                raise RuntimeError('This benchmark currently requires a CUDA GPU.')
            torch.cuda.reset_peak_memory_stats()
            result['gpu'] = torch.cuda.get_device_name()
            rt = None
            if stage in ('lens', 'steer', 'activations'):
                from runtime import Runtime
                rt = Runtime(str(phase_dir / 'stats'), model=manifest['model'], revision=manifest['revision'],
                             cache_dir=phase_dir / 'runtime-cache')
                rt.ensure_loaded()
            result['load_seconds'] = time.perf_counter() - started
            result['torch_threads'] = torch.get_num_threads()
            result['logical_cpus'] = os.cpu_count()
            batch = manifest['batch'] if stage == 'steer' else 1024
            starts = chunk_starts(cfg['intermediate_size'], batch, parameters['batches'])
            if stage.startswith('layout_'):
                units = len(layers)
            elif stage == 'connections':
                units = len(layers)
            else:
                units = len(layers) * len(starts)
            attempt = phase_dir / ('attempt-' + uuid.uuid4().hex[:8])

            def execute(job, selected_layers, selected_starts):
                try:
                    if stage.startswith('layout_'):
                        layout(job, stage, cfg, Weights(manifest['snapshot']), layers=selected_layers)
                    elif stage == 'connections':
                        connection_arrays(cfg, Weights(manifest['snapshot']), targets=selected_layers,
                                          checkpoint=job.part(stage, 'running'), boundary=job.boundary,
                                          progress=lambda done, total: job.progress(stage, done, total))
                    else:
                        (lens if stage == 'lens' else steer)(job, rt, cfg, layers=selected_layers, starts=selected_starts)
                except SampleComplete:
                    return
                raise RuntimeError('Sample selection reached full-cache aggregation unexpectedly.')

            warm_seconds = 0
            if stage != 'activations':
                warm = SampleJob(out, attempt / 'warmup', manifest, stage, 1)
                execute(warm, layers[:1], starts[:1])
                warm_seconds = warm.samples[0]['seconds']
                sampled = SampleJob(out, attempt / 'samples', manifest, stage, units)
                execute(sampled, layers, starts)
                result.update(project(manifest, groups, stage, sampled.samples,
                                      max(sampled.setup_seconds, warm.setup_seconds), warm_seconds))
            else:
                import numpy as np
                sampled = SampleJob(out, attempt / 'samples', manifest, stage, None)
                with np.load(out / name / 'calibration.npz', allow_pickle=False) as data:
                    sampled.save(sampled.part(stage, 'tokens'), ids=data['ids'])
                before = time.perf_counter()
                activations(sampled, rt, cfg)
                result['estimated_seconds'] = time.perf_counter() - before
                result['full_stage_measured'] = True
            result['samples'] = sampled.samples
            result['warmup_seconds'] = warm_seconds
            if stage == 'lens':
                before = time.perf_counter()
                rt.vocab_strings()
                result['vocabulary_seconds'] = time.perf_counter() - before
                result['estimated_seconds'] += result['vocabulary_seconds']
            if stage == 'steer':
                layer = evenly_spaced(range(groups[-1]['first'], groups[-1]['last']), 1)[0]
                prompt = 'Explain how a bicycle works in two sentences.'
                chat = []
                for dose in (0, .8):
                    replies = ['', '', '']
                    before = time.perf_counter()
                    for row, delta in rt.steer_stream(layer, 1870, [[{'role': 'user', 'content': prompt}]] * 3,
                                                     dose, 'add', max_new=64):
                        if row is not None:
                            replies[row] += delta
                    if dose == 0 and len(set(replies)) != 1:
                        raise ValueError('Zero-dose Chat rows disagree.')
                    chat.append({'dose': dose, 'seconds': time.perf_counter() - before, 'replies': replies,
                                 'tokens': [len(rt.tok(r, add_special_tokens=False).input_ids) for r in replies]})
                result['chat'] = chat
            if rt is not None:
                rt._db.close()
            result['estimated_seconds'] += result['load_seconds'] + result['process_overhead_seconds']
            result.update(status='completed', wall_seconds=time.perf_counter() - started,
                          peak_allocated_gib=torch.cuda.max_memory_allocated() / 2**30,
                          peak_reserved_gib=torch.cuda.max_memory_reserved() / 2**30)
        except Exception as error:
            result.update(status='stopped' if isinstance(error, Stopped) else 'failed',
                          error=str(error), traceback=traceback.format_exc())
            raise
        finally:
            atomic_json(phase_dir / 'result.json', result)


def write_report(out, parameters, results):
    totals = {name: sum(results[name][s]['estimated_seconds'] for s in STAGES) for name in parameters['models']}
    summary = {'status': 'completed', 'estimated_hours': {name: value / 3600 for name, value in totals.items()}}
    atomic_json(out / 'summary.json', summary)
    names = list(parameters['models'])
    lines = ['# Cache benchmark comparison', '',
             'Same batch size, pinned weights, corpus, sample-selection rules and production cache builders.',
             'Compiled and learned layer strata are weighted by their actual size. Each stage runs in a fresh process.', '',
             '| Stage | ' + ' | '.join(names) + ' |', '| --- | ' + ' | '.join('---:' for _ in names) + ' |']
    for stage in STAGES:
        lines.append('| ' + stage + ' | ' + ' | '.join(f"{results[n][stage]['estimated_seconds'] / 60:.1f} min" for n in names) + ' |')
    lines += ['| **Total projection** | ' + ' | '.join(f'**{totals[n] / 3600:.1f} h**' for n in names) + ' |', '',
              'These are projections, not completed full-cache builds. The activation stage is measured in full.',
              'Per-checkpoint compression/writes, model loading, cold warm-up excess and vocabulary export are included.',
              'Process/import overhead is recorded separately below. Final aggregation/export for sampled stages is not measured.',
              'Layer variability, CPU scheduling, disk caching and thermal throttling can change the eventual time; allow a margin.', '',
              'Dataset identity and token hashes: `corpus.json`. Every raw sample, setup time, selected layer and GPU peak is in `<model>/<stage>/result.json`.',
              'Original cache jobs and weights were not modified; sampled artifacts remain isolated here.',
              'Qwenputer results cover stock text generation and analysis; its firmware-backed RISC-V driver is not included.', '']
    for name in names:
        model = parameters['models'][name]
        lines += [f'## {name}', '', f"Model: `{model['model']}` at `{model['revision']}`.",
                  f"Dependency versions: `{json.dumps(model['packages'], sort_keys=True)}`.", '',
                  '| Stage | Observed phase wall time | Fresh-process/import overhead | Peak GPU allocation |',
                  '| --- | ---: | ---: | ---: |']
        for stage in STAGES:
            r = results[name][stage]
            lines.append(f"| {stage} | {r['wall_seconds']:.1f} s | {r['process_overhead_seconds']:.1f} s | {r['peak_allocated_gib']:.2f} GiB |")
        for chat in results[name]['steer']['chat']:
            lines.append(f"\nThree-row Chat, dose {chat['dose']}: {chat['seconds']:.2f} s, up to 64 new tokens per row; actual retokenized counts {chat['tokens']}.")
        lines.append('')
    (out / 'report.md').write_text('\n'.join(lines), encoding='utf-8')
    return summary


def child(out, arguments, log_path, environment, timeout):
    before = time.perf_counter()
    with log_path.open('ab', buffering=0) as log:
        async def execute():
            proc = await asyncio.create_subprocess_exec(
                sys.executable, __file__, *arguments, cwd=ROOT, env={**os.environ, **environment},
                stdout=log, stderr=log, **process_options())
            try:
                code = await asyncio.wait_for(proc.wait(), timeout)
            except BaseException:
                await stop_process(proc)
                raise
            if code:
                raise subprocess.CalledProcessError(code, arguments)
        try:
            asyncio.run(execute())
        except subprocess.CalledProcessError:
            if (out / 'stop').exists():
                raise Stopped('Stop requested.') from None
            raise
    return time.perf_counter() - before


def supervise(out, parameters):
    with job_lock(out / 'run.lock'):
        (out / 'stop').unlink(missing_ok=True)
        try:
            with job_lock(ROOT / 'explorer/cache/.device.lock'):
                pass
            if not (out / 'corpus.json').exists():
                atomic_json(out / 'status.json', {'status': 'running', 'stage': 'prepare_corpus', 'updated': time.time()})
                elapsed = child(out, ['_corpus', str(out)], out / 'corpus.log',
                                {'HF_HUB_OFFLINE': '0'}, parameters['timeout'])
                corpus = json.loads((out / 'corpus.json').read_text())
                atomic_json(out / 'corpus.json', {**corpus, 'prepare_seconds': elapsed})
            results = {name: {} for name in parameters['models']}
            # Alternate which model runs first across phases to reduce order bias.
            for index, stage in enumerate(STAGES):
                names = list(parameters['models'])
                if index % 2:
                    names.reverse()
                for name in names:
                    if (out / 'stop').exists():
                        raise Stopped('Stop requested.')
                    path = out / name / stage / 'result.json'
                    if path.exists():
                        result = json.loads(path.read_text())
                        if result.get('status') == 'completed':
                            results[name][stage] = result
                            continue
                    path.parent.mkdir(parents=True, exist_ok=True)
                    # Refuse to overlap an orphan from a previously interrupted supervisor.
                    with job_lock(path.parent / 'phase.lock'):
                        pass
                    atomic_json(out / 'status.json', {'status': 'running', 'model': parameters['models'][name]['model'],
                                'stage': stage, 'phase': 'starting', 'updated': time.time()})
                    elapsed = child(out, ['_phase', str(out), name, stage], path.parent / 'worker.log',
                                    {'EXPLORER_CACHE_WORKER': '1', 'EXPLORER_NO_MODEL': '',
                                     'HF_HUB_OFFLINE': '1', 'HF_DATASETS_OFFLINE': '1'}, parameters['timeout'])
                    result = json.loads(path.read_text())
                    overhead = max(0, elapsed - result['wall_seconds'] - result['process_overhead_seconds'])
                    result['process_overhead_seconds'] += overhead
                    result['estimated_seconds'] += overhead
                    atomic_json(path, result)
                    results[name][stage] = result
            summary = write_report(out, parameters, results)
            atomic_json(out / 'status.json', {**summary, 'updated': time.time(), 'report': str(out / 'report.md')})
        except Exception as error:
            previous = json.loads((out / 'status.json').read_text()) if (out / 'status.json').exists() else {}
            atomic_json(out / 'status.json', {**previous, 'status': 'stopped' if isinstance(error, Stopped) else 'failed',
                        'error': str(error) or type(error).__name__, 'updated': time.time()})
            raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    run = sub.add_parser('run', help='Run or resume an isolated comparison; never starts real cache jobs')
    run.add_argument('--jobs', nargs='+', type=Path, required=True)
    run.add_argument('--out', type=Path, required=True)
    run.add_argument('--batch', type=int, default=16)
    run.add_argument('--layers', type=int, default=3, help='Evenly spaced sample layers per stratum')
    run.add_argument('--batches', type=int, default=3, help='Neighbouring chunks at each of three neuron positions')
    run.add_argument('--tokens', type=int, default=10240)
    run.add_argument('--timeout', type=int, default=3600, help='Maximum seconds per phase, including corpus preparation')
    stop = sub.add_parser('stop', help='Request a stop after the current checkpoint')
    stop.add_argument('out', type=Path)
    for name in ('_phase', '_corpus'):
        internal = sub.add_parser(name, help=argparse.SUPPRESS)
        internal.add_argument('out', type=Path)
        if name == '_phase':
            internal.add_argument('model')
            internal.add_argument('stage', choices=STAGES)
    args = parser.parse_args()
    out = args.out.resolve()
    if args.command == 'stop':
        if not (out / 'parameters.json').is_file():
            parser.error('Benchmark does not exist.')
        atomic_json(out / 'stop', {'requested': time.time()})
        return
    if args.command == 'run':
        if min(args.batch, args.layers, args.batches, args.timeout) < 1 or args.tokens < 512:
            parser.error('Sample counts and batch must be positive; tokens must be at least 512.')
        models = {}
        for directory in args.jobs:
            job = Job(directory)
            job.validate_environment()
            manifest = job.manifest
            for protected in (job.directory, job.cache.resolve(), Path(manifest['snapshot']).resolve()):
                if out == protected or protected in out.parents:
                    parser.error('Benchmark output must be separate from source jobs, caches and model weights.')
            if json.loads((Path(manifest['snapshot']) / 'config.json').read_text()) != manifest['config']:
                parser.error('Snapshot configuration changed.')
            if directory.name in models:
                parser.error('Job directory names must be unique.')
            models[directory.name] = {**manifest, 'batch': args.batch}
        files = ('benchmark_cache.py', 'cache_builders.py', 'runtime.py', 'model_config.py')
        parameters = {'version': 1, 'models': models, 'layers': args.layers, 'batches': args.batches,
                      'tokens': math.ceil(args.tokens / 512) * 512, 'timeout': args.timeout,
                      'code': {name: digest(Path(__file__).parent / name) for name in files}}
        saved = out / 'parameters.json'
        if out.exists() and not saved.exists() and any(out.iterdir()):
            parser.error('Output directory must be empty or belong to this benchmark.')
        if saved.exists() and json.loads(saved.read_text()) != parameters:
            parser.error('Settings, code or model identity changed; choose a new output directory.')
        out.mkdir(parents=True, exist_ok=True)
        atomic_json(saved, parameters)
        supervise(out, parameters)
    else:
        parameters = json.loads((out / 'parameters.json').read_text())
        if args.command == '_corpus':
            prepare_corpus(out, parameters)
        else:
            run_phase(out, args.model, args.stage, parameters)


if __name__ == '__main__':
    main()
