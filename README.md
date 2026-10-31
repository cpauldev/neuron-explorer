# neuron explorer

Explore Qwen3.5-4B through token associations, attention links, activations and steering experiments.
Inspect local-model behavior on a 3D map alongside a research assistant.

![neuron explorer](explorer.png)

## Explorer

    uv sync
    npm ci
    npm run build
    uv run python explorer/server.py        # http://localhost:8791

Loads Qwen3.5-4B locally on MPS, CUDA or CPU for steered chat and live analysis. Model weights download from
Hugging Face on first use; they are separate from the analysis caches shipped in `explorer/cache/`.
Sweep runs in `runs/` and per-layer stats in `stats/` supply rollout examples and rankings, produced by the sweep below.
The server is accessible only from this machine.

If you have a custom CUDA build of PyTorch, launch with your environment's Python
(`.venv/Scripts/python.exe explorer/server.py` on Windows), or use `uv run --no-sync`.
An ordinary `uv sync` can replace custom wheels.

- **Assistant:** investigate neurons, attention heads and circuits with Codex or Claude in the left panel.
- **Model canvas:** explore the 3D map or saved rollout embeddings. Select a neuron/head to inspect it;
  Display controls layout and connections, and Reset restores the full-model overview.
- **Search:** find token associations across layers or browse saved steering examples.
- **Analyze:** explicitly run a passage through the local model, then inspect activity by token.
- **Inspect:** view associations/connections, run a steering or activation experiment, or read saved examples.
- **Cache:** identify the loaded model and monitor compatible build jobs with explicit pause/resume controls.

The header's Assistant and Tools buttons control the side panels. See the [usage guide](docs/usage.md#working-in-the-explorer)
for navigation, settings and experiment behavior.

## Assistant

The optional Assistant requires an installed, signed-in CLI:

- **Codex:** Codex CLI 0.164.0 or newer; sign in with `codex login`.
- **Claude:** Claude Code CLI, installed and signed in.

Choose the provider in Assistant settings (the gear button). Each provider keeps its own conversation, draft and attachments;
**Past chats** opens saved conversations. Wait for a reply to finish or press Stop before switching providers.
Qwen runs locally, while assistant messages, attachments and tool results go to the selected CLI's provider.

File access defaults to **Project only**; access to your home folder is opt-in. Every shell command requires
approval and runs with your OS account's permissions, including access outside its starting directory.
See the [usage guide](docs/usage.md#assistant-configuration) for configuration, attachments and history behavior.

## Other models

Compatible dense Qwen3.5 text backbones can use separate model/revision-specific caches and live experiments, subject to
available memory. MoE models, GGUF files and other architectures require additional support.

`explorer/cache_job.py` builds caches in the background with progress and pause/resume support. Each model needs
its own caches; the shipped 4B data stays separate. See [models and cache jobs](docs/usage.md#models-and-cache-jobs)
for commands and hardware considerations. Core cache builds do not include rollout sweeps or embeddings.

## Research and sweeps

See [Running sweeps](docs/usage.md#running-sweeps) for calibration, rollout generation, analysis scripts and output formats.
The [research log](research_log.md) contains experimental observations and reasoning;
[historical source notes](docs/research/source-notes.md) record the original references and design inputs.

## Development

The entire frontend uses React and TypeScript, built with Vite; FastAPI serves the compiled app and the existing API on the
same origin. Node.js 22.12+ is required for frontend development and tests. After `npm ci`, use `npm run dev` to
watch and rebuild the frontend, keep the Python server running, and reload the browser after changes.
The Assistant uses assistant-ui with the existing Codex/Claude backends; no additional provider account is needed.
Its prebuilt components and runtime choices are documented in the [integration guide](docs/assistant-ui.md).

With Node.js and the development dependencies installed, run `python tests/run_checks.py` from your configured
Python environment. See the [development guide](docs/development.md) for setup, test coverage and known limitations,
the [usage guide](docs/usage.md) for advanced operation, and the [changelog](CHANGELOG.md) for release changes.

Based on [Lyra C's neuron explorer](https://github.com/lyramakesmusic/neuron-explorer).
