# Development guide

See the [README](../README.md#explorer) for setup and the [usage guide](usage.md) for provider configuration,
file permissions, model selection and cache-job commands.
This guide covers implementation boundaries, testing and integration decisions.

## Code organization

| Module | Responsibility |
| --- | --- |
| `explorer/token_display.py` | Lossless labels for isolated vocabulary tokens; display caches stay separate from raw analysis data. |
| `explorer/runtime.py` | Local Qwen inference, interventions, weight analysis and attention reconstruction. |
| `explorer/model_config.py` | Model identity, architecture checks, isolated paths and Safetensors access. |
| `explorer/cache_job.py` | Job lifecycle, progress, resume policy and command-line controls. |
| `explorer/cache_progress.py` | Optional desktop progress window using the same cache-job controls. |
| `explorer/benchmark_cache.py` | Isolated all-stage comparisons using production builders and stratified samples. |
| `explorer/cache_storage.py` | Atomic file replacement and OS-owned locks shared by inference and cache builders. |
| `explorer/cache_builders.py` | Checkpointed scientific cache stages; existing output schemas. |
| `explorer/build_monitor.py` | Model-free job snapshots, partial layouts and bounded connection previews for the live build view. |
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
| `frontend/src/App.tsx`, `frontend/src/components/` | Typed React app shell, toolbar, analysis, inspector, examples and local experiments. |
| `frontend/src/explorer.ts`, `frontend/src/types.ts` | Explorer state/contracts and actions; scientific requests, selection races, local inference and acknowledged UI commands. |
| `frontend/src/assistant/` | assistant-ui runtime, structured journal conversion, provider/draft lifecycle and research tool renderers. |
| `frontend/src/context.tsx`, `frontend/src/lib/store.ts` | Typed selective React store subscriptions and shared HTTP/storage/stream helpers. |
| `explorer/static/map3d.js`, `explorer/static/scatter.js` | Visualization and interaction. |
| `vite.config.mjs`, `frontend/index.html` | Vite entry and same-origin compiled assets in `explorer/static/dist/`. |

The small assistant modules separate persistence, process control and permission boundaries. Keep provider
details in the adapters and shared policy in the shared modules. UI validation deliberately runs on both sides
of the browser boundary. Backend and frontend validation serve different trust boundaries; they are not
interchangeable implementations to merge into one utility.

Cache storage stays independent of orchestration and model loading. The job module owns shared status,
pause and launch controls used by the CLI, browser monitor and optional Tk desktop window. Scientific builders
remain separate so monitoring never imports Torch. Model compatibility tests share the cache tests' small
weight/runtime fixtures; they do not require another fixture module or real downloads.

The main remaining structural debt is the size of `server.py`. Future extraction should move a
complete responsibility with explicit dependencies, rather than adding generic helpers or mixing unrelated
functions merely to reduce the number of files.

## Tests

Run from the configured environment with Node.js available:

```sh
node --version                    # 22.12+
npm ci
python tests/run_checks.py
uv lock --check
```

Install test dependencies with `uv sync --group dev`. If the environment has a custom CUDA PyTorch build,
install the development dependencies without replacing it, then run checks with that environment's Python.

The runner checks Python syntax, discovers Python tests, checks the visualization/helper JavaScript syntax,
executes the protocol suites, typechecks/builds the React app, and runs Vitest/React Testing Library tests. It does not
synchronize or replace an existing Python environment. Tests use temporary
files, fake provider processes and synthetic model inputs; no model downloads or provider logins are needed.

- Provider tests cover transport, history ownership, rewind and cleanup. Shared helpers and route tests cover
  attachments, permissions, processes and event journals, including how those components work together.
- `tests/server_fixture.py` supplies an isolated server factory and JSON request fixture. HTTP suites each
  create their own server; test modules do not import another suite or share its mutable server state.
- `tests/test_head_patterns.py` checks causal full/linear attention and exact delta-rule reconstruction using
  synthetic tensors, without loading model weights.
- `tests/test_cache_job.py` checks resumed results against uninterrupted builds for every core cache stage,
  atomic file replacement, compute locks, pinned model identity, launch validation and failure/pause reporting.
- Frontend tests cover provider/draft state, attachments, stale approvals, journal conversion, selection races,
  React controls, local streaming, experiment commands and reconnect decoding. Vitest exercises the stores and real
  React components, including assistant-ui. ES module protocol suites also run directly under Node.
- `tests/live_chat_smoke.py --browser-id <id>` is optional. It uses a real server, browser and model, appends
  visible experiment turns, and should target a separate test tab.

Live Claude authentication and populated sweep/embedding views need separate verification when available.
The current Starlette test client emits a non-failing HTTPX deprecation warning.

## React frontend

The application uses TypeScript with strict checking. `npm run typecheck` runs it independently; production
builds include it automatically. `npm run format` formats frontend source; `npm run format:check` checks it. See [assistant-ui integration](assistant-ui.md) for the documented runtime,
prebuilt component choices, registry source locations and backend-specific behavior.

Run `npm run build` once before starting FastAPI. For frontend development, keep `npm run dev` (Vite build
watch mode) running alongside Python and reload the browser after a rebuild. This deliberately uses a single
origin: local-only HTTP checks, uploads, inference streams and the browser-owned MCP bridge all use the Python
server's address. The Python server returns an actionable 503 message when compiled assets are missing.
Generated `explorer/static/dist/` assets are ignored; source and the npm lockfile are tracked.

All page controls and content are React components. `createExplorer` owns application state and async actions;
manual UI handlers and MCP commands call those same actions. `useStore` subscribes to selected state fields,
so hovering the map does not re-render every panel. The canvas engines retain imperative drawing internally
and expose explicit disposal of observers, listeners and GPU resources. React owns their canvas lifecycle.

The Assistant is loaded when first opened and kept mounted after visiting it. `useExternalStoreRuntime`
adapts server-owned messages to assistant-ui's thread/message/composer primitives. The existing journal is the
source of history; local storage holds chat pointers, drafts and attachment IDs, not rendered HTML. Old HTML
caches are imported as text only when the server has no history. History replay never dispatches UI actions.
Tool cards are presentation-only; execution, file scopes and shell approvals remain on the Python backend.

## Upstream integration

Upstream baseline: `e566e83e3f9fe00f85438231a788f90e83e2af43`. Its HTTP routes and MCP tools are retained.

| Area | Integration decision |
| --- | --- |
| Attention analysis | Retain upstream's reconstruction and q/k/v/o roles; use locks or explicit capture snapshots so concurrent requests cannot mix captured texts. Validate head arguments and rebuild interrupted profile caches atomically. |
| Assistant lifecycle | Keep durable event replay and Past chats. Publish completion after provider cleanup so reconnect and immediate follow-up agree. |
| Provider processes | Reuse healthy configured clients, bounded to four idle clients and a five-minute timeout. Stop, failures, policy changes, rewind and shutdown close the process tree; saved provider threads retain context. Mid-turn messages use the app's queue or explicit interrupt-and-send behavior. |
| Permissions | Retain local-only HTTP access, shared scoped file tools and explicit shell approvals. Native provider file/shell tools and unrelated integrations remain disabled. Stop cancels pending approvals and approved commands. |
| History | Import only explorer-owned transcripts; replay never repeats map actions or authorizes old commands. Keep `/api/agent/chat` for existing clients alongside reconnectable `/api/agent/send`. |
| UI | Keep the dedicated Assistant, center canvas and unified Explorer tools navigation; preserve shareable selection links and acknowledged UI protocol aliases. See [UI architecture](assistant-ui.md#workspace-and-navigation). |

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
- Neuron experiment history is in browser memory and resets on reload. Assistant drafts share provider-specific
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

## Potential improvements

These are proposals, not implemented features or scheduled releases:

- Persist and export local neuron experiments with their model and intervention settings.
- Add explicit local-model download, loading and unload controls.
- Investigate CUDA-graph decoding with numerical-parity tests before enabling it.

## Documentation ownership

The README is the entry point; [usage](usage.md) owns user workflows and operating commands,
this guide owns setup/testing and backend boundaries, and [UI architecture](assistant-ui.md) owns component
choices and integration contracts. Update current behavior in those guides instead of adding successive
review reports. Record notable changes in the [changelog](../CHANGELOG.md), and experimental observations
in the [research log](../research_log.md). [Historical source notes](research/source-notes.md) are research
background, not a description of the current UI. Assistant prompt/methodology files remain runtime inputs.
