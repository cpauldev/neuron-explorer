# Usage guide

See the [README](../README.md#explorer) for installation and the main explorer views.

## Assistant configuration

Install and sign in to Codex CLI (0.164.0+) or Claude Code CLI before selecting it in the Assistant header.
Restart the explorer after installing or updating a CLI. The explorer reuses your existing login.

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
An approved command has your OS account's permissions; its starting directory is not a sandbox.
Commands time out after at most five minutes, output is capped at 64 KB, and file-tool text is capped at 256 KB.
Stop cancels pending approvals and approved commands. Native CLI file/shell tools and unrelated integrations
are disabled for explorer conversations so both providers use the shared workflow.

Keep scratch scripts in the assistant's reported work directory (`explorer/cache/agent/work/` for the default model).

### Conversations

Switching providers restores that provider's conversation, draft and attachments. Wait for a reply to finish
or press Stop before switching. **Past chats** lists saved conversations from either provider for the active model.

Assistant replies continue through browser refreshes and disconnections. Restarting the server interrupts active
replies but retains saved history. Assistant events live under `agent/` in the active model's cache, with drafts
and attachment selections in browser storage. Only explorer-owned CLI transcripts can be imported.

Neuron Chat keeps history per neuron while the page is open; reloading clears it. Avoid editing one assistant
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
the resolved commit. It does not compute caches. Stop the live server before starting a worker; the server and
builders share an exclusive compute lock. On 24 GB GPUs, start with steering batches of 16; larger batches may
exhaust VRAM.

`--stages` selects `layout_writes`, `layout_reads`, `connections`, `lens`, `steer`, or `activations`; the default
builds all six. Activation calibration also reads FineWeb-Edu from Hugging Face and saves its token IDs for recovery.
Core cache builds exclude exhaustive rollout sweeps and rollout embeddings.

### Progress and recovery

Background jobs survive terminal/browser closure. Read progress, the approximate current-stage ETA and errors in
the job's `status.json` and `worker.log`.

```powershell
.venv/Scripts/python.exe explorer/cache_job.py pause cache-jobs/qwen9b
.venv/Scripts/python.exe explorer/cache_job.py resume cache-jobs/qwen9b --background
```

Pause takes effect at a checkpoint boundary; wait for `paused` before resuming or launching live Chat.
After a crash or reboot, run the same resume command. Sleep suspends computation; automatic startup after
login is not configured. Completed checkpoints are reused; interrupted work since the last checkpoint is repeated.
Keep the job folder to preserve recovery.

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

## MCP clients

Both assistant providers use the same tools in `explorer/agent_mcp.py`. The tools include neuron and head
inspection, experiments, map selection, and visible neuron Chat controls:

- `get_ui_state` reads the selection, open tab, Chat controls, prompt and generation state.
- `set_chat_controls` sets dose, mode and direction; negative and zero doses are supported.
- `fill_chat_prompt` fills the prompt without submitting it.
- `submit_chat_prompt` submits the visible prompt and waits for completion or an error.

UI tools wait for the browser to acknowledge the applied state. They preserve Chat history and reject conflicting
actions during generation. `select_neuron`, `select_head` and `open_tab` also wait for acknowledgement.
An external MCP client can control a single connected explorer page without an active assistant turn; with
multiple pages, pass `browser_id` explicitly.

After updating the explorer, restart the server, refresh its browser page and reconnect existing MCP clients
to discover updated tools. See the [development guide](development.md) for implementation details and limitations.
