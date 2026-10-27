"""Neuron explorer server: sweep data, names, embeddings, and the live model.

    uv run python explorer/server.py            # http://localhost:8791
"""
import asyncio
import builtins
import glob
from functools import wraps
import json
import os
from pathlib import Path
import sys
import threading
import time

import numpy as np
import uvicorn
from anyio import CancelScope
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import PlainTextResponse, FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from transformers import AutoConfig

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "sweep"))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from rank import compute_units  # noqa: E402
from runtime import CACHE, NO_MODEL, Runtime  # noqa: E402
from model_config import MODEL, REVISION, DEFAULT_MODEL, data_paths, model_key, validate_config
from agent_history import Journal
from agent_common import AgentError, AgentPool  # noqa: E402
from agent_attachments import UploadTooLarge, store_upload, attachment_input as read_attachment  # noqa: E402
from codex_agent import CodexClient  # noqa: E402
from claude_agent import ClaudeClient, legacy_session  # noqa: E402
from research_tools import SCOPES, file_operation, scoped_path, run_shell  # noqa: E402
from ui_bridge import UiBridge, UI_COMMAND_FIELDS, validate_ui_command, validate_head  # noqa: E402

_paths = data_paths()
RUNS, STATS, NAMES = (str(_paths[key]) for key in ("runs", "stats", "names"))
PORT = int(os.environ.get("PORT", 8791))
_model_config = AutoConfig.from_pretrained(MODEL, revision=REVISION)
validate_config(_model_config.to_dict())
_cfg = _model_config.get_text_config()
ARCH = {"n_layers": _cfg.num_hidden_layers, "hidden": _cfg.hidden_size, "inter": _cfg.intermediate_size,
        "layer_types": list(_cfg.layer_types), "attn_heads": _cfg.num_attention_heads,
        "kv_heads": _cfg.num_key_value_heads, "linear_k_heads": _cfg.linear_num_key_heads,
        "linear_v_heads": _cfg.linear_num_value_heads}

app = FastAPI()


# only this machine's own pages and tools: a page on another site (or a DNS name rebound to 127.0.0.1) can't reach
# the API, which runs the model and a research assistant
LOCAL_HOSTS = {f"localhost:{PORT}", f"127.0.0.1:{PORT}", f"[::1]:{PORT}"}


@app.middleware("http")
async def local_only(request, call_next):
    from urllib.parse import urlparse
    origin = request.headers.get("origin")
    if (request.headers.get("host") not in LOCAL_HOSTS
            or (origin and urlparse(origin).netloc not in LOCAL_HOSTS)
            or request.headers.get("sec-fetch-site") in ("cross-site", "same-site")):
        return PlainTextResponse("forbidden", status_code=403)
    return await call_next(request)


@app.middleware("http")
async def no_store(request, call_next):
    resp = await call_next(request)
    if not request.url.path.startswith("/api/"):
        resp.headers["Cache-Control"] = "no-store"
    return resp

rt = Runtime(STATS)
_cache = {}


def layer_runs():
    """layer -> path of its sweep run: main_rel preferred, then the largest (calibration runs excluded)."""
    best = {}
    for meta_path in glob.glob(os.path.join(RUNS, "*.meta.json")):
        meta = json.load(open(meta_path))
        if meta.get("design_name", "main") == "calib":
            continue
        jsonl = meta_path.replace(".meta.json", ".jsonl")
        if not os.path.exists(jsonl):
            continue
        key = (meta.get("design_name") == "main_rel", os.path.getsize(jsonl))
        if key > best.get(meta["layer"], ("", (False, 0)))[1]:
            best[meta["layer"]] = (jsonl, key)
    return {layer: path for layer, (path, _) in best.items()}


_load_lock = threading.Lock()


def load_layer(layer):
    path = layer_runs().get(layer)
    if path is None:
        return None
    units_path = path.replace(".jsonl", ".units.jsonl")
    key = (path, os.path.getmtime(path), os.path.getmtime(units_path) if os.path.exists(units_path) else 0)
    if _cache.get(layer, {}).get("key") == key:
        return _cache[layer]
    with _load_lock:
        if _cache.get(layer, {}).get("key") == key:
            return _cache[layer]
        if not (os.path.exists(units_path) and os.path.getmtime(units_path) >= os.path.getmtime(path)):
            full = [json.loads(l) for l in open(path)]  # ranking needs token ids; done once, then dropped
            with open(units_path + ".tmp", "w") as f:
                f.writelines(json.dumps(u) + "\n" for u in compute_units(full))
            del full
            os.replace(units_path + ".tmp", units_path)
            key = (path, os.path.getmtime(path), os.path.getmtime(units_path))
        units = [json.loads(l) for l in open(units_path)]
        # keep only what the explorer shows; token ids, logprobs and alternatives stay on disk
        slim = ("kind", "neuron", "prompt", "dose", "rel_push", "text", "finish", "n_gen")
        rows = []
        for l in open(path):
            r = json.loads(l)
            rows.append({k: r[k] for k in slim})
        by_unit = {}
        for i, r in enumerate(rows):
            by_unit.setdefault((r["kind"], r["neuron"]), []).append(i)
        _cache[layer] = {"key": key, "path": path, "rows": rows, "units": units, "by_unit": by_unit,
                         "meta": json.load(open(path.replace(".jsonl", ".meta.json")))}
        return _cache[layer]


_ranked = {}


def ranked_words(layer):
    """{neuron: top words} for the neurons of `layer` with sweep rollouts, read from the run's ranking file only."""
    path = layer_runs().get(layer)
    units_path = path.replace(".jsonl", ".units.jsonl") if path else None
    if not units_path or not os.path.exists(units_path):
        return {}
    key = (units_path, os.path.getmtime(units_path))
    if _ranked.get(layer, (None,))[0] != key:
        words = {}
        for line in open(units_path):
            u = json.loads(line)
            if u["kind"] == "neuron":
                words[u["neuron"]] = [w for w, _, _ in u["words"][:4]]
        _ranked[layer] = (key, words)
    return _ranked[layer][1]


def swept(layer):
    return ranked_words(layer).keys()


def names():
    return json.load(open(NAMES)) if os.path.exists(NAMES) else {}


@app.get("/api/index")
def index():
    runs = layer_runs()
    return {"model": MODEL, "revision": REVISION, "arch": ARCH,
            "cache_key": "" if MODEL == DEFAULT_MODEL and REVISION is None else model_key(MODEL, REVISION),
            "layers": {str(l): os.path.basename(p) for l, p in sorted(runs.items())}, "status": rt.status}


@app.get("/api/units")
def units(layer: int):
    d = load_layer(layer)
    if d is None:
        return []
    nm = names()
    return [{"kind": u["kind"], "n": u["neuron"], "z": u.get("mass", u["z"]), "null_pct": u["null_pct"],
             "words": [w for w, _, _ in u["words"][:5]], "name": nm.get(f"L{layer}/N{u['neuron']}", "")}
            for u in d["units"]]


@app.get("/api/unit")
def unit(layer: int, n: int, kind: str = "neuron"):
    d = load_layer(layer)
    out = {"layer": layer, "n": n, "kind": kind, "name": names().get(f"L{layer}/N{n}", "")}
    if d is None:
        return out
    rec = next((u for u in d["units"] if u["neuron"] == n and u["kind"] == kind), None)
    rows = [d["rows"][i] for i in d["by_unit"].get((kind, n), [])]
    base = [r for r in d["rows"] if r["kind"] == "baseline"]
    keep = ("prompt", "dose", "rel_push", "text", "finish", "n_gen")
    neurons = [u for u in d["units"] if u["kind"] == "neuron"]
    out.update({
        "run": os.path.basename(d["path"]), "prompts": d["meta"]["prompts"],
        "rollouts": [{k: r[k] for k in keep} for r in rows],
        "baselines": [{k: r[k] for k in keep} for r in base],
        "stats": rec, "rank": next((i + 1 for i, u in enumerate(neurons) if u["neuron"] == n), None) if rec else None,
        "n_ranked": len(neurons),
    })
    return out


@app.post("/api/name")
async def set_name(req: Request):
    body = await req.json()
    nm = names()
    key = f"L{int(body['layer'])}/N{int(body['n'])}"
    if body.get("name", "").strip():
        nm[key] = body["name"].strip()
    else:
        nm.pop(key, None)
    with open(NAMES, "w") as f:
        json.dump(nm, f, indent=1, sort_keys=True)
    return {"ok": True}


@app.get("/api/embeddings")
def embeddings(layer: int):
    d = load_layer(layer)
    if d is None:
        return {}
    path = d["path"].replace(".jsonl", ".umap.json")
    return FileResponse(path) if os.path.exists(path) else JSONResponse({})


@app.get("/api/rollout")
def rollout(layer: int, i: int):
    r = load_layer(layer)["rows"][i]
    return {k: r[k] for k in ("kind", "neuron", "prompt", "dose", "rel_push", "text")}


@app.get("/api/connections")
async def connections(layer: int, n: int, k: int = 24, lens: int = 5):
    out = await asyncio.to_thread(rt.connections, layer, n, k, lens)
    words = await asyncio.to_thread(lambda: {l: ranked_words(l) for l in {c["layer"] for c in out["down"] + out["up"]}})
    nm = names()
    out = {side: [dict(c) for c in out[side]] for side in ("down", "up")}
    for c in out["down"] + out["up"]:
        c["name"] = nm.get(f"L{c['layer']}/N{c['n']}", "")
        c["words"] = words[c["layer"]].get(c["n"], [])
    return out


@app.get("/api/hover")
async def hover(layer: int, n: int):
    con = await asyncio.to_thread(rt.connections, layer, n, 16, 0)
    lens = await asyncio.to_thread(rt.lens, layer, n, 8)
    return {"lens": lens["up"], "lens_neg": lens["down"], "steer": lens.get("steer_up"), "steer_neg": lens.get("steer_down"),
            "con": con}


@app.get("/api/lens")
async def lens(layer: int, n: int):
    return await asyncio.to_thread(rt.lens, layer, n, 12)


@app.post("/api/reads")
async def reads(req: Request):
    b = await req.json()
    return await asyncio.to_thread(rt.read, int(b["layer"]), int(b["n"]), b["text"], b.get("chat", True))


@app.post("/api/steer")
async def steer(req: Request):
    b = await req.json()
    loop, q, cancel = asyncio.get_running_loop(), asyncio.Queue(), threading.Event()

    def work():
        try:
            # each row replays its own earlier replies; the user turns are shared
            rows = []
            for r in range(3):
                msgs = []
                for turn in b.get("history", []):
                    msgs += [{"role": "user", "content": turn["user"]}, {"role": "assistant", "content": turn["replies"][r]}]
                rows.append(msgs + [{"role": "user", "content": b["prompt"]}])
            for row, delta in rt.steer_stream(int(b["layer"]), int(b["n"]), rows, float(b["dose"]),
                                              b.get("mode", "add"), int(b.get("max_new", 300)), cancel):
                loop.call_soon_threadsafe(q.put_nowait, {"row": row, "t": delta})
        except Exception as e:  # surfaced in the UI next to the chat
            loop.call_soon_threadsafe(q.put_nowait, {"row": None, "error": repr(e)})

    threading.Thread(target=work, daemon=True).start()

    async def events():
        try:
            while True:
                ev = await q.get()
                yield f"data: {json.dumps(ev)}\n\n"
                if ev["row"] is None:
                    break
                if await req.is_disconnected():
                    cancel.set()
                    break
        finally:
            cancel.set()

    return StreamingResponse(events(), media_type="text/event-stream")


LENS_INDEX = os.path.join(CACHE, "lens_index.npz")
_lens = {}


def lens_index():
    if "up" not in _lens and os.path.exists(LENS_INDEX):
        z = np.load(LENS_INDEX)
        _lens["up"], _lens["down"] = z["up"], z["down"]
    return _lens if "up" in _lens else None


@app.get("/api/search")
async def search(q: str, limit: int = 300):
    """Neurons whose logit lens (top 12 up or down) contains a token matching q (case-insensitive substring)."""
    idx = lens_index()
    q = q.strip().lower()
    if idx is None or len(q) < 2:
        return {"ready": idx is not None, "results": []}
    vocab = await asyncio.to_thread(rt.vocab_strings)
    match = np.array([i for i, t in enumerate(vocab) if q in t.lower()], dtype=np.int32)
    if not len(match):
        return {"ready": True, "results": [], "tokens": 0}
    out = []
    st = rt.steer_index()
    sources = [("+", idx["up"], "lens"), ("-", idx["down"], "lens")]
    if st is not None:
        sources += [("+", st["up"], "steer"), ("-", st["down"], "steer")]
    for sign, arr, src in sources:
        hit = np.isin(arr, match)  # [L, N, k]
        count = hit.sum(-1)
        best = np.where(hit, np.arange(arr.shape[-1]), 99).min(-1)
        for l, n in zip(*np.nonzero(count)):
            out.append((int(best[l, n]), -int(count[l, n]), int(l), int(n), sign, src))
    # one row per neuron and sign, keeping its best match across the two lenses
    seen, uniq = set(), []
    for row in sorted(out):
        if (row[2], row[3], row[4]) not in seen:
            seen.add((row[2], row[3], row[4])); uniq.append(row)
    out = uniq
    nm, res = names(), []
    sw = {l: swept(l) for l in {row[2] for row in out[:limit]}}
    for rank, _, l, n, sign, src in out[:limit]:
        arr = (idx if src == "lens" else st)["up" if sign == "+" else "down"]
        res.append({"layer": l, "n": n, "sign": sign, "rank": rank, "src": src, "name": nm.get(f"L{l}/N{n}", ""),
                    "swept": n in sw[l], "lens": [vocab[t] for t in arr[l, n, :6]]})
    return {"ready": True, "results": res, "tokens": int(len(match)), "total": len(out)}


ACT_SCALE = os.path.join(CACHE, "act_scale.npz")
MAX_INFER_TOKENS = 1024  # [32, T, 9216] float32 activations plus scores: about 2.4 GB at this length


@app.get("/api/fires")
async def fires(text: str, limit: int = 300, chat: bool = False):
    """Neurons that fire hardest on `text` relative to their typical range over web text (activation / typical max,
    and activation / typical min for the negative side)."""
    if not os.path.exists(ACT_SCALE):
        return {"ready": False, "results": []}
    sc = np.load(ACT_SCALE)
    ids = await asyncio.to_thread(rt.chat_ids if chat else (lambda t: rt.tok(t).input_ids), text)
    acts = await asyncio.to_thread(rt.all_activations, ids)
    toks = [rt.tok.decode([t]) for t in ids]
    cand = []
    for l, (mx, amx, mn, amn) in acts.items():
        p = mx.numpy() / np.maximum(sc["pos"][l], 1e-3)
        q = mn.numpy() / np.minimum(sc["neg"][l], -1e-3)
        for arr, idx, sign, raw in ((p, amx.numpy(), "+", mx.numpy()), (q, amn.numpy(), "-", mn.numpy())):
            top = np.argpartition(-arr, limit)[:limit]
            cand += [(float(arr[n]), l, int(n), sign, int(idx[n]), float(raw[n])) for n in top]
    cand.sort(reverse=True)
    idx_lens, nm = lens_index(), names()
    vocab = await asyncio.to_thread(rt.vocab_strings)
    res = []
    for score, l, n, sign, t, raw in cand[:limit]:
        lens = [vocab[k] for k in (idx_lens["up"] if sign == "+" else idx_lens["down"])[l, n, :6]] if idx_lens else []
        res.append({"layer": l, "n": n, "sign": sign, "score": round(score, 2), "act": round(raw, 2), "token": toks[t],
                    "pos": t, "name": nm.get(f"L{l}/N{n}", ""), "lens": lens})
    return {"ready": True, "results": res, "tokens": toks}


_infer = {}


async def score_text(text, chat=False, heads=False):
    """Every neuron's activation at every token of `text` ([L, T, N]) and its signed score: the positive side as a
    multiple of the neuron's typical max, the negative side of its typical min (act_scale.npz)."""
    ids = rt.chat_ids(text) if chat else rt.tok(text).input_ids
    ids = ids[:MAX_INFER_TOKENS]
    acts = await asyncio.to_thread(rt.full_activations, ids, heads)  # [L, T, N]
    sc = np.load(ACT_SCALE)
    # a side the neuron barely reaches in calibration is scaled by at least a tenth of its other side
    pos = np.maximum(sc["pos"], np.maximum(0.1 * -sc["neg"], 1e-3))[:, None, :]
    neg = np.minimum(sc["neg"], np.minimum(-0.1 * sc["pos"], -1e-3))[:, None, :]
    score = np.where(acts >= 0, acts / pos, -(acts / neg)).astype(np.float32)
    if score.shape[1] > 1:
        score[:, 0, :] = 0  # position 0 is the attention-sink token, outside the range the scale was measured on
    return ids, acts, score


@app.post("/api/infer")
async def infer(req: Request):
    """Runs text through the model and keeps every neuron's activation at every token for /api/infer/view."""
    b = await req.json()
    if not os.path.exists(ACT_SCALE) or rt.tok is None:
        return {"ready": False}
    ids, acts, score = await score_text(b["text"], b.get("chat", False), heads=True)
    units = rt.token_units(ids)
    unit_of = {i: k for k, (_, idx) in enumerate(units) for i in idx}
    _infer.clear()
    _infer.update(ids=ids, toks=[units[unit_of[i]][0] for i in range(len(ids))], acts=acts, score=score, units=units)
    # one chip per unit; clicking it selects the unit's last token (the one that completes the character)
    return {"ready": True, "tokens": [u[0] for u in units], "pos": [u[1][-1] for u in units]}


@app.get("/api/infer/view")
async def infer_view(pos: int = -1, sign: str = "both", lo: int = 0, hi: int = 99, min: float = 1.0, q: str = "",
                     limit: int = 300):
    """Neurons passing the filters for the last inferred text. pos = token index, or -1 for the strongest token.
    Returns the list plus every neuron's signed score at that position (base64 float16, layer-major) for the map."""
    if "score" not in _infer:
        return {"results": []}
    import base64
    S, A, toks = _infer["score"], _infer["acts"], _infer["toks"]  # [L, T, N]
    if pos >= S.shape[1]:
        return {"results": [], "total": 0}
    if pos >= 0:
        best, at = S[:, pos, :], np.full(S[:, 0, :].shape, pos)
    else:
        at = S.argmax(1) if sign == "+" else S.argmin(1) if sign == "-" else np.abs(S).argmax(1)  # [L, N]
        best = np.take_along_axis(S, at[:, None, :], 1)[:, 0, :]
    view = best.copy()
    keep = np.abs(best) >= min
    if sign == "+": keep &= best > 0
    if sign == "-": keep &= best < 0
    lay = np.arange(best.shape[0])[:, None]
    keep &= (lay >= lo) & (lay <= hi)
    idx = lens_index()
    vocab = await asyncio.to_thread(rt.vocab_strings)
    if q.strip() and idx is not None:
        ql = q.strip().lower()
        match = np.array([i for i, t in enumerate(vocab) if ql in t.lower()], dtype=np.int32)
        lens_hit = np.where(best[..., None] >= 0, np.isin(idx["up"][:, :, :6], match), np.isin(idx["down"][:, :, :6], match)).any(-1)
        keep &= lens_hit
    view[~keep] = 0
    ls, ns = np.nonzero(keep)
    order = np.argsort(-np.abs(best[ls, ns]))[:limit]
    nm, res = names(), []
    for o in order:
        l, n = int(ls[o]), int(ns[o]); sg = "+" if best[l, n] > 0 else "-"
        lens = [vocab[k] for k in (idx["up"] if sg == "+" else idx["down"])[l, n, :6]] if idx is not None else []
        t = int(at[l, n])
        res.append({"layer": l, "n": n, "sign": sg, "score": round(float(abs(best[l, n])), 2),
                    "act": round(float(A[l, t, n]), 2), "token": toks[t], "pos": t,
                    "name": nm.get(f"L{l}/N{n}", ""), "lens": lens})
    blob = base64.b64encode(view.astype(np.float16).tobytes()).decode()
    return {"results": res, "total": int(keep.sum()), "map": blob, "shape": list(view.shape)}


def model_transaction(fn):
    """Keep a capture and its consumers on the same text under the reentrant model lock."""
    @wraps(fn)
    def locked(*args, **kwargs):
        with rt.lock:
            return fn(*args, **kwargs)
    return locked


def require_head(layer, head):
    try:
        validate_head(ARCH, layer, head)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


def require_neuron(layer, n):
    try:
        validate_ui_command({"action": "select", "layer": layer, "n": n}, ARCH)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


def query_unit(body, units):
    index = body.get("at")
    if index is None:
        return _find_unit(units, body.get("token"))
    if isinstance(index, bool) or not isinstance(index, int) or not -len(units) <= index < len(units):
        raise HTTPException(400, "at is outside the returned token list")
    return index % len(units)


def _heads_for_infer():
    """The head captures of the last inferred text (re-captured if another text ran since)."""
    ids = _infer.get("ids")
    if ids is None:
        return None
    if not rt.heads or rt.heads.get("ids") != list(ids):
        rt.full_activations(ids, True)
    return rt.heads


@app.get("/api/infer/heads")
@model_transaction
def infer_heads(pos: int = -1):
    """Every attention head's write size at token `pos` of the last inferred text, per layer, as a share of the
    largest write any head of that layer makes at any token past the first (position 0 is the attention sink)."""
    h = _heads_for_infer() if pos >= 0 else None
    if not h or pos >= h["T"]:
        return {"layers": None}
    out = []
    for l in sorted(h["writes"]):
        W = h["writes"][l]  # [T, H]
        top = float(W[1:].max()) if W.shape[0] > 1 else float(W.max())
        out.append([round(float(x) / max(top, 1e-8), 3) for x in W[pos]])
    return {"layers": out}


@app.get("/api/head/row")
@model_transaction
def head_row(layer: int, head: int, pos: int):
    """One head's attention row at token `pos` of the last inferred text, summed per display unit (the chips in the
    run tab); units after pos are null. Full attention: softmax weights. Linear attention: signed effective weights,
    absolute values summing to 1."""
    require_head(layer, head)
    h = _heads_for_infer() if pos >= 0 else None
    if not h or pos >= h["T"] or layer not in h["q"]:
        return {"units": None}
    row = rt.head_row(layer, head, pos)
    return {"units": [round(sum(row[i] for i in idx if i <= pos), 4) if idx[0] <= pos else None for _, idx in _infer["units"]]}


def _lens_base():
    """The lens used for pooled token summaries (steer when built, else logit), the vocab strings, and each token's
    base rate per layer: its share among all neurons' top-8 lens tokens of that layer."""
    st = rt.steer_index()
    lens = st if st is not None else rt.lens_index()
    v = rt.vocab_strings()
    key_src = "steer" if st is not None else "logit"
    if _idf.get("src") != key_src:
        L, N = lens["up"].shape[:2]
        df = np.stack([np.bincount(np.concatenate([lens["up"][l, :, :8].ravel(), lens["down"][l, :, :8].ravel()]),
                                   minlength=len(v)) for l in range(L)])
        _idf.update(src=key_src, base=((df + 1) / (2 * N)).astype(np.float32))  # [layer, token]
    return lens, v, _idf["base"], key_src


@app.get("/api/neuron/heads")
async def neuron_heads(layer: int, n: int):
    """The attention heads linked to a neuron by weights: z per head, per layer (runtime.neuron_heads), and the top
    heads per role, q / k / v / o (runtime.neuron_head_roles)."""
    require_neuron(layer, n)
    if off := _live_off():
        return off
    return {"layers": await asyncio.to_thread(rt.neuron_heads, layer, n),
            "roles": await asyncio.to_thread(rt.neuron_head_roles, layer, n)}


HEAD_SAMPLE = "Alice called Bob because she wanted to borrow his car. He said yes, and she drove it to the lake."


@app.post("/api/head/pattern")
async def head_pattern(req: Request):
    """One head's attention pattern on {text} (the run text, else a sample sentence), per display unit: rows are
    queries (a unit's last token), columns sum the weight over each earlier unit's tokens."""
    b = await req.json()
    layer, head = b.get("layer"), b.get("head")
    require_head(layer, head)
    if off := _live_off():
        return off
    text = b.get("text", HEAD_SAMPLE)
    ids, _, caps, units = await asyncio.to_thread(_capture_text, text, b.get("chat", False))
    A = (await asyncio.to_thread(rt.layer_patterns, layer, caps))[head]
    cols = np.stack([A[:, idx].sum(1) for _, idx in units], 1)  # [T, U]
    rows = [[round(float(x), 4) for x in cols[idx[-1], :u + 1]] for u, (_, idx) in enumerate(units)]
    return {"text": text, "tokens": [t for t, _ in units], "rows": rows,
            "full": ARCH["layer_types"][layer] == "full_attention"}


HEAD_TEXTS = [
    "Alice called Bob because she wanted to borrow his car. He said yes, and she drove it to the lake.",
    "def merge(a, b):\n    out = []\n    while a and b:\n        out.append(a.pop(0) if a[0] < b[0] else b.pop(0))\n    return out + a + b",
    "The committee, however, rejected the proposal; members said it was expensive, rushed, and unclear about who would pay.",
    "Ingredients: 2 cups flour, 1 tsp salt, 3 eggs, and a pinch of sugar. Mix the flour and salt, then add the eggs.",
    "我昨天去了北京，但是天气很冷，所以我们在酒店里待了一整天。",
    "\"Where are you going?\" asked the old man. \"To the market,\" said Mara, \"to sell the goat my brother raised.\"",
    "- Monday: 9:00 standup, 14:30 review with Sam\n- Tuesday: dentist at 11\n- Friday: release 2.4.1, then retro",
    "The mitochondria produce ATP through oxidative phosphorylation, which requires oxygen; without it, cells fall back on glycolysis.",
]
_hprof = {}


@model_transaction
def _head_profiles():
    """Where every head looks over HEAD_TEXTS, per display unit, for queries from the 4th unit on:
    dist: mean share of |weight| on self / the previous unit / units 2-5 back / further back / the first unit;
    neg: mean share of negative weight; src: per unit string, the |weight| it receives against a uniform pattern's;
    pairs: the strongest single reads more than one unit back (past the first unit)."""
    path = os.path.join(CACHE, "head_profiles.json")
    key = json.dumps([MODEL, REVISION, ARCH, HEAD_TEXTS], sort_keys=True)
    if _hprof.get("key") == key:
        return _hprof["data"]
    if os.path.exists(path):
        try:
            d = json.loads(Path(path).read_text(encoding="utf-8"))
        except (ValueError, UnicodeError):
            d = None  # interrupted cache writes are safe to rebuild
        if isinstance(d, dict) and d.get("key") == key:
            _hprof.update(key=key, data=d)
            return d
    acc = {}
    for t, text in enumerate(HEAD_TEXTS):
        ids = rt.tok(text).input_ids
        rt.full_activations(ids, True)
        caps = rt.heads
        units = rt.token_units(ids)
        toks = [s for s, _ in units]
        U = len(units)
        last = [idx[-1] for _, idx in units]
        for layer in sorted(caps["q"]):
            A = rt.layer_patterns(layer, caps)  # [H, T, T]
            A = np.stack([A[:, :, idx].sum(-1) for _, idx in units], -1)[:, last]  # [H, U, U]
            H = A.shape[0]
            tot = np.abs(A).sum(-1, keepdims=True).clip(1e-12)
            R = (A / tot)[:, 3:]  # rows 3.. [H, U-3, U]
            Ra = np.abs(R)
            qi = np.arange(3, U)
            j = np.arange(U)
            back = qi[:, None] - j[None]  # distance per (query, key)
            dist = np.stack([(Ra * (back == 0)).sum(-1), (Ra * (back == 1)).sum(-1),
                             (Ra * ((back >= 2) & (back <= 5) & (j[None] > 0))).sum(-1),
                             (Ra * ((back > 5) & (j[None] > 0))).sum(-1), Ra[..., 0]], -1).sum(1)  # [H, 5]
            neg = np.clip(-R, 0, None).sum(-1).sum(1)
            mask = (back >= 1) & (j[None] > 0)  # earlier units past the first
            recv = (Ra * mask).sum(1)  # [H, U]
            expv = (mask / (qi[:, None] + 1)).sum(0)  # [U]
            for h in range(H):
                a = acc.setdefault(f"{layer}/{h}", {"dist": np.zeros(5), "neg": 0.0, "n": 0, "src": {}, "pairs": []})
                a["dist"] += dist[h]; a["neg"] += float(neg[h]); a["n"] += len(qi)
                for u in range(1, U - 1):
                    s = a["src"].setdefault(toks[u].strip() or toks[u], [0.0, 0.0, 0])
                    s[0] += float(recv[h, u]); s[1] += float(expv[u]); s[2] += 1
                far = np.where((back > 1) & (j[None] > 0), R[h], 0)
                for r, c in zip(*np.unravel_index(np.argsort(-np.abs(far), None)[:6], far.shape)):
                    a["pairs"].append([round(float(far[r, c]), 3), t, int(qi[r]), int(c)])
    out = {}
    for k, a in acc.items():
        src = sorted(((s, r / e, r - e, n) for s, (r, e, n) in a["src"].items() if n >= 2 and r > e),
                     key=lambda x: -x[2])[:10]
        seen, pairs = set(), []
        for w, t, qu, ku in sorted(a["pairs"], key=lambda p: -abs(p[0])):
            if (t, qu, ku) in seen:
                continue
            seen.add((t, qu, ku))
            pairs.append([w, t, qu, ku])
            if len(pairs) == 8:
                break
        out[k] = {"dist": [round(float(x) / a["n"], 3) for x in a["dist"]], "neg": round(a["neg"] / a["n"], 3),
                  "src": [[s, round(l, 1)] for s, l, _, _ in src], "pairs": pairs}
    d = {"key": key, "texts": HEAD_TEXTS,
         "tokens": [[s for s, _ in rt.token_units(rt.tok(x).input_ids)] for x in HEAD_TEXTS], "heads": out}
    with open(path + ".tmp", "w", encoding="utf-8") as f:
        json.dump(d, f)
    os.replace(path + ".tmp", path)
    _hprof.update(key=key, data=d)
    return d


@app.get("/api/head/profile")
async def head_profile(layer: int, head: int):
    """One head's profile over the reference texts (_head_profiles), with each pair's query and key unit text and
    the text it comes from. The first call computes every head's profile."""
    require_head(layer, head)
    if off := _live_off():
        return off
    d = await asyncio.to_thread(_head_profiles)
    p = d["heads"].get(f"{layer}/{head}")
    if p is None:
        return {"error": "no such head"}
    pairs = [{"w": w, "text": d["texts"][t], "q": qu, "k": ku, "qt": d["tokens"][t][qu], "kt": d["tokens"][t][ku]}
             for w, t, qu, ku in p["pairs"]]
    return {"layer": layer, "head": head, "dist": p["dist"], "neg": p["neg"], "src": p["src"], "pairs": pairs}


@app.get("/api/head")
def head_info(layer: int, head: int, top: int = 24):
    """What one attention head reads and writes, from weights: its linked neurons (runtime.head_links) and their
    positive-pole lens tokens pooled the way the web summary pools a cone (weighted by z, ranked by lift over each
    layer's base rate)."""
    require_head(layer, head)
    if not 1 <= top <= 100:
        raise HTTPException(400, "top must be between 1 and 100")
    if off := _live_off():
        return off
    links = rt.head_links(layer, head)
    lens, v, base, src = _lens_base()

    def pool(nodes):
        acc = {}
        zmax = max([c["z"] for c in nodes] + [1e-8])
        for c in nodes:
            for t in lens["up"][c["layer"], c["n"], :8]:
                s = v[t]
                key = s.strip().lower()
                if not key or "\ufffd" in key:
                    continue
                a = acc.setdefault(key, {"n": 0, "w": 0.0, "base": 0.0, "forms": {}})
                a["n"] += 1
                a["w"] += c["z"] / zmax
                a["base"] += float(base[c["layer"], t])
                a["forms"][s.strip()] = a["forms"].get(s.strip(), 0) + 1
        for a in acc.values():
            lift = (a["n"] / max(1, len(nodes))) / (a["base"] / a["n"])
            a["score"] = a["w"] * np.log(lift) if lift > 1 else 0.0
        out = sorted((a for a in acc.values() if a["score"] > 0), key=lambda a: -a["score"])[:top]
        return [{"tok": max(a["forms"], key=a["forms"].get), "n": a["n"], "w": round(float(a["score"]), 2)} for a in out]

    for side in ("reads", "writes", "q", "k"):
        for c in links[side]:
            c["lens"] = [v[t] for t in lens["up"][c["layer"], c["n"], :5]]
    return {"layer": layer, "head": head, "full": ARCH["layer_types"][layer] == "full_attention", "src": src, "reads": links["reads"], "writes": links["writes"], "q": links["q"], "k": links["k"],
            "read_toks": pool(links["reads"]), "write_toks": pool(links["writes"]),
            "q_toks": pool(links["q"]), "k_toks": pool(links["k"])}


@app.get("/api/infer/paths")
def infer_paths(pos: int, top: int = 300, min: float = 1.0):
    """The circuit active at one token of the last inferred text: among the `top` neurons with the largest |score| there
    (at least `min`), every precomputed direct link whose two ends both fired. Same binary format as /api/web, with z
    signed by the push the writer's actual activation gives the reader (link sign x sign of the writer's score), so
    yellow / magenta read as "this firing pushed that one up / down"; hop is 1."""
    if "score" not in _infer or pos >= _infer["score"].shape[1]:
        return Response(b"", media_type="application/octet-stream", headers={"X-Web-Total": "0"})
    S = _infer["score"][:, pos, :]  # [L, N]
    flat = np.abs(S).ravel()
    cand = np.argpartition(-flat, min_k := builtins.min(top, flat.size - 1))[:min_k]
    cand = cand[flat[cand] >= min]
    N = S.shape[1]
    active = {(int(i // N), int(i % N)) for i in cand}
    ci = rt.con_index()
    rows = []
    for l, n in active:
        for i in range(ci["k"]):
            z = float(ci["down_z"][l, n, i])
            if z < -1e4:
                break
            t = (int(ci["down_layer"][l, n, i]), int(ci["down_n"][l, n, i]))
            if t in active:
                push = int(ci["down_sign"][l, n, i]) * (1 if S[l, n] > 0 else -1)
                rows.append((l, n, *t, round(z * 10) * push, 1))
    out = np.array(rows, np.int16).reshape(-1, 6)
    return Response(out.tobytes(), media_type="application/octet-stream",
                    headers={"X-Web-Total": str(len(out)), "X-Active": str(len(active))})


@app.get("/api/layout")
def layout(kind: str = "writes"):
    """Seriated grid layout: cell index (row * side + col) for every neuron, base64 int16, layer-major."""
    import base64
    if kind not in ("writes", "reads"):
        raise HTTPException(400, "layout kind must be writes or reads")
    path = os.path.join(CACHE, f"layout_{kind}.npz")
    if not os.path.exists(path):
        return {"available": False}
    cell = np.load(path)["cell"].astype(np.int16)
    return {"available": True, "shape": list(cell.shape), "cell": base64.b64encode(cell.tobytes()).decode()}


def cone_links(layer, n, k=2, zmin=15, cap=20000, first=None, hops=None):
    """Connection cone of one neuron: everything it writes into, then what those write into, out to the last layer;
    and everything that writes into it, back to layer 0. Each side only moves one way. The first hop takes all of the
    neuron's top `first` links (all when None), later hops each node's top k with z >= zmin, up to `hops` hops; each side keeps at most cap / 2 links.
    Rows: src layer, src neuron, dst layer, dst neuron, z * sign, hop (positive downstream, negative upstream)."""
    ci = rt.con_index()
    out = []
    for side, step in (("down", 1), ("up", -1)):
        zs, ls, ns, sg = ci[f"{side}_z"], ci[f"{side}_layer"], ci[f"{side}_n"], ci[f"{side}_sign"]
        front, seen, hop, start = [(layer, n)], {(layer, n)}, 1, len(out)
        while front and len(out) - start < cap // 2 and (not hops or hop <= hops):
            nxt = []
            for a, b in front:
                for i in range((first or ci["k"]) if hop == 1 else k):
                    z = float(zs[a, b, i])
                    if z < -1e4 or (hop > 1 and z < zmin):
                        break
                    t = (int(ls[a, b, i]), int(ns[a, b, i]))
                    src, dst = ((a, b), t) if side == "down" else (t, (a, b))
                    out.append((*src, *dst, z * int(sg[a, b, i]), hop * step))
                    if t not in seen:
                        seen.add(t)
                        nxt.append(t)
            front, hop = nxt, hop + 1
        del out[start + cap // 2:]
    return out


@app.get("/api/web")
def web(layer: int, n: int, first: int = 5, k: int = 2, zmin: float = 15, cap: int = 20000, hops: int = 0):
    """The cone for the map. Binary int16, 6 per link: src layer, src neuron, dst layer, dst neuron,
    round(10 * z) * sign, hop."""
    rows = np.array([(*r[:4], round(r[4] * 10), r[5]) for r in cone_links(layer, n, k, zmin, cap, first, hops or None)], np.int16).reshape(-1, 6)
    return Response(rows.tobytes(), media_type="application/octet-stream", headers={"X-Web-Total": str(len(rows))})


_idf = {}


@app.get("/api/web/summary")
def web_summary(layer: int, n: int, first: int = 5, k: int = 2, top: int = 30, src: str = "steer", hops: int = 0):
    """What the neuron's web says, in tokens. Each neuron in the cone is read on the pole the chain drives (signs
    multiplied along the path from the open neuron), and its steer (or logit) lens tokens are pooled, merged across
    case and leading space, and weighted by link z / max z times 0.8 per hop past the first, times log lift: the share
    of web neurons carrying the token over its share among all neurons of the same layers, so tokens a layer's neurons
    commonly carry (`(`, ` a` in early layers) sink and tokens the web carries no more often than chance drop out.
    Downstream gives
    `toward` (the driven pole) and `away` (the opposite pole); upstream gives `fed_by` (the pole that excites it) and
    `held_by` (the pole that inhibits it)."""
    st = rt.steer_index() if src == "steer" else None
    lens = st if st is not None else rt.lens_index()
    v = rt.vocab_strings()
    key_src = "steer" if st is not None else "logit"
    if _idf.get("src") != key_src:
        L, N = lens["up"].shape[:2]
        df = np.stack([np.bincount(np.concatenate([lens["up"][l, :, :8].ravel(), lens["down"][l, :, :8].ravel()]),
                                   minlength=len(v)) for l in range(L)])
        _idf.update(src=key_src, base=((df + 1) / (2 * N)).astype(np.float32))  # [layer, token]
    base = _idf["base"]
    sign, zmax = {(layer, n): 1}, 1.0
    links = cone_links(layer, n, k, 15, 20000, first, hops or None)
    for sl, sn, dl, dn, z, hop in links:
        zmax = max(zmax, abs(z))
    reach = {}
    for sl, sn, dl, dn, z, hop in links:
        near, far = ((sl, sn), (dl, dn)) if hop > 0 else ((dl, dn), (sl, sn))
        if far in sign or near not in sign:
            continue
        sign[far] = sign[near] * (1 if z > 0 else -1)
        reach[far] = (hop, abs(z))

    def pool(nodes, flip):
        acc = {}
        for (l, m), (hop, z) in nodes:
            w = z / zmax * 0.8 ** (abs(hop) - 1)
            pole = "up" if sign[(l, m)] * flip > 0 else "down"
            for t in lens[pole][l, m, :8]:
                s = v[t]
                key = s.strip().lower()
                if not key or "\ufffd" in key:
                    continue
                a = acc.setdefault(key, {"tok": s.strip(), "n": 0, "w": 0.0, "forms": {}})
                a["n"] += 1
                a["w"] += w
                a["base"] = a.get("base", 0.0) + float(base[l, t])
                a["forms"][s.strip()] = a["forms"].get(s.strip(), 0) + 1
        for a in acc.values():
            lift = (a["n"] / max(1, len(nodes))) / (a["base"] / a["n"])
            a["score"] = a["w"] * np.log(lift) if lift > 1 else 0.0
        out = sorted((a for a in acc.values() if a["score"] > 0), key=lambda a: -a["score"])[:top]
        return [{"tok": max(a["forms"], key=a["forms"].get), "n": a["n"], "w": round(float(a["score"]), 2)} for a in out]

    down = [(key, val) for key, val in reach.items() if val[0] > 0]
    up = [(key, val) for key, val in reach.items() if val[0] < 0]
    return {"src": "steer" if st is not None else "logit", "links": len(links),
            "down": {"neurons": len(down), "toward": pool(down, 1), "away": pool(down, -1)},
            "up": {"neurons": len(up), "fed_by": pool(up, 1), "held_by": pool(up, -1)}}


# ---------- Assistants: autointerp and chat ----------
# Each chat belongs to its selected CLI and resumes turn by turn. Its tools come from agent_mcp.py through the
# endpoints below and sends map actions back through /api/agent/ui into the chat's event stream.
AGENT_PROMPT = os.path.join(ROOT, "explorer", "agent_prompt.md")
AGENT_DIR = os.path.join(CACHE, "agent")  # conversations and research results belong to this model
_chats = {}
agent_pool = AgentPool()
agent_reaper = None
_act = {}


def act_range(layer, n):
    if "pos" not in _act and os.path.exists(ACT_SCALE):
        z = np.load(ACT_SCALE)
        _act.update(pos=z["pos"], neg=z["neg"], tokens=int(z["tokens"]))
    if "pos" not in _act:
        return None
    return {"act_max": round(float(_act["pos"][layer, n]), 3), "act_min": round(float(_act["neg"][layer, n]), 3),
            "over_tokens": _act["tokens"], "source": "FineWeb-Edu"}


@app.get("/api/agent/overview")
def agent_overview():
    runs = layer_runs()
    return {"model": MODEL, "revision": REVISION, "arch": ARCH, "layers_with_sweeps": sorted(runs),
            "named_neurons": len(names()), "live_model": not NO_MODEL}


@app.get("/api/agent/names")
def agent_names():
    return names()


@app.get("/api/agent/neuron")
async def agent_neuron(layer: int, n: int):
    lens = await asyncio.to_thread(rt.lens, layer, n, 12)
    con = await connections(layer, n, 24, 5)
    u = await asyncio.to_thread(unit, layer, n)
    out = {"neuron": f"L{layer} N{n}", "name": u.get("name", ""),
           "lens_up": lens["up"], "lens_down": lens["down"],
           "steer_up": lens.get("steer_up"), "steer_down": lens.get("steer_down"),
           "kl_up": lens.get("kl_up"), "kl_down": lens.get("kl_down"),
           "activation": act_range(layer, n),
           "sweep": {"rank": u.get("rank"), "n_ranked": u.get("n_ranked"), "stats": u.get("stats"),
                     "n_rollouts": len(u.get("rollouts", []))} if "run" in u else None}
    slim = lambda c: {"neuron": f"L{c['layer']} N{c['n']}", "z": c["z"], "sign": c["sign"], "steer_up": c.get("lens"),
                      "steer_down": c.get("lens_neg"), "words": c.get("words") or None, "name": c.get("name") or None}
    out["writes_into"] = [slim(c) for c in con["down"]]
    out["reads_from"] = [slim(c) for c in con["up"]]
    return out


@app.get("/api/agent/cone")
def agent_cone(layer: int, n: int, k: int = 2, limit: int = 120):
    links = cone_links(layer, n, k)
    best = {}
    for sl, sn, dl, dn, z, hop in links:
        key = (dl, dn) if hop > 0 else (sl, sn)
        if key not in best or abs(z) > abs(best[key][0]):
            best[key] = (z, hop if key not in best else best[key][1])
    v = rt.vocab_strings()
    idx = rt.steer_index() or rt.lens_index()
    nm = names()
    nodes = sorted(best.items(), key=lambda kv: (abs(kv[1][1]), -abs(kv[1][0])))[:limit]
    per_hop = {}
    for _, (_, hop) in best.items():
        per_hop[hop] = per_hop.get(hop, 0) + 1
    return {"links": len(links), "neurons": len(best), "per_hop": dict(sorted(per_hop.items())),
            "note": "weight-only direct-path links chained; paths past hop 1 are leads, not circuits",
            "nodes": [{"neuron": f"L{l} N{m}", "hop": hop, "z": round(abs(z), 1), "sign": 1 if z > 0 else -1,
                       "steer_up": [v[t] for t in idx["up"][l, m, :5]], "name": nm.get(f"L{l}/N{m}") or None}
                      for (l, m), (z, hop) in nodes]}


def _live_off():
    if NO_MODEL:
        return {"error": "the live model is off (server started with EXPLORER_NO_MODEL=1); suggest the test instead"}
    return None


@app.post("/api/agent/steer")
async def agent_steer(req: Request):
    """Steered rollouts for the assistant: one prompt, greedy, pushed up / unsteered / pushed down; whole texts at once."""
    b = await req.json()
    if off := _live_off():
        return off
    texts = ["", "", ""]
    # one neuron (layer, n) or several (neurons: [{layer, n, dose?, mode?}]), each defaulting to the call's dose/mode
    dose, mode = float(b.get("dose", 0.8)), b.get("mode", "add")
    items = b.get("neurons") or [{"layer": b["layer"], "n": b["n"]}]
    pushes = [(int(x["layer"]), int(x["n"]), float(x.get("dose", dose)), x.get("mode", mode)) for x in items]

    def work():
        for row, delta in rt.steer_multi(pushes, [[{"role": "user", "content": b["prompt"]}]] * 3, int(b.get("max_new", 150))):
            if row is not None:
                texts[row] += delta
    await asyncio.to_thread(work)
    return {"prompt": b["prompt"], "steered": [{"neuron": f"L{l} N{n}", "dose": d, "mode": m} for l, n, d, m in pushes],
            "up": texts[0], "baseline": texts[1], "down": texts[2]}


@app.post("/api/agent/activations")
async def agent_activations(req: Request):
    """The neuron's activation on each token of a text, for the assistant; compact [token, activation] pairs. With `neurons`
    ([{layer, n, dose?, mode?}]) those are pushed during the same pass (steering units)."""
    b = await req.json()
    if off := _live_off():
        return off
    # optional: other neurons pushed during the same pass, to test whether they drive this one
    # neurons: {layer, n, dose?, mode?}, or {layer, all: true, dose, mode: "mul"} for the whole layer's MLP;
    # heads: {layer, head (int or "all"), dose (a multiplier; 0 = ablate)}. Items with "head" in `neurons` count as heads.
    items, heads = b.get("neurons") or [], list(b.get("heads") or [])
    heads += [x for x in items if "head" in x]
    pushes = [(int(p["layer"]), None if p.get("all") else int(p["n"]), float(p.get("dose", 0 if p.get("all") else 0.8)),
               "mul" if p.get("all") else p.get("mode", "add")) for p in items if "head" not in p]
    hs = [(int(h["layer"]), None if h["head"] in ("all", None) else int(h["head"]), float(h.get("dose", 0))) for h in heads]
    for l, hd, _ in hs:
        if hd is not None and not 0 <= hd < rt.n_heads(l):
            return {"error": f"layer {l} has {rt.n_heads(l)} heads ({ARCH['layer_types'][l]})"}
    r = await asyncio.to_thread(rt.read, int(b["layer"]), int(b["n"]), b["text"], b.get("chat", False), pushes, hs)
    units = [[u["text"], round(u["act"], 3)] for u in r["units"]]
    top = sorted(units, key=lambda u: -abs(u[1]))[:10]
    return {"tokens": units, "strongest": top, "act_range": act_range(int(b["layer"]), int(b["n"])),
            "pushed": [{"neuron": f"L{l} " + ("MLP (all)" if n is None else f"N{n}"), "dose": d, "mode": m} for l, n, d, m in pushes],
            "heads": [{"layer": l, "head": "all" if hd is None else hd, "scale": sc} for l, hd, sc in hs]}


def _interventions(b):
    """pushes and heads from a request body, as activations takes them; (pushes, heads, error)."""
    items, heads = b.get("neurons") or [], list(b.get("heads") or [])
    heads += [x for x in items if "head" in x]
    pushes = [(int(p["layer"]), None if p.get("all") else int(p["n"]), float(p.get("dose", 0 if p.get("all") else 0.8)),
               "mul" if p.get("all") else p.get("mode", "add")) for p in items if "head" not in p]
    hs = [(int(h["layer"]), None if h["head"] in ("all", None) else int(h["head"]), float(h.get("dose", 0))) for h in heads]
    for l, hd, _ in hs:
        if hd is not None and not 0 <= hd < rt.n_heads(l):
            return pushes, hs, f"layer {l} has {rt.n_heads(l)} heads ({ARCH['layer_types'][l]})"
    return pushes, hs, None


@model_transaction
def _capture_text(text, chat):
    """Runs a text with head capture: (ids, activations [L, T, N], captures, display units)."""
    if not isinstance(text, str) or not text.strip() or len(text) > 100_000:
        raise HTTPException(400, "text must contain 1 to 100,000 characters")
    if not isinstance(chat, bool):
        raise HTTPException(400, "chat must be true or false")
    ids = (rt.chat_ids(text) if chat else rt.tok(text).input_ids)[:MAX_INFER_TOKENS]
    if not ids:
        raise HTTPException(400, "text contains no tokens")
    acts = rt.full_activations(ids, True)
    return ids, acts, rt.heads, rt.token_units(ids)


def _find_unit(units, token):
    """The first display unit containing `token` (exact, then case- and space-insensitive); None if absent."""
    if not token:
        return None
    for match in (lambda u: token in u, lambda u: token.strip().lower() in u.lower()):
        for k, (u, _) in enumerate(units):
            if match(u):
                return k
    return None


@app.post("/api/agent/attention")
async def agent_attention(req: Request):
    """For Claude: one head's attention on a text. Body {layer, head, text, token?, chat?}. At the query token (the
    first containing `token`, else the last) the weight on each earlier token (summed per display unit; linear
    attention is signed, absolute values summing to 1), and the strongest single reads anywhere in the text."""
    b = await req.json()
    if off := _live_off():
        return off
    layer, head = b.get("layer"), b.get("head")
    require_head(layer, head)
    ids, _, caps, units = await asyncio.to_thread(_capture_text, b["text"], b.get("chat", False))
    toks = [u for u, _ in units]
    qu = query_unit(b, units)
    qu = len(units) - 1 if qu is None else qu
    A = await asyncio.to_thread(rt.layer_patterns, layer, caps)
    A = A[head]
    U = np.stack([A[:, idx].sum(1) for _, idx in units], 1)[[idx[-1] for _, idx in units]]  # [U, U]
    row = [[toks[j], round(float(U[qu, j]), 3)] for j in range(qu + 1)]
    pairs = [(float(U[i, j]), i, j) for i in range(len(units)) for j in range(1, i)]
    pairs.sort(key=lambda x: -abs(x[0]))
    return {"layer": layer, "head": head, "kind": ARCH["layer_types"][layer], "tokens": toks,
            "query": {"index": qu, "token": toks[qu]}, "row": row,
            "top_sources": sorted(row, key=lambda r: -abs(r[1]))[:8],
            "first_token_weight": round(float(np.abs(U[1:, 0]).mean()), 3) if len(units) > 1 else None,
            "strongest_reads": [{"query": toks[i], "source": toks[j], "weight": round(w, 3), "back": i - j}
                                for w, i, j in pairs[:12]]}


@app.post("/api/agent/attn_drive")
async def agent_attn_drive(req: Request):
    """For Claude: which attention heads drive a neuron at one token of a text, and which earlier tokens they read
    from. Body {layer, n, text, token?, chat?, top?}. The token is the first containing `token`, else where the neuron
    fires hardest. Contributions are the neuron's activation linearised at that token (runtime.attn_drive)."""
    b = await req.json()
    if off := _live_off():
        return off
    layer, n, top = b.get("layer"), b.get("n"), b.get("top", 8)
    require_neuron(layer, n)
    if isinstance(top, bool) or not isinstance(top, int) or not 1 <= top <= 32:
        raise HTTPException(400, "top must be between 1 and 32")
    ids, acts, caps, units = await asyncio.to_thread(_capture_text, b["text"], b.get("chat", False))
    toks = [u for u, _ in units]
    unit_of = {i: k for k, (_, idx) in enumerate(units) for i in idx}
    k = query_unit(b, units)
    if k is None:
        pos = int(np.abs(acts[layer, 1:, n]).argmax()) + 1 if len(ids) > 1 else 0
        k = unit_of[pos]
    pos = units[k][1][-1]
    d = await asyncio.to_thread(rt.attn_drive, layer, n, pos, caps, top)
    attn = sum(c for _, _, c in d["heads"])
    heads = []
    for l, h, c in sorted(d["heads"], key=lambda r: -abs(r[2]))[:max(top, 12)]:
        row = {"head": f"L{l} h{h}", "contribution": round(c, 4), "share": round(c / d["total"], 3) if d["total"] else None}
        if (l, h) in d["src"]:
            src = d["src"][(l, h)]
            per = {}
            for i, v in enumerate(src):
                per[unit_of[i]] = per.get(unit_of[i], 0.0) + v
            row["from"] = [[toks[u], round(v, 4)] for u, v in sorted(per.items(), key=lambda x: -abs(x[1]))[:5]]
        heads.append(row)
    return {"neuron": f"L{layer} N{n}", "token": toks[k], "index": k, "act": round(d["act"], 4),
            "act_range": act_range(layer, n), "linearised_total": round(d["total"], 4),
            "attention_sum": round(attn, 4), "rest": round(d["total"] - attn, 4), "heads": heads}


@app.post("/api/agent/logprobs")
async def agent_logprobs(req: Request):
    """For the assistant: the next token's distribution after a text. Body {text, chat?, prefix?, k?, targets?: [str],
    neurons?, heads?} (neurons / heads as in /api/agent/activations). Without an intervention: {top, targets}. With
    one: baseline and intervened {top, targets}, kl (nats, baseline to intervened) and the tokens that gained and lost
    the most probability over the whole vocabulary."""
    b = await req.json()
    if off := _live_off():
        return off
    pushes, hs, err = _interventions(b)
    if err:
        return {"error": err}
    k = builtins.min(int(b.get("k", 15)), 100)
    base, alt = await asyncio.to_thread(rt.next_logprobs, b["text"], b.get("chat", True), b.get("prefix", ""), pushes, hs)
    dec = lambda i: rt.tok.decode([int(i)])
    targets = []
    for t in b.get("targets") or []:
        tid = rt.tok(t, add_special_tokens=False).input_ids
        if tid:
            targets.append((t, tid[0], len(tid) > 1))

    def view(lp):
        v, i = lp.topk(k)
        return {"top": [[dec(t), round(float(x), 3)] for x, t in zip(v, i)],
                "targets": [{"text": t, "token": dec(tid), "logprob": round(float(lp[tid]), 3),
                             **({"first_token_only": True} if multi else {})} for t, tid, multi in targets]}
    if alt is None:
        return view(base)
    d = alt.exp() - base.exp()  # ranked by probability gained or lost, so the far tail's large log ratios stay out
    up, down = d.topk(12), (-d).topk(12)
    row = lambda i: [dec(i), round(float(base[i]), 2), round(float(alt[i]), 2)]
    return {"baseline": view(base), "intervened": view(alt),
            "kl": round(float((base.exp() * (base - alt)).sum()), 4),
            "rose": [row(i) for i in up.indices], "fell": [row(i) for i in down.indices],
            "rows_are": "[token, baseline logprob, intervened logprob]",
            "pushed": [{"neuron": f"L{l} " + ("MLP (all)" if n is None else f"N{n}"), "dose": dd, "mode": m} for l, n, dd, m in pushes],
            "heads": [{"layer": l, "head": "all" if hd is None else hd, "scale": sc} for l, hd, sc in hs]}


@app.post("/api/agent/compare")
async def agent_compare(req: Request):
    """For the assistant: many neurons read across several texts, one forward pass per text. Body {neurons: [{layer, n}],
    texts: [text | {label, text}], chat?}. Per neuron and text: the strongest positive and negative activation with
    its token, and the peak score (activation over the neuron's usual extreme; position 0, the sink, left out)."""
    b = await req.json()
    if off := _live_off():
        return off
    neurons = [(int(x["layer"]), int(x["n"])) for x in b.get("neurons") or []][:300]
    texts = [(t.get("label") or f"t{i + 1}", t["text"]) if isinstance(t, dict) else (f"t{i + 1}", t)
             for i, t in enumerate((b.get("texts") or [])[:24])]
    if not neurons or not texts:
        return {"error": "give neurons [{layer, n}] and texts [text or {label, text}]"}
    nm = names()
    rows = {nk: {"neuron": f"L{nk[0]} N{nk[1]}", "name": nm.get(f"L{nk[0]}/N{nk[1]}") or None,
                 "act_range": act_range(*nk), "by_text": {}} for nk in neurons}
    for label, text in texts:
        ids, acts, score = await score_text(text, b.get("chat", False))
        toks = [rt.tok.decode([i]) for i in ids]
        lo = 1 if len(ids) > 1 else 0
        for l, m in neurons:
            a, sc = acts[l, lo:, m], score[l, lo:, m]
            hi_i, lo_i, pk = int(a.argmax()), int(a.argmin()), int(np.abs(sc).argmax())
            rows[(l, m)]["by_text"][label] = {"max": [round(float(a[hi_i]), 2), toks[hi_i + lo]],
                                             "min": [round(float(a[lo_i]), 2), toks[lo_i + lo]],
                                             "peak_score": round(float(sc[pk]), 2)}
    return {"texts": [{"label": lb, "chars": len(t)} for lb, t in texts], "neurons": list(rows.values())}


@app.post("/api/agent/fires")
async def agent_fires(req: Request):
    """For Claude: run text through the model and list the neurons firing hardest at one token (the first whose text
    contains `token`, else the token where any neuron fires hardest; `at` picks a token by index into `tokens`,
    negative from the end). Leaves the person's paste box alone."""
    b = await req.json()
    if off := _live_off():
        return off
    ids, acts, score = await score_text(b["text"], b.get("chat", False), heads=True)
    toks = [rt.tok.decode([i]) for i in ids]
    want = b.get("token")
    pos = int(b["at"]) % len(toks) if b.get("at") is not None else next((i for i, t in enumerate(toks) if want and want in t), None)
    if pos is None:
        pos = int(np.abs(score).max(axis=(0, 2)).argmax())
    S = score[:, pos, :]
    if b.get("layers"):
        lo, hi = b["layers"]
        S = S.copy(); S[:lo] = 0; S[hi + 1:] = 0
    flat = np.argsort(-np.abs(S).ravel())[: int(b.get("limit", 30))]
    st = rt.steer_index() or rt.lens_index()
    v, nm, N = rt.vocab_strings(), names(), S.shape[1]
    res = []
    for i in flat:
        l, n = int(i // N), int(i % N)
        sg = "+" if S[l, n] > 0 else "-"
        res.append({"neuron": f"L{l} N{n}", "pole": sg, "score": round(float(abs(S[l, n])), 2),
                    "act": round(float(acts[l, pos, n]), 3), "name": nm.get(f"L{l}/N{n}") or None,
                    "steer": [v[t] for t in st["up" if sg == "+" else "down"][l, n, :6]]})
    return {"tokens": toks, "at": pos, "token": toks[pos],
            "note": "score = activation / the neuron's typical extreme on that side; 1 = as strong as its usual max",
            "neurons": res}




ui_bridge = UiBridge()


@app.get("/api/agent/ui/events")
async def agent_ui_events(browser: str):
    # A dedicated connection also works when no assistant generation is active.
    try:
        client = ui_bridge.connect(browser)
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=400)

    async def events():
        try:
            yield 'data: {"connected": true}\n\n'
            while True:
                try:
                    command = await asyncio.wait_for(client["queue"].get(), 10)
                    yield f"data: {json.dumps(command)}\n\n"
                except asyncio.TimeoutError:
                    yield ': heartbeat\n\n'
        finally:
            ui_bridge.disconnect(browser, client)

    return StreamingResponse(events(), media_type="text/event-stream", headers={"Cache-Control": "no-store"})


@app.post("/api/agent/ui/result")
async def agent_ui_result(req: Request):
    b = await req.json()
    if not isinstance(b, dict):
        return JSONResponse({"error": "UI result must be an object"}, status_code=400)
    try:
        if not ui_bridge.complete(b.get("browser"), b.get("id"), b.get("result")):
            return JSONResponse({"error": "UI command is no longer pending"}, status_code=410)
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=400)
    return {"ok": True}


@app.post("/api/agent/ui")
async def agent_ui(req: Request):
    b = await req.json()
    if not isinstance(b, dict) or not isinstance(b.get("action"), str):
        return JSONResponse({"error": "UI command requires an action string"}, status_code=400)
    if b.get("action") in UI_COMMAND_FIELDS:
        try:
            command = validate_ui_command(b, ARCH)
            c = _chats.get(b.get("chat"))
            browser = b.get("browser_id") or (c.get("browser") if c else None)
            return await ui_bridge.command(command, browser, command.get("timeout_seconds", 120 if command['action'] == 'head' else 20))
        except ValueError as e:
            return {"error": str(e)}
    c = _chats.get(b.pop("chat", ""))
    if c is None or "queue" not in c:
        return {"ok": False, "error": "no such chat"}
    c["queue"].put_nowait(("ui", b))
    return {"ok": True, "note": "shown in the explorer"}


def active_research_chat(body):
    c = _chats.get(body.get("chat"))
    if not c or "queue" not in c or c["cancel"].is_set():
        raise ValueError("research tools require an active explorer conversation")
    return c


@app.post("/api/agent/files")
async def agent_files(req: Request):
    body = await req.json()
    try:
        c = active_research_chat(body)
        return await asyncio.to_thread(file_operation, ROOT, c["access"], body["operation"],
                                       body.get("path", "."), body.get("content"))
    except (ValueError, KeyError, OSError) as e:
        return JSONResponse({"error": str(e)}, status_code=400)


@app.post("/api/agent/shell")
async def agent_shell(req: Request):
    import uuid
    body = await req.json()
    try:
        c = active_research_chat(body)
        command = body["command"]
        if not isinstance(command, str) or not command.strip() or len(command) > 32_000:
            raise ValueError("provide a shell command up to 32,000 characters")
        cwd = scoped_path(ROOT, c["access"], body.get("cwd", "."))
        if not cwd.is_dir():
            raise ValueError("shell starting directory must exist")
        timeout = body.get("timeout", 120)
        if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not 1 <= timeout <= 300:
            raise ValueError("shell timeout must be between 1 and 300 seconds")
    except (ValueError, KeyError, OSError) as e:
        return JSONResponse({"error": str(e)}, status_code=400)
    aid = uuid.uuid4().hex
    approval = asyncio.get_running_loop().create_future()
    approvals, cancel = c["approvals"], c["cancel"]
    approvals[aid] = approval
    c["queue"].put_nowait(("event", {"t": "approval", "id": aid, "command": command, "cwd": str(cwd)}))
    try:
        try:
            allowed = await asyncio.wait_for(approval, 600)
        except asyncio.TimeoutError:
            return {"error": "shell approval expired; no command was run"}
        if not allowed or cancel.is_set():
            return {"error": "shell command declined or conversation stopped; no command was run"}
        return await run_shell(command, cwd, timeout, os.path.join(AGENT_DIR, "work"), cancel)
    except (ValueError, OSError) as e:
        return {"error": str(e)}
    finally:
        approvals.pop(aid, None)


@app.post("/api/agent/approval")
async def agent_approval(req: Request):
    body = await req.json()
    c = _chats.get(body.get("chat"))
    pending = c.get("approvals", {}).get(body.get("id")) if c else None
    if pending is None or pending.done() or "queue" not in c:
        return JSONResponse({"error": "this approval is no longer active"}, status_code=409)
    if not isinstance(body.get("allow"), bool):
        return JSONResponse({"error": "approval must be true or false"}, status_code=400)
    pending.set_result(body["allow"])
    return {"ok": True}


UPLOADS = os.path.join(AGENT_DIR, "uploads")


@app.post("/api/agent/upload")
async def agent_upload(req: Request):
    """Store an explicit attachment; malformed uploads return a useful client error."""
    try:
        return await asyncio.to_thread(store_upload, UPLOADS, await req.json())
    except UploadTooLarge as e:
        return JSONResponse({"error": str(e)}, status_code=413)
    except (ValueError, TypeError, OSError) as e:
        return JSONResponse({"error": str(e)}, status_code=400)


def attachment_input(fid, provider="codex"):
    return read_attachment(UPLOADS, fid, provider)


AGENT_METHOD = os.path.join(ROOT, "explorer", "agent_methodology.md")
AGENT_LOCAL = os.path.join(ROOT, "explorer", "agent_prompt.local.md")  # this machine's own additions, untracked


def agent_prompt_file():
    """agent_prompt.md, then agent_methodology.md and agent_prompt.local.md when present, with {ROOT} filled in as
    this checkout's path, written beside the chat's working files."""
    text = Path(AGENT_PROMPT).read_text(encoding="utf-8")
    for extra in (AGENT_METHOD, AGENT_LOCAL):
        if os.path.exists(extra):
            text = text.rstrip() + "\n\n" + Path(extra).read_text(encoding="utf-8")
    text = text.replace("{ROOT}", ROOT).replace("{PYTHON}", sys.executable)
    text += (f"\n\nActive model: {MODEL}; revision: {REVISION or 'default'}. "
             "Use overview for actual architecture dimensions. Methodology examples describe Qwen3.5-4B; "
             "neuron identities and observations do not transfer between models.\n")
    text = text.replace("http://127.0.0.1:8791", f"http://127.0.0.1:{PORT}")
    out = os.path.join(AGENT_DIR, "system_prompt.md")
    if not os.path.exists(out) or Path(out).read_text(encoding="utf-8") != text:
        Path(out).write_text(text, encoding="utf-8")
    return out


def agent_session(cid):
    """Only explorer-owned IDs may resume threads; never accept arbitrary CLI session IDs."""
    import uuid
    if not isinstance(cid, str) or str(uuid.UUID(cid)) != cid:
        raise ValueError("invalid explorer chat id; start a new conversation")
    folder = os.path.join(AGENT_DIR, "sessions")
    os.makedirs(folder, exist_ok=True)
    path = os.path.join(folder, f"{cid}.json")
    return path, json.loads(Path(path).read_text(encoding="utf-8")) if os.path.exists(path) else {}


def save_agent_session(path, session):
    with open(path + ".tmp", "w") as f:
        json.dump(session, f)
    os.replace(path + ".tmp", path)


def agent_provider(body, session):
    provider = body.get("provider", "claude")
    if provider not in ("codex", "claude"):
        raise ValueError("choose Codex or Claude")
    if session and session.get("provider", "codex") != provider:
        raise ValueError("this conversation belongs to a different assistant; switch providers or start a new chat")
    return provider


def selected_agent_session(body, cid):
    path, session = agent_session(cid)
    if body.get("chat") and body.get("provider") == "claude" and not session:
        session = legacy_session(cid, AGENT_DIR) or {}
        if session:
            save_agent_session(path, session)
    return path, session, agent_provider(body, session)


def agent_client(provider, queue):
    return (ClaudeClient if provider == "claude" else CodexClient)(AGENT_DIR, queue)


async def stop_agent_turn(c):
    task = c.get("stop_task")
    if task is None or task.done():
        c["stopping"] = True
        targets = {c.get(key) for key in ("job", "active_task")}

        async def stop():
            try:
                for target in targets:
                    if target and not target.done():
                        target.cancel()
                        await asyncio.gather(target, return_exceptions=True)
                if c.get("client_key"):
                    await agent_pool.discard(c["client_key"])
            finally:
                c.pop("stopping", None)
                c.pop("stop_task", None)

        c["stop_task"] = task = asyncio.create_task(stop())
    # Repeated Stop requests share cleanup; disconnecting its caller must not
    # cancel process termination or leave a half-closed reusable client.
    await asyncio.shield(task)


@app.post("/api/agent/rewind")
async def agent_rewind(req: Request):
    """Rewind only the selected provider's latest explorer-owned turn."""
    b = await req.json()
    try:
        path, session, provider = selected_agent_session(b, b["chat"])
    except (ValueError, KeyError, TypeError) as e:
        return JSONResponse({"error": str(e) or "invalid explorer chat id"}, status_code=400)
    c = _chats.setdefault(b["chat"], {"lock": asyncio.Lock()})
    await stop_agent_turn(c)
    async with c["lock"]:
        _, session = agent_session(b["chat"])
        if not session.get("last_turn"):
            return {"ok": True, "cut": False}
        if (b.get("text") or "").strip() != session.get("last_message", "").strip():
            return JSONResponse({"error": "latest turn changed; reload the conversation"}, status_code=409)
        client = agent_client(provider, asyncio.Queue())
        try:
            await client.start()
            await client.open_thread(ROOT, b["chat"], PORT, Path(agent_prompt_file()).read_text(encoding="utf-8"), session["thread"])
            if provider == "claude":
                await client.rewind(session["last_message"])
            else:
                await client.call("thread/revert", {"threadId": session["thread"], "beforeTurnId": session["last_turn"]})
            session.pop("last_turn", None)
            session.pop("last_message", None)
            save_agent_session(path, session)
            chat_journal(b["chat"], c).rewind()
        except (AgentError, OSError) as e:
            return JSONResponse({"error": str(e)}, status_code=502)
        finally:
            await client.close()
    return {"ok": True, "cut": True}


@app.post("/api/agent/chat")
async def agent_chat(req: Request):
    return await prepare_agent_turn(req)


@app.post("/api/agent/send")
async def agent_send(req: Request):
    return await prepare_agent_turn(req, background=True)


async def prepare_agent_turn(req, background=False):
    """Stream the selected assistant's text, tools, and explorer UI actions as NDJSON."""
    import uuid
    try:
        b = await req.json()
        if not isinstance(b, dict):
            raise ValueError("assistant request must be an object")
        cid = b.get("chat") or str(uuid.uuid4())
        path, session, provider = selected_agent_session(b, cid)
        if b.get("chat") and not session:
            raise ValueError("saved chat not found; start a new conversation")
        original = b["message"]
        if not isinstance(original, str) or not original.strip() or len(original) > 200_000:
            raise ValueError("provide a message up to 200,000 characters")
        if not isinstance(b.get("shown", original), str):
            raise ValueError("shown message must be text")
        for key in ("attachments", "attachment_names"):
            value = b.get(key) or []
            if not isinstance(value, list) or len(value) > 50 or any(not isinstance(x, str) for x in value):
                raise ValueError(f"{key} must contain up to 50 strings")
        access = b.get("access", "project")
        if access not in SCOPES:
            raise ValueError("choose project or home file access")
        content = [{"type": "text", "text": original}]
        if b.get("layer") is not None:
            if b.get("head") is not None:
                validate_head(ARCH, b["layer"], b["head"])
                selected = f"L{b['layer']} h{b['head']}"
            else:
                validate_ui_command({"action": "select", "layer": b["layer"], "n": b["n"]}, ARCH)
                selected = f"L{b['layer']} N{b['n']}"
            content[0]["text"] = f"[The person has {selected} open in the explorer.]\n\n{original}"
        content += [await asyncio.to_thread(attachment_input, fid, provider) for fid in b.get("attachments") or []]
    except (ValueError, KeyError, TypeError, OSError) as e:
        return JSONResponse({"error": str(e)}, status_code=400)
    c = _chats.setdefault(cid, {"lock": asyncio.Lock()})
    if busy_chat(c) or c.get("recovering"):
        return JSONResponse({"error": "this conversation is already running or restoring; stop it or wait"}, status_code=409)

    async def events():
        async with c["lock"]:
            c["active_task"] = asyncio.current_task()
            c["queue"] = q = asyncio.Queue()
            c.update(access=access, cancel=asyncio.Event(), approvals={}, browser=b.get("browser"))
            client, reusable = None, False
            try:
                _, saved = agent_session(cid)
                instructions = Path(agent_prompt_file()).read_text(encoding="utf-8")
                instructions += f"\n\nCurrent file-tool scope: {access}. Use list_files, read_file, write_file and run_shell for research scripts. Native shell/file tools are disabled in both providers. File tools are restricted to the project{' and your home folder' if access == 'home' else ''}. Every run_shell command requires the person's approval and runs with their user account, not inside a filesystem sandbox. Never suggest that a shell starting directory restricts what a command can access. Keep scratch work under {AGENT_DIR}/work."
                async def connect(client):
                    await client.start()
                    return await client.open_thread(ROOT, cid, PORT, instructions, saved.get("thread"))

                if background:
                    c["client_key"] = cid
                    policy = (provider, access, instructions, os.environ.get(f"EXPLORER_{provider.upper()}_MODEL"),
                              os.environ.get(f"EXPLORER_{provider.upper()}_BIN"))
                    lease = await agent_pool.acquire(cid, policy, lambda: agent_client(provider, q), connect)
                    client, thread = lease["client"], lease["thread"]
                    c["queue"] = q = client.queue
                else:
                    client = agent_client(provider, q)
                    thread = await connect(client)
                saved.update(thread=thread, provider=provider, access=access)
                save_agent_session(path, saved)
                yield json.dumps({"t": "chat", "chat": cid, "provider": provider}) + "\n"
                result = await client.call("turn/start", {"threadId": thread, "input": content})
                client.turn = result["turn"]["id"]
                saved.update(last_turn=client.turn, last_message=original)
                save_agent_session(path, saved)
                while True:
                    kind, item = await q.get()
                    if kind == "ui":
                        yield json.dumps({"t": "ui", **item}) + "\n"
                    elif kind == "closed":
                        raise AgentError(f"{provider.title()} stopped unexpectedly. Check its CLI installation and login.")
                    elif kind == "event":
                        if item["t"] == "done":
                            client.turn = None
                            reusable = not item.get("error") and item.get("status") not in ("failed", "interrupted", "cancelled")
                            if item.get("error"):
                                yield json.dumps({"t": "error", "error": item["error"]}) + "\n"
                            yield json.dumps(item) + "\n"
                            break
                        yield json.dumps(item) + "\n"
            except (AgentError, OSError) as e:
                yield json.dumps({"t": "error", "error": str(e)}) + "\n"
            finally:
                c["cancel"].set()
                for pending in c["approvals"].values():
                    if not pending.done():
                        pending.set_result(False)
                # Starlette cancels the stream's AnyIO scope on disconnect. Finish
                # interrupt/shutdown before another request takes this chat's lock.
                try:
                    with CancelScope(shield=True):
                        if client is not None:
                            if background:
                                await agent_pool.release(cid, client, reusable)
                            else:
                                await client.close()
                finally:
                    c.pop("active_task", None)
                    c.pop("queue", None)

    if not background:
        return StreamingResponse(events(), media_type="application/x-ndjson")
    journal = chat_journal(cid, c)
    start = journal.cursor
    session.update(provider=provider, access=access, title=session.get("title") or original[:100], updated=time.time())
    save_agent_session(path, session)
    journal.append({"t": "user", "text": original, "shown": b.get("shown", original),
                    "attachments": [{"id": fid, "name": (b.get("attachment_names") or [])[i] if i < len(b.get("attachment_names") or []) else "attachment"}
                                    for i, fid in enumerate(b.get("attachments") or [])]})

    async def run():
        completed = None
        try:
            async for line in events():
                event = json.loads(line)
                if event["t"] == "done":
                    completed = event
                else:
                    journal.append(event)
        except asyncio.CancelledError:
            completed = None
            journal.append({"t": "stopped"})
            raise
        except Exception:
            journal.append({"t": "error", "error": "The assistant failed unexpectedly. Check the server log."})
            import traceback
            traceback.print_exc()
        finally:
            _, saved = agent_session(cid)
            saved["updated"] = time.time()
            save_agent_session(path, saved)
            # Publish completion only after provider/process cleanup. Reconnecting
            # readers can then finish and send their next turn immediately.
            journal.append(completed or {"t": "done", "status": "interrupted"})

    c["job"] = asyncio.create_task(run())
    return {"chat": cid, "provider": provider, "cursor": start}


def busy_chat(c):
    return bool(c.get("stopping")) or any(c.get(key) and not c[key].done() for key in ("job", "active_task"))


def chat_journal(cid, c):
    if "journal" not in c:
        c["journal"] = Journal(AGENT_DIR, cid)
        events = c["journal"].events
        if events and events[-1]["t"] != "done":
            c["journal"].append({"t": "error", "error": "Server restarted before this reply completed."})
            c["journal"].append({"t": "done", "status": "interrupted"})
    return c["journal"]


def owned_chat(cid):
    _, session = agent_session(cid)
    if not session:
        raise ValueError("saved explorer conversation not found")
    c = _chats.setdefault(cid, {"lock": asyncio.Lock()})
    return session, c, chat_journal(cid, c)


@app.get("/api/agent/chats")
async def agent_chats():
    result = []
    for path in Path(AGENT_DIR, "sessions").glob("*.json"):
        try:
            _, session = agent_session(path.stem)
            result.append({"chat": path.stem, "provider": session.get("provider", "codex"),
                           "title": session.get("title") or session.get("last_message") or "Conversation",
                           "updated": session.get("updated", path.stat().st_mtime),
                           "running": busy_chat(_chats.get(path.stem, {}))})
        except (ValueError, OSError, TypeError):
            continue
    return {"chats": sorted(result, key=lambda c: c["updated"], reverse=True)}


@app.get("/api/agent/history")
async def agent_history(chat: str):
    try:
        session, c, journal = owned_chat(chat)
        history_error = None
        if not journal.cursor and session.get("thread") and not busy_chat(c):
            async with c["lock"]:
                if not journal.cursor and not busy_chat(c):
                    c["recovering"] = True
                    client = agent_client(session.get("provider", "codex"), asyncio.Queue())
                    try:
                        await client.start()
                        for event in await client.history(session["thread"]):
                            journal.append(event)
                    except (AgentError, OSError) as e:
                        history_error = str(e)
                    finally:
                        with CancelScope(shield=True):
                            await client.close()
                        c.pop("recovering", None)
        pending = [aid for aid, future in c.get("approvals", {}).items() if not future.done()]
        return {"chat": chat, "provider": session.get("provider", "codex"), "access": session.get("access", "project"),
                "events": journal.events, "cursor": journal.cursor, "running": busy_chat(c), "approvals": pending,
                "history_error": history_error}
    except (ValueError, OSError) as e:
        return JSONResponse({"error": str(e)}, status_code=400)


@app.post("/api/agent/history/import")
async def agent_import_history(req: Request):
    """Migrate old browser-only display history as text; never import HTML or CLI session IDs."""
    try:
        b = await req.json()
        _, c, journal = owned_chat(b["chat"])
        if busy_chat(c) or journal.cursor:
            return JSONResponse({"error": "conversation already has server history"}, status_code=409)
        records = b["messages"]
        if not isinstance(records, list) or len(json.dumps(records)) > 2_000_000:
            raise ValueError("history must be a list up to 2 MB")
        for record in records:
            if not isinstance(record, dict) or record.get("t") not in ("user", "text") or not isinstance(record.get("text"), str):
                raise ValueError("history requires user or text records")
        for record in records:
            journal.append({"t": record["t"], "text": record["text"]})
        if records:
            journal.append({"t": "done", "status": "completed"})
        return {"ok": True}
    except (KeyError, ValueError, TypeError, OSError) as e:
        return JSONResponse({"error": str(e)}, status_code=400)


@app.get("/api/agent/events")
async def agent_events(chat: str, after: int = 0):
    try:
        _, c, journal = owned_chat(chat)
        if not 0 <= after <= journal.cursor:
            raise ValueError("event cursor is out of range; reload conversation history")
    except (ValueError, OSError) as e:
        return JSONResponse({"error": str(e)}, status_code=400)

    async def follow():
        cursor = after
        while True:
            batch = journal.events[cursor:]
            for event in batch:
                yield json.dumps(event) + "\n"
                cursor = event["seq"]
            if not busy_chat(c):
                break
            if not batch:
                yield "\n"  # heartbeat; disconnecting a listener does not cancel the job
            await asyncio.sleep(0.25)

    return StreamingResponse(follow(), media_type="application/x-ndjson", headers={"Cache-Control": "no-store"})


@app.post("/api/agent/interrupt")
async def agent_interrupt(req: Request):
    try:
        b = await req.json()
        _, c, _ = owned_chat(b["chat"])
        await stop_agent_turn(c)
        return {"ok": True}
    except (KeyError, ValueError, TypeError) as e:
        return JSONResponse({"error": str(e)}, status_code=400)


@app.on_event("startup")
async def start_agent_reaper():
    global agent_reaper

    async def reap():
        while True:
            await asyncio.sleep(30)
            await agent_pool.reap()

    agent_reaper = asyncio.create_task(reap())


@app.on_event("shutdown")
async def stop_agent_jobs():
    if agent_reaper:
        agent_reaper.cancel()
        await asyncio.gather(agent_reaper, return_exceptions=True)
    await asyncio.gather(*(stop_agent_turn(c) for c in _chats.values()))
    await agent_pool.close()


@app.get("/api/status")
def status():
    return {"status": rt.status}


app.mount("/", StaticFiles(directory=os.path.join(ROOT, "explorer", "static"), html=True), name="static")

@app.on_event("startup")
def preload():
    def go():
        if NO_MODEL:
            rt.status = "no model"
            rt.vocab_strings()
            return
        rt.ensure_loaded()
        legacy = MODEL == DEFAULT_MODEL and REVISION is None
        if legacy and not os.path.exists(LENS_INDEX):
            os.makedirs(os.path.dirname(LENS_INDEX), exist_ok=True)
            rt.build_lens_index(LENS_INDEX)
        rt.vocab_strings()
        if legacy and not os.path.exists(ACT_SCALE):
            rt.build_act_scale(ACT_SCALE)
    threading.Thread(target=go, daemon=True).start()


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=PORT)
