import { useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  useAui,
  useAuiState,
  AuiConfig,
  Tools,
  ThreadListPrimitive,
} from "@assistant-ui/react";
import type { ThreadMessageLike } from "@assistant-ui/react";
import { GenerationLoadingState } from "../components/loading-state";
import type {
  ApprovalRequest,
  MessageMetadata,
  AssistantMessage,
} from "../types";
import {
  AssistantContext,
  useAssistant,
  useExplorer,
  useStore,
} from "../context";
import { ComposerModelPicker } from "./ComposerModelPicker";
import { ComposerSelection, SentContext } from "./SelectionContext";
import { latestFindings } from "./research";
import { remarkUnitLinks } from "./unit-links";
import { ResearchMessageParts } from "./ResearchMessageParts";
import { ConversationSearchPanel } from "./ConversationSearchPanel";
import { toolkit } from "./toolkit";
import { attachmentAdapter } from "./attachments";
import { MarkdownText } from "../components/markdown-text";
import { ErrorState } from "../components/error-state";
import { Thread } from "../components/thread.aui";
import { ThreadList } from "../components/thread-list.aui";
import { TooltipProvider } from "../components/ui/tooltip";
import { Button } from "../components/ui/button";
import { TooltipIconButton } from "../components/tooltip-icon-button";
import { ApprovalCard } from "../components/approval-card";
import { ConnectionState } from "../components/connection-state";
import { MessageQueue } from "../components/message-queue";
import { browserDictation } from "./dictation";
import { ConfirmDialog } from "../components/confirm-dialog";
import {
  HistoryIcon,
  PlusIcon,
  SparklesIcon,
  PanelLeftCloseIcon,
  SearchIcon,
  ArrowLeftIcon,
} from "lucide-react";
import { refLabel } from "../lib/store";

function ResearchMarkdown() {
  const [, a] = useExplorer([]);
  const plugins = useMemo(
    () => [
      remarkUnitLinks((unit) =>
        unit.kind === "head"
          ? a.validHead(unit.layer, unit.n)
          : a.validNeuron(unit.layer, unit.n),
      ),
    ],
    [a],
  );
  return <MarkdownText remarkPlugins={plugins} />;
}
const convertMessage = (message: AssistantMessage): ThreadMessageLike => ({
  ...message,
  ...(message.role === "user"
    ? {
        attachments: (message.metadata.custom.files || []).map((file) => ({
          id: file.id || file.key || file.name,
          type: "document",
          name: file.name,
          status: { type: "complete" as const },
          content: [],
        })),
      }
    : {}),
});
const suggestions = [
  {
    title: "Understand steering",
    prompt:
      "Explain how neuron steering works in this explorer and how to compare positive, negative, and baseline doses.",
  },
  {
    title: "Read the model map",
    prompt:
      "Explain the writes and reads layouts, and how I should use the connection web to investigate a circuit.",
  },
  {
    title: "Start an investigation",
    prompt:
      "Help me investigate a concept in this model. Ask which concept I want to explore, then explain how we can find and verify relevant neurons.",
  },
];
function ShellApproval({ request }: { request: ApprovalRequest }) {
  const [s, a] = useAssistant(["busy"]);
  const active = request.state === "request" && s.busy;
  const label =
    request.state === "approved"
      ? "Approved"
      : request.state === "denied"
        ? "Declined"
        : active
          ? "Waiting for approval"
          : "No longer pending";
  return (
    <ApprovalCard
      className="shell-approval"
      title={
        request.kind === "file_write"
          ? "Overwrite this file?"
          : "Run this shell command?"
      }
      subtitle={
        request.kind === "file_write"
          ? "File overwrite approval"
          : "Shell command approval"
      }
      command={request.command}
      description={
        request.kind === "file_write"
          ? "Replaces the existing file with the contents shown below."
          : "Runs with your user account. The starting directory does not restrict file or network access."
      }
      details={[
        {
          label: "Starting directory",
          value: request.cwd || "Project directory",
        },
      ]}
      state={
        active
          ? "request"
          : request.state === "denied" || request.state === "expired"
            ? "denied"
            : "done"
      }
      allowOnceLabel={
        request.kind === "file_write" ? "Overwrite file" : "Run command"
      }
      denyLabel="Decline"
      statusLabel={request.error || label}
      onAllowOnce={
        active && !request.submitting
          ? () => a.safe(a.approve(request.id, true))
          : undefined
      }
      onDeny={
        active && !request.submitting
          ? () => a.safe(a.approve(request.id, false))
          : undefined
      }
    />
  );
}

function MessageExtra() {
  const message = useAuiState((s) => s.message);
  const meta = message.metadata.custom as MessageMetadata;
  const [s, a] = useAssistant(["busy", "messages", "chat"]);
  const latest =
    message.id === s.messages.findLast((m) => m.role === "assistant")?.id;
  return (
    <>
      {meta.error ? (
        <ErrorState
          title="Response failed"
          detail={meta.error}
          retrying={false}
          className="my-3 max-w-none"
          onRetry={
            !s.busy && latest ? () => a.safe(a.retryLatest()) : undefined
          }
        />
      ) : null}
      {(meta.approvals || []).map((request) => (
        <ShellApproval key={request.id} request={request} />
      ))}
      {meta.stopped ? (
        <div className="flex items-center gap-2 text-sm">
          <p role="status" className="text-muted-foreground">
            Response stopped. Partial response kept.
          </p>
          {latest && !s.busy ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => a.safe(a.retryLatest())}
            >
              Retry response
            </Button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
function Welcome() {
  return (
    <div className="mb-6 px-2">
      <SparklesIcon className="text-muted-foreground mb-5 size-6" aria-hidden />
      <h2 className="text-2xl font-medium tracking-tight">Explore the model</h2>
      <p className="text-muted-foreground mt-2 text-sm leading-relaxed">
        Ask about neurons, attention heads, or circuits.
      </p>
    </div>
  );
}
function Footer() {
  const [s, a] = useAssistant([
    "queue",
    "connection",
    "error",
    "busy",
    "chat",
    "suggestedName",
    "messages",
  ]);
  const [e] = useExplorer(["focus"]);
  const lastUser = s.messages.findLast((m) => m.role === "user");
  const hasRelevantReport = s.messages.some((message) =>
    latestFindings([message])?.references.some(
      (unit) =>
        e.focus &&
        unit.layer === e.focus.layer &&
        unit.n === e.focus.n &&
        unit.kind === e.focus.kind,
    ),
  );
  return (
    <>
      {s.connection ? (
        <ConnectionState phase="reconnecting" role="status" />
      ) : null}
      {s.error && s.messages.at(-1)?.metadata.custom.error !== s.error ? (
        <ErrorState
          title="Could not complete the request"
          detail={s.error}
          retrying={s.busy}
          className="max-w-none"
          onRetry={
            lastUser || s.chat ? () => a.safe(a.retryLatest()) : undefined
          }
        />
      ) : null}
      {s.queue.length ? (
        <div className="assistant-queue">
          <MessageQueue
            running="Assistant is working"
            queued={s.queue.map((q) => ({
              id: q.id,
              text: q.context ? `${q.shown} · ${refLabel(q.context)}` : q.shown,
            }))}
            onCancel={a.dropQueue}
          />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => a.safe(a.interruptQueue())}
          >
            Interrupt and send now
          </Button>
        </div>
      ) : null}
      {s.suggestedName ? (
        <Button variant="outline" size="sm" onClick={a.useName}>
          Use name: {s.suggestedName.name}
        </Button>
      ) : null}
      {!s.busy &&
      !hasRelevantReport &&
      e.focus &&
      ["neuron", "head"].includes(e.focus.kind) ? (
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={a.explain}>
            Explain this {e.focus.kind === "head" ? "head" : "neuron"}
          </Button>
          {e.focus.kind === "neuron" ? (
            <Button variant="outline" size="sm" onClick={a.explainWeb}>
              Investigate connections
            </Button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
function ComposerBridge() {
  const store = useContext(AssistantContext)!,
    aui = useAui();
  const [s] = useAssistant(["draft", "model"]);
  const dictating = useAuiState(
    (state) => state.composer.dictation !== undefined,
  );
  useEffect(() => {
    store.set({ dictating });
    return () => {
      store.set({ dictating: false });
    };
  }, [store, dictating]);
  useEffect(
    () =>
      aui.modelContext.register({
        getModelContext: () => ({
          config: s.model ? { modelName: s.model } : {},
        }),
      }),
    [aui, s.model],
  );
  useEffect(() => {
    const composer = aui.composer;
    const initial = store.getSnapshot();
    composer.setText(initial.draft);
    for (const p of initial.pending)
      if (p.id)
        void composer.addAttachment({
          id: p.key || p.id,
          name: p.name,
          type: "document",
          content: [],
        });
    let previous = new Set(composer.getState().attachments.map((a) => a.id));
    return aui.subscribe(() => {
      const state = composer.getState();
      if (state.text !== store.getSnapshot().draft)
        store.actions.draft(state.text);
      const current = new Set(
        [...state.attachments, ...(state.submission?.attachments || [])].map(
          (a) => a.id,
        ),
      );
      for (const id of previous)
        if (!current.has(id)) store.actions.removeAttachment(id);
      previous = current;
    });
  }, [aui, store]);
  useEffect(() => {
    if (!s.draft && aui.composer.getState().text) aui.composer.setText("");
  }, [s.draft, aui]);
  return null;
}
function AssistantContents({
  active,
  voiceError,
}: {
  active: boolean;
  voiceError: string;
}) {
  const [searchOpen, setSearchOpen] = useState(false);
  const transcript = useRef<HTMLDivElement>(null);
  const searchTrigger = useRef<HTMLButtonElement>(null);
  const closeSearch = () => {
    setSearchOpen(false);
    searchTrigger.current?.focus();
  };
  const [, explorer] = useExplorer([]);
  const [s, a] = useAssistant([
    "provider",
    "access",
    "busy",
    "pending",
    "historyOpen",
    "historyLoading",
    "history",
    "messages",
    "error",
  ]);
  const aui = useAui();
  const dictating = useAuiState((s) => s.composer.dictation !== undefined);
  const locked = s.busy || dictating || s.pending.some((p) => !p.id);
  const editableId = s.messages.findLast((m) => m.role === "user")?.id;
  const latestAssistant = s.messages.findLast((m) => m.role === "assistant");
  const regeneratableId =
    latestAssistant?.metadata.custom.error ||
    latestAssistant?.metadata.custom.stopped
      ? undefined
      : latestAssistant?.id;
  const components = useMemo(
    () => ({
      Welcome,
      MessageExtra,
      MessageParts: ResearchMessageParts,
      Footer,
      Text: ResearchMarkdown,
      ComposerContext: ComposerSelection,
      ComposerExtra: ComposerModelPicker,
      UserMessageExtra: SentContext,
      ComposerInputProps: {
        onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) =>
          a.draft(e.target.value),
        onKeyDownCapture: (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
          if (
            !s.busy ||
            e.key !== "Enter" ||
            e.shiftKey ||
            e.nativeEvent.isComposing
          )
            return;
          e.preventDefault();
          e.stopPropagation();
          if (a.send(aui.composer.getState().text)) {
            aui.composer.setText("");
            void aui.composer.clearAttachments();
          }
        },
      },
      canEdit: (id: string) => id === editableId,
      canReload: (id: string) => id === regeneratableId,
    }),
    [a, aui, s.busy, editableId, regeneratableId],
  );
  return (
    <div
      id="tab-agent"
      ref={transcript}
      onKeyDown={(event) => {
        if (
          !s.historyOpen &&
          (event.ctrlKey || event.metaKey) &&
          event.key.toLowerCase() === "f"
        ) {
          event.preventDefault();
          setSearchOpen(true);
          transcript.current
            ?.querySelector<HTMLInputElement>(
              '[aria-label="Find in conversation"]',
            )
            ?.select();
        }
        if (searchOpen && event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          closeSearch();
        }
      }}
      className={`tab assistant-surface${active ? " on" : ""}`}
    >
      <ComposerBridge />
      <div
        role="group"
        aria-label="Chat controls"
        className="assistant-toolbar workspace-panel-header"
      >
        {s.historyOpen && (
          <TooltipIconButton
            tooltip="Back to chat"
            onClick={() => a.safe(a.historyToggle())}
          >
            <ArrowLeftIcon />
          </TooltipIconButton>
        )}
        <h2 className="text-sm font-medium">
          {s.historyOpen ? "Past chats" : "Chat"}
        </h2>
        <div className="ml-auto flex items-center gap-1">
          {!s.historyOpen && (
            <TooltipIconButton
              tooltip="Search conversation"
              ref={searchTrigger}
              aria-expanded={searchOpen}
              onClick={() => setSearchOpen((value) => !value)}
            >
              <SearchIcon />
            </TooltipIconButton>
          )}
          {!s.historyOpen && (
            <TooltipIconButton
              tooltip="Past chats"
              aria-label="Past chats"
              aria-expanded={s.historyOpen}
              disabled={locked}
              onClick={() => a.safe(a.historyToggle())}
            >
              <HistoryIcon />
            </TooltipIconButton>
          )}
          {!s.historyOpen && (
            <ThreadListPrimitive.New asChild>
              <TooltipIconButton tooltip="New chat" disabled={locked}>
                <PlusIcon />
              </TooltipIconButton>
            </ThreadListPrimitive.New>
          )}
          <TooltipIconButton
            tooltip="Hide chat"
            onClick={() => explorer.togglePanel("assistant", true)}
          >
            <PanelLeftCloseIcon />
          </TooltipIconButton>
        </div>
      </div>
      {searchOpen && !s.historyOpen ? (
        <ConversationSearchPanel
          transcript={transcript}
          onClose={closeSearch}
        />
      ) : null}
      {voiceError ? (
        <ErrorState
          title="Dictation unavailable"
          detail={voiceError}
          retrying={false}
          className="m-3 w-auto max-w-none"
        />
      ) : null}
      {s.historyOpen ? (
        <section
          aria-label="Past chats"
          className="flex min-h-0 flex-1 flex-col overflow-auto p-3"
        >
          {s.error && (
            <p role="alert" className="p-2 text-sm text-destructive">
              {s.error}
            </p>
          )}
          {s.historyLoading ? (
            <GenerationLoadingState label="Loading chats…" />
          ) : (
            <>
              <ThreadList />
              {!s.history.length ? (
                <p className="text-muted-foreground p-2 text-sm">
                  No saved chats yet.
                </p>
              ) : null}
            </>
          )}
        </section>
      ) : (
        <div className="min-h-0 flex-1">
          <Thread autoFocus={false} components={components} />
        </div>
      )}
    </div>
  );
}
function RuntimePanel({ active }: { active: boolean }) {
  const store = useContext(AssistantContext)!,
    s = useStore(store, [
      "messages",
      "busy",
      "loading",
      "pending",
      "history",
      "historyLoading",
      "chat",
      "deletingChat",
    ]);
  const [voiceError, setVoiceError] = useState("");
  const [newChatPrompt, setNewChatPrompt] = useState(false);
  const attachments = useMemo(() => attachmentAdapter(store), [store]);
  const dictation = useMemo(() => browserDictation(setVoiceError), []);
  const runtime = useExternalStoreRuntime({
    messages: s.messages,
    convertMessage,
    isRunning: s.busy,
    isDisabled: !!s.deletingChat,
    isLoading: s.loading,
    suggestions: s.messages.length
      ? (latestFindings(s.messages)?.next_steps || []).map((n) => ({
          title: n.label,
          prompt: n.prompt,
        }))
      : suggestions,
    isSendDisabled: s.pending.some((p) => !p.id),
    onNew: async (message) => {
      store.actions.send(
        message.content
          .flatMap((p) => (p.type === "text" ? [p.text] : []))
          .join("\n"),
      );
    },
    onCancel: store.actions.stop,
    onEdit: async (message) => {
      const original = store
        .getSnapshot()
        .messages.findLast((m) => m.role === "user");
      await store.actions.rewind("edit");
      if (!store.getSnapshot().error) {
        const text = message.content
          .flatMap((p) => (p.type === "text" ? [p.text] : []))
          .join("\n");
        store.actions.send(
          text,
          text,
          store.getSnapshot().pending,
          original?.metadata.custom.context || null,
        );
      }
    },
    onReload: async () => {
      await store.actions.rewind("reroll");
    },
    adapters: {
      attachments,
      dictation,
      threadList: {
        threadId: s.chat || undefined,
        isLoading: s.historyLoading,
        threads: [
          ...s.history,
          ...(s.chat && !s.history.some((h) => h.chat === s.chat)
            ? [
                {
                  chat: s.chat,
                  title: "Current conversation",
                  provider: store.getSnapshot().provider,
                  updated: Date.now() / 1000,
                },
              ]
            : []),
        ].map((h) => ({
          id: h.chat,
          title: h.title,
          status: "regular" as const,
          custom: {
            running: h.running || (h.chat === s.chat && s.busy),
            deleting: h.chat === s.deletingChat,
          },
        })),
        onSwitchToNewThread: async () => {
          const state = store.getSnapshot();
          if (
            state.draft ||
            state.pending.length ||
            state.queue.length ||
            state.busy
          ) {
            setNewChatPrompt(true);
            return;
          }
          await store.actions.newChat();
        },
        onSwitchToThread: async (id) => {
          const h = store.getSnapshot().history.find((h) => h.chat === id);
          if (h) await store.actions.openHistory(id, h.provider);
        },
        onDelete: async (id) => {
          await store.actions.safe(store.actions.deleteHistory(id));
        },
      },
    },
  });
  const config = AuiConfig({ tools: Tools({ toolkit }) });
  return (
    <AssistantRuntimeProvider runtime={runtime} config={config}>
      <TooltipProvider>
        <AssistantContents active={active} voiceError={voiceError} />
        <ConfirmDialog
          open={newChatPrompt}
          onOpenChange={setNewChatPrompt}
          title="Start a new chat?"
          description="Your unsent draft, attachments, and queued messages will be cleared. This conversation stays in Past chats."
          confirmLabel="Start new chat"
          cancelLabel="Keep editing"
          onConfirm={() => store.actions.safe(store.actions.newChat())}
        />
      </TooltipProvider>
    </AssistantRuntimeProvider>
  );
}
export function AssistantPanel({ active }: { active: boolean }) {
  const store = useContext(AssistantContext)!,
    s = useStore(store, ["revision"]);
  // A fresh runtime prevents draft/attachment state leaking between conversations.
  return <RuntimePanel key={s.revision} active={active} />;
}
