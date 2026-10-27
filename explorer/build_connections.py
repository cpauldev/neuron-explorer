"""Direct-path connections for every neuron in every layer, for the explorer's details tab.

For layers i < j, P[B, A] = (W_gate_j[B] . v_A) * (W_up_j[B] . v_A) with v_A = (1 + w_j) * W_down_i[:, A], w_j the
pre-MLP norm weight of layer j. Neuron A's downstream links in layer j are column A of P, |P| z-scored over B; neuron
B's upstream links in layer i are row B of P, |P| z-scored over A. Each neuron keeps its k strongest links per side
across all layers, with sign(P).

    uv run python explorer/build_connections.py            # one-shot; use cache_job.py for checkpoint recovery

Writes model-specific connections.npz: {down,up}_layer [L, N, k] int8, {down,up}_n int16, {down,up}_z float16,
{down,up}_sign int8.
"""
import argparse
import json
import time

from model_config import ROOT, DEFAULT_MODEL, Weights, data_paths, snapshot, validate_config
from cache_builders import connection_arrays
from cache_storage import atomic_npz, job_lock


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--revision")
    ap.add_argument("--k", type=int, default=24)
    ap.add_argument("--out", help="Explicit output override; otherwise use this model's cache directory")
    a = ap.parse_args()
    if a.k <= 0:
        ap.error("--k must be positive")
    with job_lock(ROOT / "explorer/cache/.device.lock"):
        root = snapshot(a.model, a.revision)
        cfg = validate_config(json.loads((root / "config.json").read_text()))
        if a.k > cfg["intermediate_size"]:
            ap.error("--k exceeds the number of neurons")
        revision = None if a.model == DEFAULT_MODEL and a.revision is None else root.name
        out = a.out or data_paths(a.model, revision)["cache"] / "connections.npz"
        started = time.monotonic()
        def progress(done, total):
            print(f"L{done}/{total} done ({time.monotonic() - started:.0f}s)", flush=True)
        arrays = connection_arrays(cfg, Weights(root), k=a.k, progress=progress)
        atomic_npz(out, **arrays, k=a.k)
        print("->", out)


if __name__ == "__main__":
    main()
