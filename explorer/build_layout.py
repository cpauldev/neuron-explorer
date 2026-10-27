"""Seriated sheet layouts: places each layer's neurons on a padded square grid so that neurons with similar weights sit
together. Embeds each neuron by its down_proj column ("writes": the direction it adds to the residual stream) or its
gate and up rows ("reads"), cosine-normalised, PCA to 50 dims, UMAP to 2D, then snaps to the grid: sort by y into
rows of ceil(sqrt(N)), then by x within each row.

    uv run python explorer/build_layout.py --kind writes

Writes model-specific layout_<kind>.npz: cell[L, N] (int16, row * ceil(sqrt(N)) + col).
Use cache_job.py for checkpoints and background execution.
"""
import argparse
import json

import numpy as np
from model_config import ROOT, DEFAULT_MODEL, Weights, data_paths, snapshot, validate_config
from cache_builders import layout_cells

from cache_storage import atomic_npz, job_lock


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="Qwen/Qwen3.5-4B")
    ap.add_argument("--revision")
    ap.add_argument("--kind", default="writes", choices=["writes", "reads"])
    ap.add_argument("--pca", type=int, default=50)
    ap.add_argument("--neighbors", type=int, default=30)
    a = ap.parse_args()
    if a.pca <= 0 or a.neighbors < 2:
        ap.error("--pca must be positive and --neighbors must be at least 2")
    with job_lock(ROOT / "explorer/cache/.device.lock"):
        root = snapshot(a.model, a.revision)
        weights = Weights(root)
        cfg = validate_config(json.load(open(root / "config.json")))
        L = cfg["num_hidden_layers"]

        cells = []
        for layer in range(L):
            cells.append(layout_cells(weights, layer, a.kind, a.pca, a.neighbors))
            print(f"L{layer} done", flush=True)

        revision = None if a.model == DEFAULT_MODEL and a.revision is None else root.name
        out = data_paths(a.model, revision)["cache"] / f"layout_{a.kind}.npz"
        atomic_npz(out, cell=np.stack(cells))
        print("->", out)


if __name__ == "__main__":
    main()
