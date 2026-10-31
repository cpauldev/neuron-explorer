// Fold the server-owned journal into assistant-ui message parts. This function
// has no UI side effects: replaying history must never execute explorer commands.
import type { AssistantMessage, JournalEvent } from "../types";
export function appendEvent(
  messages: AssistantMessage[],
  event: JournalEvent,
  chat = "new",
): AssistantMessage[] {
  const id = `${chat}:${event.seq ?? crypto.randomUUID()}`;
  if (event.t === "user")
    return [
      ...messages,
      {
        id,
        role: "user",
        content: [{ type: "text", text: event.shown || event.text }],
        metadata: {
          custom: {
            context: event.context,
            original: event.text,
            shown: event.shown || event.text,
            files: event.attachments || [],
          },
        },
      },
    ];
  if (event.t === "chat" || event.t === "ui") return messages;
  let next = [...messages],
    last = next.at(-1);
  if (!last || last.role !== "assistant") {
    if (event.t === "done") return messages;
    last = {
      id,
      role: "assistant",
      content: [],
      status: { type: "running" },
      metadata: { custom: { approvals: [] } },
    };
    next.push(last);
  }
  last = {
    ...last,
    content: [...last.content],
    metadata: { custom: { ...last.metadata?.custom } },
  };
  next[next.length - 1] = last;
  const meta = last.metadata.custom;
  if (event.t === "text") {
    const part = last.content.at(-1);
    if (part?.type === "text")
      last.content[last.content.length - 1] = {
        ...part,
        text: part.text + event.text,
      };
    else last.content.push({ type: "text", text: event.text });
  } else if (event.t === "tool") {
    last.content.push({
      type: "tool-call",
      toolCallId: event.id || id,
      toolName: event.name,
      args: event.input || {},
      argsText: JSON.stringify(event.input || {}),
    });
  } else if (event.t === "tool_result") {
    last.content = last.content.map((part) =>
      part.type === "tool-call" && part.toolCallId === event.id
        ? {
            ...part,
            result: event.output ?? "",
            isError: Boolean(event.error),
          }
        : part,
    );
  } else if (event.t === "approval")
    meta.approvals = [
      ...(meta.approvals || []),
      { ...event, state: "request" },
    ];
  else if (event.t === "stopped") {
    last.status = { type: "incomplete", reason: "cancelled" };
    meta.stopped = true;
  } else if (event.t === "error") {
    meta.error = event.error;
    last.status = { type: "incomplete", reason: "error", error: event.error };
  } else if (event.t === "done") {
    if (!meta.stopped && !meta.error)
      last.status = { type: "complete", reason: "stop" };
    meta.approvals = (meta.approvals || []).map((a) =>
      a.state === "request" ? { ...a, state: "expired" } : a,
    );
  }
  return next;
}

export function replayEvents(
  events: JournalEvent[],
  chat: string,
  pending: string[] = [],
): AssistantMessage[] {
  return events
    .reduce<AssistantMessage[]>(
      (messages, e) => appendEvent(messages, e, chat),
      [],
    )
    .map((m) =>
      m.role === "assistant"
        ? {
            ...m,
            metadata: {
              custom: {
                ...m.metadata.custom,
                approvals: (m.metadata.custom.approvals || []).map((a) => ({
                  ...a,
                  state:
                    a.state === "request" && pending.includes(a.id)
                      ? "request"
                      : a.state === "request"
                        ? "expired"
                        : a.state,
                })),
              },
            },
          }
        : m,
    );
}
