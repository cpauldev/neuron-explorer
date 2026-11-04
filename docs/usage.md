# Usage guide

See the [README](../README.md#explorer) for installation and the main explorer views.

## Working in the explorer

The model selector beside **Neuron Explorer** lists complete, supported Qwen3.5 checkpoints
already in the local Hugging Face cache. The list refreshes when you open the selector or return to the app;
closely spaced checks are combined to avoid repeated disk scans.
Switching never downloads weights. Finish an active chat or analysis first; the server releases
the previous weights before loading the selected checkpoint. The workspace reloads with the new
architecture and model-specific caches and conversations. Other open tabs refresh when they detect
the change. If loading fails, the previous model stays selected and is reloaded when possible.

Open **Settings → Appearance** in the top toolbar to choose **Light**, **Dark**, or **System**.
Dark is the initial default; your choice is saved in this browser. System follows
your operating system's appearance, including changes while the app is open.

In **Settings → Visualization → Scene colors**, use the color picker or edit the hex value directly
for each scene role. Light and dark palettes are saved separately. Exact duplicate colors
are blocked within each palette. **Reset colors** restores the palette you are editing.

**Chat** is a dedicated left panel. The model canvas is in the center, and **Workbench** opens one scientific panel on the right:

- **Search** finds neurons from token associations across all layers, or browses saved examples for a layer.
- **Analyze** measures a passage after you press **Analyze text**. Select a resulting token to focus its activity; advanced filters live under **Filter activations**.
- **Inspect** shows the selected neuron or head. **Overview** contains associations and connections; **Experiment** compares generated outputs or measures the selected neuron's activations; **Saved examples** contains cached steering runs.
- **Cache** identifies the loaded model and monitors existing analysis jobs with explicit pause/resume controls. It selects a matching job when available; jobs for other models cannot color the loaded model’s map.

The global **Go to unit** field accepts IDs such as `L7 N1870` and `L7 h3`. Map/Embeddings, layer selection and camera reset belong to the canvas toolbar. Open **Settings → Visualization** for map arrangement, connections, and embedding colors. Display settings do not change the active scientific tool. The map layer selector reflects All layers or the focused layer; Reset restores the original overview angle and fits the current canvas.

While chat reads or tests neurons, the map temporarily shows its subjects and connections with a nearby
action label. Your selected network becomes muted when chat reviews a different unit; Inspect, the selected ID, and the camera stay under
your control. Your network returns to full color when the turn finishes or stops. Comparisons show the
tested group together. Large batches show their markers without adding an unreadable web for every unit.
Refreshing reconnects to a running chat and restores its current activity; it does not submit the request again.
Your Workbench and Inspect tabs are remembered.

Use the floating **Chat** and **Workbench** buttons below the canvas toolbar to open closed panels, and the collapse control in each panel header to close them. Panel visibility is remembered across refreshes. On wide screens both can stay open and their dividers can be resized. Compact screens show one sidebar at a time; on phones it fills the work area. Closing it returns to the map. Conversations and tool drafts survive switching between these areas.

The Assistant toggle indicates background work. A **Review command approval** action appears only when an actual pending approval exists; opening it does not grant permission.

Implementation decisions and component ownership are documented in [UI architecture](assistant-ui.md).

Byte fragment badges represent tokens containing incomplete character bytes. Hover or focus a badge for an explanation and its exact bytes; valid multilingual tokens are shown normally.

## Assistant configuration

Install dependencies with `uv sync`, then choose a provider in **Settings → Chat**.
The official SDKs use their bundled runtimes by default: `openai-codex==0.163.0`,
`claude-agent-sdk==0.2.176`, and `mcp==2.3.0`. Restart the explorer after dependency changes.
Codex uses its existing authentication (for example, `codex login`). For Claude, use the
[Agent SDK's supported authentication](https://code.claude.com/docs/en/agent-sdk/quickstart), such as
`ANTHROPIC_API_KEY`. Do not assume a Claude subscription is available to a third-party application;
Anthropic documents that offering subscription login requires prior approval.

`EXPLORER_CODEX_BIN` and `EXPLORER_CLAUDE_BIN` are optional escape hatches for a tested executable,
not required setup. An override must support the pinned SDK's protocol; arbitrary newer or older
CLI versions are not a compatibility guarantee. Claude overrides must point to an executable,
not an npm `.cmd`/`.ps1` launcher.

| Setting | Purpose |
| --- | --- |
| `EXPLORER_CODEX_MODEL` | Override the Codex assistant model. |
| `EXPLORER_CODEX_BIN` | Select the Codex executable. |
| `EXPLORER_CLAUDE_MODEL` | Override the Claude assistant model. |
| `EXPLORER_CLAUDE_BIN` | Select the Claude executable. |

Instructions come from `explorer/agent_prompt.md` and `explorer/agent_methodology.md`. Add personal instructions
in the untracked `explorer/agent_prompt.local.md` file.

Both providers support file attachments. Codex receives extracted PDF text; attach scanned pages as images.
Claude receives images and PDFs natively.

### File and shell access

**File access** defaults to **Project only**. Select **Project + home folder** to include your home folder.
File tools reject paths and symlinks outside the selected roots. Narrowing access affects future file operations;
it cannot remove content already sent to the assistant.

Every shell command requires approval in the panel, which shows the command and starting directory.
Overwriting an existing file requires a separate approval showing its new contents. If the file changes
while approval is pending, the write is rejected so the assistant can read it again.
An approved command has your OS account's permissions; its starting directory is not a sandbox.
Commands time out after at most five minutes, output is capped at 64 KB, and file-tool text is capped at 256 KB.
Stop cancels pending approvals and approved commands. Native CLI file/shell tools and unrelated integrations
are disabled for explorer conversations so both providers use the shared workflow.

Keep scratch scripts in the assistant's reported work directory (`explorer/cache/agent/work/` for the default model).

### Conversations

Switching providers restores that provider's conversation, draft and attachments. Wait for a reply to finish
or press Stop before switching. **Past chats** lists saved conversations from either provider for the active model.

Assistant replies continue through browser refreshes and disconnections. Restarting the server interrupts active
replies but retains saved history. Conversations, event history, request receipts, and approval records live in
`agent/assistant.sqlite3` under the active model's cache; drafts and attachment selections remain in browser storage.
Older Explorer session JSON and event JSONL files import automatically and are left intact.
Only explorer-owned provider transcripts can be imported through supported provider APIs.

Repeated sends with the same request ID return the existing turn instead of running it again. After a server
restart, unfinished turns are marked interrupted with an unknown execution outcome; pending approvals expire.
An operation that may already have executed is never replayed automatically. Editing the latest Claude prompt
creates a supported session branch (or a fresh session for the first prompt), preserving the original provider history.

Neuron experiments keep history per neuron while the page is open; reloading clears it. Avoid editing one assistant
conversation in multiple tabs. Activation analysis is shared by the server, so analyzing another text can replace
the current analysis.

## Models and cache jobs

The shipped caches belong to Qwen3.5-4B. Other dense `qwen3_5_text` backbones need their own caches and sufficient
hardware memory. MoE models, GGUF files and other architectures need additional runtime support. Architecture
compatibility alone does not establish that a model fits your GPU or produces useful analysis.

Use your configured Python environment. The following commands use a Windows virtual environment;
on other platforms, substitute its Python executable.

```powershell
.venv/Scripts/python.exe explorer/cache_job.py create --model Qwen/Qwen3.5-9B --batch 16 --job cache-jobs/qwen9b
.venv/Scripts/python.exe explorer/cache_job.py start cache-jobs/qwen9b --background
.venv/Scripts/python.exe explorer/cache_job.py status cache-jobs/qwen9b
```

`create` validates the architecture, downloads missing Safetensors/tokenizer files from Hugging Face and records
the resolved commit. It does not compute caches. Stop the live-model server before starting a worker; the server and
builders share an exclusive compute lock. On 24 GB GPUs, start with steering batches of 16; larger batches may
exhaust VRAM.

`--stages` selects `layout_writes`, `layout_reads`, `connections`, `lens`, `steer`, or `activations`; the default
builds all six. Activation calibration also reads FineWeb-Edu from Hugging Face and saves its token IDs for recovery.
Core cache builds exclude exhaustive rollout sweeps and rollout embeddings.

Text-only `Qwen3_5ForCausalLM` checkpoints use the same workflow. For example, the author's
Hugging Face release of [Qwenputer](https://huggingface.co/divagr1925/Qwen3.5-4B-Qwenputer):

```powershell
.venv/Scripts/python.exe explorer/cache_job.py create --model divagr1925/Qwen3.5-4B-Qwenputer --batch 16 --job cache-jobs/qwenputer
.venv/Scripts/pythonw.exe explorer/cache_progress.py --job cache-jobs/qwenputer
```

The progress window starts or resumes that job; closing it requests a pause after the current checkpoint.
It works with any existing job and can be used as a desktop shortcut target. Jobs still share the compute lock.

Qwenputer needs its own caches: although the original Qwen weights are preserved, it adds 11 compiled layers,
widens the hidden state and extends the vocabulary. The explorer supports ordinary text generation and neuron
analysis of the merged checkpoint. Its firmware boot, trace-token routing and accelerated RISC-V executor require
the author's separate `RvChat` driver and are not integrated here. Standard text calibration does not exercise a
booted computer, so interpret the compiled layers separately from learned language neurons. Neurons with zero
write vectors reject nonzero additive steering; multiply mode remains available.

### Progress and recovery

Background jobs survive terminal/browser closure. Read progress, the approximate current-stage ETA and errors in
the job's `status.json` and `worker.log`.

```powershell
.venv/Scripts/python.exe explorer/cache_job.py pause cache-jobs/qwen9b
.venv/Scripts/python.exe explorer/cache_job.py resume cache-jobs/qwen9b --background
```

Pause takes effect at a checkpoint boundary; wait for `paused` before resuming or running live experiments.
After a crash or reboot, run the same resume command. Sleep suspends computation; automatic startup after
login is not configured. Completed checkpoints are reused; interrupted work since the last checkpoint is repeated.
Keep the job folder to preserve recovery.

### Live build view

Run a model-disabled server alongside a cache worker, then open **Tools → Cache**:

```powershell
$env:EXPLORER_NO_MODEL = '1'
.venv/Scripts/python.exe explorer/server.py
```

Open `http://127.0.0.1:8791/?build=qwen9b` to open that sidebar tab with the existing job in `cache-jobs/qwen9b`.
It reuses the explorer's map and index/writes/reads layout controls, replaying saved layers and updating checkpoint
coverage and stage ETA. The selected build must match the explorer's model, dimensions and pinned revision to colour
the map; other jobs' status remains readable without mixing their data into this model. Configure `EXPLORER_MODEL`
and `EXPLORER_REVISION` as described below to observe another model.
Writes/reads layouts appear one completed layer at a time; unsaved layers remain in index order. Saved neurons
are teal and the next checkpoint range is amber. Lines are a bounded sample of real saved connections from
neuron zero in each source layer. These colours show build progress, not activation strength or live model activity.

Pause and Resume use the existing job controls. Closing the browser leaves the worker running; unlike the local
desktop progress window, it does not request a pause. The server never loads model weights in this mode, while
the worker loads them when its GPU stages need them. The observer supports already-running jobs without
changing their checkpoints or scientific calculations. Internal SVD/UMAP iterations are not streamed.

Job settings and dependency versions must match when resuming. Restore the recorded versions or create a new
job after changing them. Status and pause remain available after dependency changes.

### Launching the selected model

The creation command prints the model and resolved commit to use:

```powershell
$env:EXPLORER_MODEL = 'Qwen/Qwen3.5-9B'
$env:EXPLORER_REVISION = '<resolved commit printed by create>'
.venv/Scripts/python.exe explorer/server.py
```

Model/revision-specific caches, sweep/stat folders, names and assistant history live under `explorer/cache/models/`.
The default 4B model retains its existing paths. New models do not automatically start cache generation when the
server starts. Restart after building caches to reload in-memory indexes.

`build_layout.py` and `build_connections.py` are one-shot alternatives; use `cache_job.py` for background control
and checkpoint recovery.

### Comparing cache-build time

Benchmark existing, downloaded jobs with the same settings:

```powershell
.venv/Scripts/python.exe explorer/benchmark_cache.py run --jobs cache-jobs/qwen9b cache-jobs/qwenputer --out logs/cache-comparison
```

The CUDA benchmark runner measures all six stages through the production builders, using batch 16, early/middle/late samples,
and one pinned FineWeb-Edu calibration corpus. Compiled and learned layers are sampled separately when the
checkpoint includes that metadata. It alternates model order between stages and releases compute after each
phase. `status.json`, per-phase `worker.log` files, and the final `report.md` live in the output directory.
Estimates include checkpoint writes and setup; sampled stages' final full-cache aggregation is excluded.

Results and sample checkpoints stay separate from the original jobs and cannot be published as complete caches.
Repeat the same command to resume completed phases after interruption; changed code, settings or model pins
require a new output directory. Request a stop at the next checkpoint with:

```powershell
.venv/Scripts/python.exe explorer/benchmark_cache.py stop logs/cache-comparison
```

## MCP clients

Both assistant providers use the same tools in `explorer/agent_mcp.py`. The tools include neuron and head
inspection, experiments, map selection, and visible neuron Experiment controls:

- `get_ui_state` reads the selection, open tab, experiment controls, prompt and generation state.
- `set_chat_controls` sets dose, mode and direction; negative and zero doses are supported.
- `fill_chat_prompt` fills the prompt without submitting it.
- `submit_chat_prompt` submits the visible prompt and waits for completion or an error.

UI tools wait for the browser to acknowledge the applied state. They preserve experiment history and reject conflicting
actions during generation. `select_neuron`, `select_head` and `open_tab` also wait for acknowledgement.
An external MCP client can control a single connected explorer page without an active assistant turn; with
multiple pages, pass `browser_id` explicitly.

After updating the explorer, restart the server, refresh its browser page and reconnect existing MCP clients
to discover updated tools. See the [development guide](development.md) for implementation details and limitations.

## Running sweeps

Run these commands from the repository root. Sweep outputs are local generated data and are not committed.

The sweep pipeline runs on a CUDA 13 GPU pod with the steering fork of vLLM ([RhizoNymph/vllm](https://github.com/RhizoNymph/vllm)).

    bash sweep/setup_pod.sh                                   # fork, deps, model; writes /workspace/env.sh
    python sweep/neuron_stats.py --layers 22 --tokens 2000000 --out stats/q35-4b
    python sweep/steer_sweep.py --stats stats/q35-4b_L22.npz --design main_rel --dose-unit rel \
        --neurons all --random-controls 256 --run q35-4b-L22
    sweep/run_depth.sh "4 9 13 17" 384 64                     # random-subset sweep across several layers

`main_rel` doses are fractions of the median residual norm leaving the layer: {who, snake, orange} × {−0.7, +0.5, +0.8}
and {free} × {+3}, plus one unsteered baseline per prompt.

| script | output |
|---|---|
| `sweep/neuron_stats.py` | per-neuron activation extremes by sign regime, down columns, residual norms |
| `sweep/steer_sweep.py` | `runs/<run>.jsonl`: text, token ids, logprobs, top-k per step; optional activation captures |
| `sweep/rank.py` | `runs/<run>.units.jsonl`: distinctive words, cluster mass, percentile against controls |
| `sweep/steer_lens.py` | `stats/steer_lens_L{l}.npz`: next-token Δlogprob and KL for ±0.8 pushes on every neuron |
| `sweep/depth_report.py` | `runs/depth_report.json`: per-layer share of neurons above controls, coherence, top units |
| `sweep/shift.py` | word-shift score against controls, all words counted |
| `sweep/merge_runs.py` | joins sharded runs of one layer |
| `sweep/check_equivalence.py` | HF vs vLLM steering and capture agreement |
| `sweep/bench.py`, `sweep/peek.py` | throughput conditions; terminal views of a run |
| `explorer/build_embeddings.py` | `runs/<run>.umap.json` |
| `explorer/build_layout.py` | Model-specific `layout_writes.npz` or `layout_reads.npz`; default 4B uses `explorer/cache/` |
| `explorer/build_connections.py` | Model-specific `connections.npz`: each neuron's 24 strongest direct-path links up and down |
| `explorer/cache_job.py` | Resumable background builds of the core caches; see the [cache-job commands](#models-and-cache-jobs) |
| `sweep/capture_prefill.py` | `captures/<run>.mlp_in.npy`: MLP input at the last prompt token at the run's capture layers, steered |
