# Development guide

See the [README](../README.md#explorer) for setup and the [usage guide](usage.md) for provider configuration,
file permissions, model selection and cache-job commands.
This guide covers implementation boundaries, testing and integration decisions.

## Code organization

| Module | Responsibility |
| --- | --- |
| `explorer/runtime.py` | Local Qwen inference, interventions, weight analysis and attention reconstruction. |
| `explorer/model_config.py` | Model identity, architecture checks, isolated paths and Safetensors access. |
| `explorer/cache_job.py` | Job lifecycle, progress, resume policy and command-line controls. |
| `explorer/cache_storage.py` | Atomic file replacement and OS-owned locks shared by inference and cache builders. |
| `explorer/cache_builders.py` | Checkpointed scientific cache stages; existing output schemas. |
| `explorer/server.py` | HTTP endpoints, model integration and assistant turn orchestration. |
| `explorer/agent_mcp.py` | Shared MCP schemas and routing for both providers. |
| `explorer/agent_prompt.md`, `explorer/agent_methodology.md` | Assistant operating instructions and separate research methodology, combined when a turn starts. |
| `explorer/codex_agent.py`, `explorer/claude_agent.py` | Provider protocols, transcript translation and session recovery. |
| `explorer/agent_common.py` | Shared transport errors, MCP configuration, bounded client reuse and process-tree cleanup. |
| `explorer/agent_history.py` | Ordered event journal, interrupted-write recovery and latest-turn rewind. |
| `explorer/agent_attachments.py` | Upload validation and provider-specific attachment input. |
| `explorer/research_tools.py` | Scoped file access and approved shell execution. |
| `explorer/ui_bridge.py` | Server-side UI validation, browser ownership and acknowledgements. |
| `explorer/static/chat_ui.js` | Browser-side command validation and dispatch to normal UI handlers. |
| `explorer/static/assistant_stream.js` | Cursor-based reconnect, stream decoding and duplicate suppression. |
| `explorer/static/app.js` | UI handlers, selection state and conversation presentation. |
| `explorer/static/map3d.js`, `explorer/static/scatter.js` | Visualization and interaction. |

The small assistant modules separate persistence, process control and permission boundaries. Keep provider
details in the adapters and shared policy in the shared modules. UI validation deliberately runs on both sides
of the browser boundary. Backend and frontend validation serve different trust boundaries; they are not
interchangeable implementations to merge into one utility.

The main remaining structural debt is the size of `server.py` and `app.js`. Future extraction should move a
complete responsibility with explicit dependencies, rather than adding generic helpers or mixing unrelated
functions merely to reduce the number of files.

## Tests

Run from the configured environment with Node.js available:

```sh
python tests/run_checks.py
uv lock --check
```

Install test dependencies with `uv sync --group dev`. If the environment has a custom CUDA PyTorch build,
install the development dependencies without replacing it, then run checks with that environment's Python.

The runner checks Python syntax, discovers Python tests, checks all frontend JavaScript syntax, and executes
the JavaScript suites. It does not synchronize or replace an existing Python environment. Tests use temporary
files, fake provider processes and synthetic model inputs; no model downloads or provider logins are needed.

- Provider tests cover transport, history ownership, rewind and cleanup. Shared helpers and route tests cover
  attachments, permissions, processes and event journals, including how those components work together.
- `tests/server_fixture.py` supplies an isolated server factory and JSON request fixture. HTTP suites each
  create their own server; test modules do not import another suite or share its mutable server state.
- `tests/test_head_patterns.py` checks causal full/linear attention and exact delta-rule reconstruction using
  synthetic tensors, without loading model weights.
- `tests/test_cache_job.py` checks resumed results against uninterrupted builds for every core cache stage,
  atomic file replacement, compute locks, pinned model identity, launch validation and failure/pause reporting.
- Frontend tests cover provider/draft state, UI handlers, Chat commands and reconnect decoding. CommonJS suites
  use Node's VM for existing app handlers; ES module suites import the standalone browser modules directly.
  The handler tests use source boundaries and a small DOM fixture, so they complement actual browser checks.
- `tests/live_chat_smoke.py --browser-id <id>` is optional. It uses a real server, browser and model, appends
  visible Chat turns, and should target a separate test tab.

Live Claude authentication and populated sweep/embedding views need separate verification when available.
The current Starlette test client emits a non-failing HTTPX deprecation warning.

## Upstream integration

Upstream baseline: `e566e83e3f9fe00f85438231a788f90e83e2af43`. Its HTTP routes and MCP tools are retained.

| Area | Integration decision |
| --- | --- |
| Attention analysis | Retain upstream's reconstruction and q/k/v/o roles; use locks or explicit capture snapshots so concurrent requests cannot mix captured texts. Validate head arguments and rebuild interrupted profile caches atomically. |
| Assistant lifecycle | Keep durable event replay and Past chats. Publish completion after provider cleanup so reconnect and immediate follow-up agree. |
| Provider processes | Reuse healthy configured clients, bounded to four idle clients and a five-minute timeout. Stop, failures, policy changes, rewind and shutdown close the process tree; saved provider threads retain context. Mid-turn messages use the app's queue or explicit interrupt-and-send behavior. |
| Permissions | Retain local-only HTTP access, shared scoped file tools and explicit shell approvals. Native provider file/shell tools and unrelated integrations remain disabled. Stop cancels pending approvals and approved commands. |
| History | Import only explorer-owned transcripts; replay never repeats map actions or authorizes old commands. Keep `/api/agent/chat` for existing clients alongside reconnectable `/api/agent/send`. |
| UI | Retain stable inspector tabs, shared segmented controls, lowercase map/embeddings labels, shareable selection links and acknowledged UI commands. |

The scientific runtime retains the upstream attention algorithms, with model/revision-specific loading,
compute ownership, and CPU retention of large attention bases for backbones wider than 2560 dimensions.
Provider logins and global CLI settings are reused without copying credentials or changing their configuration.

Warm-client leases are serialized by each chat's turn lock. Reuse requires the same provider, file scope,
combined instructions and model/executable settings. Idle events are discarded before the next turn; failed
requests are never automatically resubmitted, since that could duplicate a prompt already accepted by a CLI.
The idle reaper runs every 30 seconds, rechecks that a client is still idle before closing it, and cannot cancel
an active reply. Repeated Stop requests share one cleanup task; caller disconnection does not interrupt it.
The older request-bound `/api/agent/chat` route keeps its original close-after-turn behavior.

Native in-turn steering is intentionally not used: keeping one submitted user message per provider turn makes
edit/reroll, ordered history and recovery consistent across both providers. The app exposes queueing or
interrupt-and-send instead. This trades some steering convenience for a simpler, testable turn contract.

## Known limits and release checks

- Activation inspection uses a process-wide cache; analyzing another text can replace the current analysis.
- Neuron Chat history is in browser memory and resets on reload. Assistant drafts share provider-specific
  browser storage; simultaneous editing of one conversation in multiple tabs is not isolated.
- Legacy model-analysis HTTP endpoints do not all enforce the same input bounds as the newer UI commands.
- Dense result lists are capped rather than fully virtualized.
- Multi-model support is limited to dense Qwen3.5 text backbones within the existing binary index limits.
  An architecture check cannot establish answer quality or sufficient hardware memory. New full-cache jobs
  need model-specific validation; shipped 4B observations do not transfer to other models.
- Cache jobs checkpoint between units, not inside a forward pass or PCA. Force termination can repeat a unit;
  connection work can repeat the current target layer. A surviving stage owns its locks until it exits.
  Resume after reboot is manual. Package changes require restoring the recorded versions or creating a new job.
  Status and pause commands remain available when the original dependency versions are no longer installed.

Before publishing, run the checks above and `git diff --check`, review the complete tracked/untracked file
inventory, and check for credentials and personal paths. Such scans are limited checks, not guarantees.
Shipped visualization caches and existing research scripts belong to the project. Logs, local names, model
environments, conversations, uploads, generated profiles, database sidecars and scratch work remain ignored.

Python changes require an explorer restart; static UI changes require a page refresh. Reconnect external MCP
clients after tool-schema changes. A server restart interrupts active replies while retaining saved history.
