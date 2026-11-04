# UI architecture and assistant integration

See the [usage guide](usage.md) for operating the app and the [development guide](development.md) for setup,
tests and backend boundaries. This guide records the current UI foundation and the decisions needed to maintain it.

## Foundation and ownership

The frontend uses React, strict TypeScript, Vite and Tailwind 4. Standard controls use shadcn **base-nova**
with `@base-ui/react`, neutral light/dark themes and the supplied component variants. Assistant conversations use
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

The workspace has a dedicated Chat panel on the left, a model canvas in the center and a Workbench
panel on the right. This lets a person read an answer while inspecting its evidence. The assistant belongs
to the investigation rather than one neuron. A floating assistant modal would cover the scientific workspace.

The global header owns model identity and Go to unit. Closed panels have floating openers at the scene edges
below the toolbar; their headers contain collapse controls. Visibility is remembered across refreshes.
Canvas controls own Map/Embeddings,
actual layer scope and camera reset. Visualization preferences live in the top-bar Settings dialog. Search, Analyze, Inspect and Cache are explicit tasks;
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
| Find in conversation | Official ConversationSearch with literal, case-insensitive public text matching, highlighted result previews and message navigation. Search excludes tool payloads and marked commentary. Enter/Shift+Enter step through matches; Escape returns focus to the trigger. Ctrl/Cmd+F opens search while focus is in the assistant. Query state resets with the conversation runtime. |
| Response text | The official MarkdownTextPrimitive provides smooth streaming and GFM formatting, with no custom word-animation layer. Official Shiki registry components highlight settled code and skip tokenization while streaming. The base source preserves whitespace rather than trimming research code. A remark AST plugin links valid neuron references while preserving existing links and code. |
| Waiting state | The official registry TypingIndicator (bare variant) appears only before the first content arrives. Once a tool or text part exists, its own presentation takes over. |
| Run activity and recovery | Official GroupedParts drives an app-specific RunActivity disclosure: a live “Working for…” timer with visible public updates, then a collapsed “Worked for…” history when the answer begins. Nested tool groups keep detailed results compact. Answers, unclassified text, findings, failures and approvals remain outside the activity disclosure. Empty runs use TypingIndicator. ErrorState, ConnectionState and MessageQueue use real retry, replay and queue operations. Stopped responses keep their Markdown and offer Retry response on the latest idle turn. |
| Assistant model | AssistantModelSettings uses the shared ChoiceSelect and backend catalog inside Settings → Chat. The composer bridge registers the selected model ID with assistant-ui. Unsupported model metadata is omitted. |
| Dictation | Thread microphone/ComposerVoice controls backed by WebSpeechDictationAdapter where supported. |
| Settings | One top-bar Dialog with Appearance, Chat, and Visualization navigation. Theme, provider, model, selected-unit context, file scope, map layout, connections, and embedding colors live here. Field, Select, Switch, and RadioGroup provide the options. |
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

All assistant messages use the shared `ThreadMessageParts` renderer and assistant-ui's
`MessagePrimitive.GroupedParts`. `ResearchMessageParts` only supplies grouping rules for explicitly
identified public commentary and tool activity; it does not render leaves or reconstruct reasoning groups.
Adjacent activity stays in transcript order. Findings, failures and pending tool decisions stay outside
activity disclosures. Tool summaries use `lib/tool-labels.ts`; exact backend tool
identifiers remain available inside Details.

Replaying history only folds journal events into typed messages. It never repeats experiments, map commands
or shell approvals. Legacy HTML caches are imported as text only when the backend has no history. Tool cards
are presentation-only; execution and permission enforcement remain on the server. Completed attachment-chip
removal also updates persisted drafts because the runtime does not call upload removal for completed files.

The acknowledged browser protocol still accepts `chat/details/examples`, mapped to Inspect →
Experiment/Overview/Saved examples. UI state reports actual responsive visibility; submitting a hidden
Experiment is rejected. Selection links remain shareable, and manual and agent actions use the same handlers.

Stop preserves partial responses. Enter queues during an active turn; “Interrupt and send now” explicitly stops the current turn and sends the next queued message. Drafts, uploads and
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

## Unified settings

The icon-only Settings button to the left of search opens a single responsive dialog. A left navigation column selects
Appearance, Chat, or Visualization; on narrow screens it becomes a row above the options.
Each section scrolls independently, while the title and close button stay visible.
The Chat section owns model discovery and file permissions. The composer bridge keeps the selected
model registered with assistant-ui and publishes transient dictation state so provider, model and access
controls remain locked during replies, recording, and uploads. Message attachments and selection-context
removal remain direct actions on a draft. Map/Embeddings, layer navigation and camera reset remain workspace actions.

## Styling and component updates

Light/dark mode follows the official [shadcn Vite provider](https://ui.shadcn.com/docs/dark-mode/vite)
and [CSS-variable theming](https://ui.shadcn.com/docs/theming) patterns. `ThemeProvider` wraps the app;
the Appearance selector stores Light/Dark/System under `neuron-explorer-theme`, defaulting to Dark.
Light tokens live in `:root`, dark overrides in `.dark`, and `color-scheme` also drives native controls
and Shiki's existing `light-dark()` syntax colors. Assistant panels and portals inherit the root theme.
The head script applies the saved class before paint, as recommended by [Tailwind](https://tailwindcss.com/docs/dark-mode).
System preference listeners and cross-tab storage events keep the selection synchronized.
Canvas renderers observe root class changes, resolve scene colors and redraw without resetting view state;
the map uses semantic palettes with neutral structure, green/red signed links, amber activity, and blue selection in `explorer/static/map-palette.js` and normal alpha
blending in both modes. Its raw point shader uses Three.js's sRGB output conversion, bounded point sizes,
and distance-dependent opacity rather than boosting RGB intensity. Idle neuron sheets use smaller, low-opacity points in the 3D overview; single-layer inspection
and scientific activity retain stronger point visibility. Direct and multi-hop links use screen-space
strokes with per-segment opacity, preserving assigned hues instead of mixing them with gray or black.
Connections and endpoints render above structural depth; distant multi-hop endpoints recede so dense
networks do not become solid color clouds. Structure fades around the focused
layer; selected neurons have a contrasting ring, while signed connections retain green/red hues and screen-space
line widths. Theme changes repaint cached scientific colors without resetting the camera or selection.
`scene-colors.js` owns validated per-theme overrides under `neuron-explorer-scene-colors-v1`.
Scene colors are always visible in Visualization settings. The editor uses shared Input, Button and
ChoiceSelect controls, with a native color input and an inline hex field for each role. Values are normalized to six-digit hex and exact duplicates
are rejected across editable roles. Role defaults are distinct; untouched saved defaults receive palette updates, while customized palettes are preserved. Supporting structure shades are derived
from the chosen colors. Same-tab color events and cross-tab storage events repaint the map in place.
The [Generative Frame theming guide](https://www.assistant-ui.com/generative-frame/docs/theming)
describes separate iframe token forwarding; this app currently uses native assistant-ui components,
so no Generative Frame dependency or iframe theme bridge is needed.

IBM Plex Sans and IBM Plex Mono are bundled through Fontsource and served locally, with `font-display: swap`.
`frontend/src/main.tsx` imports the faces; Tailwind's shared `--font-sans` and `--font-mono` tokens own the stacks,
and legacy explorer styles use those same tokens. System fallbacks cover scripts outside the bundled fonts.
Ligatures are disabled and tables use tabular numerals. Canvas layer labels repaint once the mono face loads.
Font license notices are included in `frontend/public/licenses/` and copied into the build.
Scrollbar sizing and colors live in the shared base layer so Explorer, chat, code blocks and portalled controls
use the same thin native scrollbars. Older WebKit uses an 8 px fallback; forced-color mode retains system colors.

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

## Run presentation

Codex agent-message item IDs and explicit `commentary` / `final_answer` phases are preserved in durable events, including phase notifications arriving after text. Unclassified public text preceding a tool call is marked as commentary, supporting providers without phase markers; other unclassified text remains visible. Private Claude reasoning is excluded. Consecutive text from distinct provider items stays in distinct parts. RunActivity uses those stable part IDs, keeps errors/cancellations and scientific findings outside its disclosure, and locks the viewport while expansion changes. Activity expands during work and collapses when a final-answer phase or successful findings result arrives. The elapsed time starts with the user event and freezes at that boundary (terminal timestamp fallback for older histories); stopped and failed runs retain their distinct labels. Timer ticks are not live-announced to screen readers. Public progress updates are requested at meaningful milestones and roughly every 30–60 seconds of extended tool work; the UI never invents findings to fill silence.

New journal records carry server timestamps. Settled durations derive from persisted user-event and work-boundary times (assistant/terminal timestamps for older histories), never mount time; imported transcripts without original timestamps omit durations. Approval decisions are journaled before granting execution so their receipts survive refresh. A cancelled, interrupted or failed provider completion cannot become a successful completion just because streaming stopped. Recovery regenerates the latest turn, not the exact cut-off prefix. Individual-tool retry and discard are not offered without their backing operations.


### Temporary chat scene focus

`assistant/scene-activity.ts` is the sole tool-to-subject mapping and live-turn controller. It validates
subjects against the active architecture, coalesces rapid calls, and combines concurrent targets. Completed
targeted calls become “Reviewing” while the assistant reads their results; terminal/final-answer events,
chat changes and disposal clear focus. Finished history never replays scene effects; reconnecting to a running
turn reconstructs only its current work. Search results and broad/all-layer interventions do not imply visits
to individual returned neurons. Explicit user-requested scene-control tools retain their existing behavior.

`explorer.actions.setChatActivity` prepares a separate display payload, with bounded per-model caches shared
with selection for direct connections and signed webs. Target epochs reject stale asynchronous responses;
model/store disposal aborts requests. Comparisons up to six subjects use direct networks; larger batches show
all subject markers without requesting hundreds of webs. Missing network data leaves truthful subject markers.
No selection, URL, inspector data, scientific marks or camera state is changed by automatic activity.

`chat-scene-focus.js` owns the transient Three.js layer, projected status label, moving cursor and short
crossfades. The cursor travels between actual single targets; batches have equal target rings and no fictitious
travel through their members. Existing selection layers blend to a muted neutral while another target is active,
then restore. Identical user/chat focus reuses the selected network. `scene-materials.js` and `scene-web.js`
share the original point/line styling and through-path attenuation between both networks. Animation uses the
map's existing request-on-demand render loop, respects reduced motion, and leaves the camera untouched.
Labels dock at the viewport edge in the target's direction when it leaves the view; camera-space direction prevents mirrored placement behind the camera. The label text stays the same on and off screen. GPU geometries are disposed when replaced;
listeners and labels are removed with the map.

The projected activity label uses the same Lucide Bot icon as Chat settings and a translucent, blurred
popover surface. Its accessible name identifies chat activity. One React icon root is disposed with the map;
reduced-transparency preferences use an opaque surface. Camera matrices update before projection so the label
stays anchored during orbit, zoom and resize.

Manual selection updates Inspect immediately. A different selection remains muted while chat has an active
subject; selecting that exact subject reuses the ordinary full-color network. The latest manual selection
remains selected when chat finishes. Workbench/Inspect tabs and their analysis mode persist across refreshes.

Regression coverage includes target validation, concurrent work, cleanup, running-history reconnect,
selection isolation, request sharing, large batches, cursor motion, theme/layout changes, same-selection
behavior, signed-web attenuation, viewport edges, reduced motion and disposal. Live browser verification
also exercised reading, steering, comparisons, manual selection, camera movement and refresh during a run.
Local evaluation artifacts belong under the ignored `output/evaluations/` directory.
