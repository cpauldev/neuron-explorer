# UI architecture and assistant integration

See the [usage guide](usage.md) for operating the app and the [development guide](development.md) for setup,
tests and backend boundaries. This guide records the current UI foundation and the decisions needed to maintain it.

## Foundation and ownership

The frontend uses React, strict TypeScript, Vite and Tailwind 4. Standard controls use shadcn **base-nova**
with `@base-ui/react`, a neutral dark theme and the supplied component variants. Assistant conversations use
assistant-ui's styled registry components. These are project-owned source files: update them deliberately,
review local integrations, and add components only when a real feature needs them.

This keeps the explorer and assistant on one control and theme system. Base UI supplies interaction primitives;
shadcn supplies styled general controls; assistant-ui adds conversation components and runtime integration.
A second general UI framework would duplicate those responsibilities.

| Location | Responsibility |
| --- | --- |
| `frontend/src/components/ui/` | Shared shadcn source components. |
| `frontend/src/components/*.aui.tsx` and registry components | Assistant-ui visual compositions. |
| `frontend/src/assistant/` | Runtime adapters, journals, provider state, settings and scientific tool renderers. |
| `frontend/src/components/explorer-ui.tsx`, `choice-select.tsx`, `confirm-dialog.tsx` | Shared domain compositions, finite choices and confirmations. |
| `frontend/src/style.css` | Theme tokens, pane geometry, responsive boundaries and intentional scientific styling. |
| `explorer/static/style.css` | Retained visualization, token and experiment presentation. |

`components.json` selects the style-aware `https://r.assistant-ui.com/styles/{style}/{name}.json` registry.
Registry imports use the existing `@/lib/utils` helper. Base UI sources use `render` composition;
assistant-ui's own supported `asChild` compositions do not require application imports of Radix.

Official references: [assistant-ui Base UI compatibility](https://www.assistant-ui.com/docs/base-ui),
[shadcn components](https://ui.shadcn.com/docs/components),
[Field](https://ui.shadcn.com/docs/components/base/field),
[Input Group](https://ui.shadcn.com/docs/components/base/input-group) and
[Select](https://ui.shadcn.com/docs/components/base/select).

## Workspace and navigation

The workbench has a dedicated Assistant on the left, a model canvas in the center and one Explorer tools
panel on the right. This lets a person read an answer while inspecting its evidence. The assistant belongs
to the investigation rather than one neuron. A floating assistant modal would cover the scientific workspace.

The global header owns model identity, Go to unit and panel visibility. Canvas controls own Map/Embeddings,
actual layer scope, camera reset and Display options. Search, Analyze, Inspect and Cache are explicit tasks;
only Inspect has contextual Overview, Experiment and Saved examples views. Local Qwen comparisons are called
Experiment to distinguish them from the assistant conversation.

- At 1100 px and wider, both sidebars can be open and resized with mouse or keyboard. Widths are remembered.
- At 768–1099 px, one sidebar stays alongside the canvas; the active work area takes priority.
- Below 768 px, a sidebar fills the work area. Closing it returns to the map, and offscreen canvas controls are inert.
- The assistant stays mounted after first use. Canvas engines also remain mounted when their view is inactive.
- Pane headers share a 48 px baseline. Nested flex/tab content has minimum-width boundaries; wide scientific
  tables scroll locally instead of expanding the inspector. Camera insets count only real panel overlap.

Search and Analyze have separate inputs, requests, cancellation generations and results. Typing or switching
tabs never submits model inference: Analyze requires explicit submission. Result caps are disclosed, errors
have scoped recovery, and missing scientific controls are shown as unavailable rather than invented values.

Cache identifies the loaded model and defaults to its matching build, if one exists. A different model's job
can be monitored but cannot paint coverage onto the loaded model. No matching job means no Resume action.
Runtime problems and pending approvals use conditional notices instead of a permanent idle footer.

## Component choices

| Surface | Composition |
| --- | --- |
| Conversation | Official styled Thread, with user/assistant messages, composer, latest-turn actions, tool groups and scroll controls. |
| Attachments | AttachmentUI and a local AttachmentAdapter connected to real upload IDs; selection, paste/drop, progress, removal and attachment-only submission are supported. |
| History | Searchable ThreadList connected through ExternalStoreThreadListAdapter to persisted conversations. |
| Response text | MarkdownText with GFM tables and code copying. A remark AST plugin links valid unit references in prose while preserving existing links and code. |
| Waiting and recovery | Thread's built-in pulse, ErrorState, ConnectionState and MessageQueue connected to actual waiting, retry, reconnect and queued-turn operations. Pending approvals hide the waiting pulse. |
| Assistant model | Compact ComposerModelTrigger, ComposerMenu and ComposerModelItem using the backend catalog and actual model ID. Unsupported prices, context limits and other metadata are omitted. |
| Dictation | Thread microphone/ComposerVoice controls backed by WebSpeechDictationAdapter where supported. |
| Settings | Dialog, Field, Select and RadioGroup for assistant choice and file scope; a standard gear TooltipIconButton opens it. Model choice stays in the composer. |
| Header actions | Shared TooltipIconButton; new chat composes ThreadListPrimitive.New and retains unsent-work confirmation. |
| Unit context | Removable composer reference, captured separately for each submitted or queued message. Historical references describe the original context. |
| Forms and choices | Field/FieldLabel for label spacing; Input Group for unit navigation and token search; ChoiceSelect for finite choices; controlled ToggleGroup for required experiment choices. |
| Navigation | Associated Tabs panels, with disabled views for unsupported unit kinds. Arrows move focus; Enter/Space activates. |
| Scientific evidence | Shared Table, token Badge/Button, signed heatmaps and synchronized requested/baseline/opposite-dose comparisons. |
| Findings | Readable summary outside the tool trace, visible limitations and a standard Collapsible Evidence section containing observations, interpretation and agent-assessed confidence. |
| Findings actions | Copy and Markdown download share one serializer. Unit links and explicit highlighting reconnect evidence to the map; runtime suggestions preview concrete next questions in a Popover; Use question fills the composer without sending. Existing drafts are replaced only through an explicit Replace draft action. |
| Shell commands | ApprovalCard with Run command/Decline, and TerminalBlock for actual output, exit status and truncation. |
| Unknown tools | ToolFallback inside the normal collapsible tool groups. |
| Destructive clearing | Shared AlertDialog protects experiment results and unsent assistant work; cancellation preserves them. |
| Build progress | Progress and Collapsible show real checkpoint counts; unknown progress remains indeterminate. |

Token fragments are not missing-font errors. Some isolated vocabulary tokens contain incomplete UTF-8 bytes.
`explorer/token_display.py` produces lossless display labels and `Runtime.vocab_labels()` caches them separately
from raw vocabulary used in search and analysis. The UI shows a Byte fragment badge with a focusable tooltip
explaining the fragment and its exact bytes. Unknown tokenizer fragments use a separate Token fragment label.
Valid multilingual text remains unchanged, and fragment labels are not offered as literal search queries.

## Runtime and state ownership

Python owns provider sessions, durable journals, cancellation, uploads and history, so the assistant uses the
supported [ExternalStoreRuntime](https://www.assistant-ui.com/docs/runtimes/custom/external-store).
AssistantRuntimeProvider wraps the panel; useAui/useAuiState expose composer/message state. AuiConfig, Tools
and a render-only toolkit register scientific renderers through the [Tool UI API](https://www.assistant-ui.com/docs/tools/tool-ui).
No Assistant Cloud service is required.

Replaying history only folds journal events into typed messages. It never repeats experiments, map commands
or shell approvals. Legacy HTML caches are imported as text only when the backend has no history. Tool cards
are presentation-only; execution and permission enforcement remain on the server. Completed attachment-chip
removal also updates persisted drafts because the runtime does not call upload removal for completed files.

The acknowledged browser protocol still accepts `chat/details/examples`, mapped to Inspect →
Experiment/Overview/Saved examples. UI state reports actual responsive visibility; submitting a hidden
Experiment is rejected. Selection links remain shareable, and manual and agent actions use the same handlers.

Stop preserves partial responses. Enter interrupts an active turn; Ctrl/Cmd+Enter queues. Drafts, uploads and
conversations are isolated by provider and explored model. Queued messages capture their own selection.
Latest-turn editing, retry and regeneration preserve the original context even when map selection changes.
Changing the assistant model keeps the draft and reopens the provider session under the correct model policy.
CLI default resolves the actual default rather than retaining a previous override; global CLI settings and
credentials are not changed.

## Evidence and capability boundaries

`present_findings` validates bounded report fields, evidence categories and model-specific unit references
through `explorer/research_report.py`. It does not run experiments, save names, grant access or change the map.
Answers should lead with a concrete example and a scope-appropriate interpretation, without a forced one-job verdict or procedural closing sentence. Confidence is an agent assessment, not a calculated probability; schema validation does not verify causal claims.
Weight-based associations and logit-lens fallbacks must be labeled accurately, rather than presented as measured
interventions. Scientific renderers retain underlying score labels and raw tool details; probability comparisons
identify first-token probabilities. Both transports preserve structured JSON results up to 1 MiB and use explicit
UTF-8 MCP stdio on Windows.

Settings expose only supported capabilities. File scope belongs in settings; attachments and selected-unit
context belong to the message being composed. Every shell command requires separate approval. Dictation starts
only after microphone activation, uses the browser's speech service and reports its own errors without retrying
an unrelated response.

Ratings, arbitrary branching/old-message editing, persistent command approval, configurable reasoning effort,
temperature/system-prompt controls and context-budget meters are omitted until their backing operations exist.
Web citation widgets require actual retrieved sources; weight-based findings instead link to explorer units.
The local model's synchronized three-dose comparison remains a scientific view, not a single conversation bubble.

## Styling and component updates

Official components own control appearance, focus treatment and ordinary message layout. Scientific sign
colors, heatmaps, canvas rendering and experiment grids are intentional application-specific presentation.
Do not add a second focus outline or globally suppress accessible focus indicators.

Retained CSS is enclosed in a scope excluding `.assistant-surface`, `[data-ui]` and `[data-assistant-ui]`.
Dialog, AlertDialog, Tooltip and Popover content carry `data-ui` so portals also respect that boundary.
Tailwind orientation variants accept Base UI's `data-orientation` as well as registry shorthand attributes.
Local Thread extensions expose metadata, notices, Markdown plugins, composer events and latest-turn guards.
Review these integrations before replacing copied registry sources.

Shared cursor rules distinguish enabled actions from static content. Model/embedding hit targets use pointer;
canvas movement uses grab/grabbing. Standard defaults remain in place elsewhere. New controls should be checked
with their real loading, empty, error, keyboard and narrow-layout states, not just installed from a catalog.

For serving commands, tests and known limitations, use the [development guide](development.md#react-frontend).
