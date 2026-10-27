# Changelog

## Unreleased

### Added

- Shared Codex and Claude research tools, with provider-specific conversations, drafts and attachments.
- Acknowledged MCP tools to read UI state, configure neuron Chat, fill its prompt and submit it through the normal UI.
- Model/revision-specific data paths and resumable background cache jobs with progress, pause/resume, atomic
  checkpoints and validation of settings, dependencies and completed outputs.
- Automated coverage for provider transports, conversation recovery, file/shell permissions, UI commands,
  attention reconstruction and interrupted cache builds.

### Changed

- Assistant conversations use durable event replay and bounded reuse of healthy provider processes.
- File tools enforce the selected scope; shell commands require approval in the Assistant panel.
  Native provider file/shell tools and unrelated integrations are disabled.
- Inspector tabs retain a stable order, Assistant has its own header controls, and map/embeddings use the
  same segmented-control style as index/writes. Form controls, focus indicators and scrollbars are consistent.
- Compatible dense Qwen3.5 backbones use their own dimensions, names, caches and assistant histories.
  Larger backbones retain attention bases in CPU memory; builders support padded grids and sharded or
  single-file Safetensors. Default Qwen3.5-4B data paths remain compatible.

### Fixed

- Windows provider process cleanup, repeated Stop handling and cancellation of pending or approved shell work.
- Stale UI responses, interrupted history/cache writes and completion/reconnection races.
- Negative and zero Chat doses, argument validation and preservation of neuron Chat history during tool actions.
- Cache-worker validation before launch and failure reporting when a pause request is pending.

### Upgrade notes

- Restart the explorer, refresh its browser page, and reconnect existing MCP clients after updating.
- New models require their own caches and sufficient hardware memory. Support currently covers dense
  `qwen3_5_text` backbones, not MoE models, GGUF files or arbitrary architectures.
- Background jobs resume manually after reboot. Core cache builds exclude exhaustive rollout sweeps and embeddings.
- See the [usage guide](docs/usage.md) for commands and the [development guide](docs/development.md) for known limits
  and the upstream integration baseline.
