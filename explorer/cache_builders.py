"""Scientific cache stages, checkpointed at layer, pair-group, or neuron-batch boundaries.

Algorithms match the original builders; outputs retain the server's existing NPZ schemas.
cache_job invokes stages in separate processes to release model allocations. One-shot layout and
connection commands reuse the same scientific routines.
"""
import json
import math
from pathlib import Path

import numpy as np
import torch

from model_config import Weights, validate_config
from cache_storage import atomic_npz

CHAT = ["Who are you?", "Write whatever you like."]
PLAIN = ["I think the most important thing to remember is", "Today we are going to talk about"]
PREFIX = "model.language_model.layers.{}."


def load_part(path):
    with np.load(path, allow_pickle=False) as arrays:
        return {key: arrays[key] for key in arrays.files}


def build(job, stage):
    cfg = validate_config(job.manifest["config"])
    root = Path(job.manifest["snapshot"])
    # Detect a changed or evicted snapshot before trusting old checkpoints.
    if json.loads((root / "config.json").read_text()) != job.manifest["config"]:
        raise ValueError("Snapshot configuration changed; cannot resume this job.")
    job.cache.mkdir(parents=True, exist_ok=True)
    if stage.startswith("layout_"):
        layout(job, stage, cfg, Weights(root))
    elif stage == "connections":
        connections(job, cfg, Weights(root))
    else:
        from runtime import Runtime
        rt = Runtime(str(job.cache / "stats"), model=job.manifest["model"],
                     revision=job.manifest["revision"], cache_dir=job.cache)
        rt.ensure_loaded()
        if stage == "lens":
            lens(job, rt, cfg)
        elif stage == "steer":
            steer(job, rt, cfg)
        elif stage == "activations":
            activations(job, rt, cfg)


def grid_cells(xy):
    """Padded square grid, matching map3d's ceil(sqrt(N)); no phantom neurons."""
    count, side = len(xy), math.ceil(math.sqrt(len(xy)))
    cells = np.empty(count, np.int16)
    by_y = np.argsort(xy[:, 1], kind="stable")
    for start in range(0, count, side):
        band = by_y[start:start + side]
        band = band[np.argsort(xy[band, 0], kind="stable")]
        cells[band] = start + np.arange(len(band))
    return cells


def layout_cells(weights, layer, kind, pca=50, neighbors=30):
    """Shared one-layer algorithm for one-shot and resumable layout builders."""
    import umap
    prefix = PREFIX.format(layer) + "mlp."
    if kind == "writes":
        x = weights.tensor(prefix + "down_proj.weight").float().numpy().T
    else:
        x = np.concatenate([weights.tensor(prefix + name + ".weight").float().numpy()
                            for name in ("gate_proj", "up_proj")], axis=1)
    x = x / np.maximum(np.linalg.norm(x, axis=1, keepdims=True), 1e-12)
    x = x - x.mean(0)
    u, s, _ = np.linalg.svd(x, full_matrices=False)
    z = u[:, :pca] * s[:pca]
    xy = umap.UMAP(n_neighbors=neighbors, min_dist=0.05, metric="cosine", random_state=0).fit_transform(z)
    return grid_cells(xy)


def layout(job, stage, cfg, weights):
    L = cfg["num_hidden_layers"]
    for layer in range(L):
        job.boundary()
        path = job.part(stage, layer)
        cached = path.exists()
        if not cached:
            job.save(path, cell=layout_cells(weights, layer, stage.removeprefix("layout_")))
        job.progress(stage, layer + 1, L, measured=not cached)
    job.save(job.cache / f"{stage}.npz", cell=np.stack([load_part(job.part(stage, l))["cell"] for l in range(L)]))


def lens(job, rt, cfg):
    L, N, chunk, k = cfg["num_hidden_layers"], cfg["intermediate_size"], 1024, 12
    total = L * math.ceil(N / chunk)
    done = 0
    for l, layer in enumerate(rt.lm.layers):
        for start in range(0, N, chunk):
            job.boundary()
            path = job.part("lens", f"{l}-{start}")
            cached = path.exists()
            if not cached:
                with torch.inference_mode():
                    d = layer.mlp.down_proj.weight[:, start:start + chunk].T[:, None]
                    logits = rt.model.lm_head(rt.lm.norm(d))[:, 0]
                    job.save(path, up=logits.topk(k).indices.int().cpu().numpy(),
                             down=(-logits).topk(k).indices.int().cpu().numpy())
            done += 1
            job.progress("lens", done, total, measured=not cached)
    out = {key: np.stack([np.concatenate([load_part(job.part("lens", f"{l}-{s}"))[key]
                                         for s in range(0, N, chunk)]) for l in range(L)]) for key in ("up", "down")}
    job.save(job.cache / "lens_index.npz", **out)
    rt.vocab_strings()


@torch.inference_mode()
def steer(job, rt, cfg):
    """Same four contexts and signed residual-normalized dose as sweep/steer_lens.py."""
    tok, lm = rt.tok, rt.lm
    contexts = [rt.chat_ids(c) for c in CHAT] + [tok(p).input_ids for p in PLAIN]
    C, T = len(contexts), max(map(len, contexts))
    pad = tok.pad_token_id if tok.pad_token_id is not None else 0
    ids = torch.tensor([[pad] * (T - len(c)) + c for c in contexts], device=rt.dev)
    mask = torch.tensor([[0] * (T - len(c)) + [1] * len(c) for c in contexts], device=rt.dev)
    positions = (mask.cumsum(-1) - 1).clamp(min=0)
    residuals, push, handles = {}, {}, []

    def capture(i):
        def hook(module, inputs, output):
            # Save only the scalar, never retain batch activations across subsequent forwards.
            if not push:
                r = output[0] if isinstance(output, tuple) else output
                residuals[i] = r[mask.bool()].float().norm(dim=-1).median().item()
        return hook

    def intervene(i):
        def hook(module, inputs):
            if push.get("layer") == i:
                h = inputs[0].clone()
                h[torch.arange(len(h), device=rt.dev), :, push["cols"]] += push["vals"][:, None].to(h.dtype)
                return (h,)
        return hook

    def prediction(x, m, p):
        h = lm(input_ids=x, attention_mask=m, position_ids=p, use_cache=False).last_hidden_state[:, -1]
        return torch.log_softmax(rt.model.lm_head(h).float(), -1)

    try:
        for i, layer in enumerate(lm.layers):
            handles.extend([layer.register_forward_hook(capture(i)),
                            layer.mlp.down_proj.register_forward_pre_hook(intervene(i))])
        with torch.inference_mode():
            base = prediction(ids, mask, positions)
        L, N, B, k = cfg["num_hidden_layers"], cfg["intermediate_size"], job.manifest["batch"], 12
        total, done = L * math.ceil(N / B), 0
        output = {key: [] for key in ("up_tok", "down_tok", "up_kl", "down_kl")}
        for l, layer in enumerate(lm.layers):
            unit = residuals[l] / layer.mlp.down_proj.weight.float().norm(dim=0)
            for start in range(0, N, B):
                job.boundary()
                path = job.part("steer", f"{l}-{start}")
                cached = path.exists()
                if not cached:
                    n = torch.arange(start, min(start + B, N), device=rt.dev)
                    cols = n.repeat_interleave(C)
                    arrays = {}
                    for sign, key in ((1, "up"), (-1, "down")):
                        push.update(layer=l, cols=cols, vals=sign * 0.8 * unit[cols])
                        with torch.inference_mode():
                            lp = prediction(ids.repeat(len(n), 1), mask.repeat(len(n), 1), positions.repeat(len(n), 1)).view(len(n), C, -1)
                            delta = (lp - base[None]).mean(1)
                            arrays[key + "_tok"] = delta.topk(k).indices.int().cpu().numpy()
                            arrays[key + "_kl"] = (lp.exp() * (lp - base[None])).sum(-1).mean(1).cpu().numpy()
                        del lp, delta
                    # Leave capture disabled after baseline; don't re-enable it on repeated batches.
                    push.clear()
                    push["layer"] = None
                    job.save(path, **arrays)
                done += 1
                job.progress("steer", done, total, measured=not cached)
            for key in output:
                output[key].append(np.concatenate([load_part(job.part("steer", f"{l}-{s}"))[key] for s in range(0, N, B)]))
        job.save(job.cache / "steer_index.npz", **{key: np.stack(value) for key, value in output.items()})
    finally:
        for handle in handles:
            handle.remove()


def connections(job, cfg, weights):
    out = connection_arrays(cfg, weights, checkpoint=job.part("connections", "running"), boundary=job.boundary,
                            progress=lambda done, total: job.progress("connections", done, total))
    job.save(job.cache / "connections.npz", **out, k=24)


def connection_arrays(cfg, weights, *, k=24, checkpoint=None, boundary=lambda: None, progress=lambda done, total: None):
    """Shared direct-path top-k algorithm; optional checkpoint retains the running aggregate per target layer."""
    L, N, K = cfg["num_hidden_layers"], cfg["intermediate_size"], k
    dev = "cuda" if torch.cuda.is_available() else ("mps" if torch.backends.mps.is_available() else "cpu")
    down, gate, up, norm = [], [], [], []
    for l in range(L):
        p = PREFIX.format(l)
        down.append(weights.tensor(p + "mlp.down_proj.weight").to(dev, torch.bfloat16))
        gate.append(weights.tensor(p + "mlp.gate_proj.weight").to(dev, torch.bfloat16))
        up.append(weights.tensor(p + "mlp.up_proj.weight").to(dev, torch.bfloat16))
        norm.append((1 + weights.tensor(p + "post_attention_layernorm.weight").float()).to(dev, torch.bfloat16))
    if checkpoint is not None and checkpoint.exists():
        saved = load_part(checkpoint)
        next_layer = int(saved.pop("next_layer"))
        best = {key: torch.from_numpy(value).to(dev) for key, value in saved.items()}
    else:
        next_layer = 1
        best = {f"{side}_{key}": torch.full((L, N, K), fill, dtype=dtype, device=dev)
                for side in ("down", "up") for key, fill, dtype in
                (("z", -1e9, torch.float32), ("layer", 0, torch.int16), ("n", 0, torch.int16), ("sign", 0, torch.int8))}

    def merge(side, l, z, indices, other, signs):
        candidates = {"z": z, "layer": torch.full_like(indices, other, dtype=torch.int16),
                      "n": indices.to(torch.int16), "sign": signs}
        values = {key: torch.cat([best[f"{side}_{key}"][l], value], 1) for key, value in candidates.items()}
        choice = values["z"].topk(K, dim=1).indices
        for key, value in values.items():
            best[f"{side}_{key}"][l] = value.gather(1, choice)

    with torch.inference_mode():
        for j in range(next_layer, L):
            boundary()
            for i in range(j):
                boundary()
                v = down[i] * norm[j][:, None]
                p = (gate[j] @ v).float() * (up[j] @ v).float()
                m = p.abs()
                z = (m - m.mean(0, keepdim=True)) / (m.std(0, keepdim=True) + 1e-8)
                top = z.topk(K, dim=0)
                signs = torch.where(p.gather(0, top.indices) > 0, 1, -1).to(torch.int8)
                merge("down", i, top.values.T, top.indices.T, j, signs.T)
                z = (m - m.mean(1, keepdim=True)) / (m.std(1, keepdim=True) + 1e-8)
                top = z.topk(K, dim=1)
                signs = torch.where(p.gather(1, top.indices) > 0, 1, -1).to(torch.int8)
                merge("up", j, top.values, top.indices, i, signs)
                del p, m, z, top, v
            if checkpoint is not None:
                atomic_npz(checkpoint, next_layer=j + 1, **{key: value.cpu().numpy() for key, value in best.items()})
            progress(j, L - 1)
    out = {key: value.clamp(min=-60000).cpu().numpy().astype(np.float16) if key.endswith("_z")
           else value.cpu().numpy().astype(np.int8) if key.endswith("_layer") else value.cpu().numpy()
           for key, value in best.items()}
    return out


def activations(job, rt, cfg):
    """Freeze calibration token IDs once, so replay never depends on streaming/shuffle state."""
    source = job.part("activations", "tokens")
    seq = 512
    if not source.exists():
        from datasets import load_dataset
        ids, required = [], math.ceil(job.manifest["tokens"] / seq) * seq
        for row in load_dataset("HuggingFaceFW/fineweb-edu", "sample-10BT", split="train", streaming=True).shuffle(seed=0):
            job.boundary()
            ids.extend(rt.tok(row["text"], add_special_tokens=False).input_ids + [rt.tok.eos_token_id])
            if len(ids) >= required:
                break
        if len(ids) < required:
            raise RuntimeError("Calibration dataset ended before enough tokens were collected.")
        job.save(source, ids=np.array(ids[:required], np.int32))
    ids = load_part(source)["ids"]
    shape = (cfg["num_hidden_layers"], cfg["intermediate_size"])
    pos, neg = np.zeros(shape, np.float32), np.zeros(shape, np.float32)
    for start in range(0, len(ids), seq):
        job.boundary()
        path = job.part("activations", start)
        cached = path.exists()
        if not cached:
            acts = rt.all_activations(ids[start:start + seq].tolist(), skip_first=True)
            job.save(path, pos=np.stack([acts[l][0].numpy() for l in range(shape[0])]),
                     neg=np.stack([acts[l][2].numpy() for l in range(shape[0])]))
        part = load_part(path)
        pos, neg = np.maximum(pos, part["pos"]), np.minimum(neg, part["neg"])
        job.progress("activations", start // seq + 1, len(ids) // seq, measured=not cached)
    job.save(job.cache / "act_scale.npz", pos=pos, neg=neg, tokens=len(ids))
