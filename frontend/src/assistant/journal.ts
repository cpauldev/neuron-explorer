// Fold the server-owned journal into assistant-ui message parts. This function
// has no UI side effects: replaying history must never execute explorer commands.
import type { AssistantMessage, JournalEvent } from "../types";
import { readFindings } from "./research";
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
        ...(event.at ? { createdAt: new Date(event.at * 1000) } : {}),
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
      ...(event.at ? { createdAt: new Date(event.at * 1000) } : {}),
      content: [],
      status: { type: "running" },
      metadata: {
        custom: {
          approvals: [],
          ...(last?.createdAt || event.at
            ? { startedAt: last?.createdAt?.getTime() ?? event.at! * 1000 }
            : {}),
        },
      },
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
    if (part?.type === "text" && (!event.id || part.id === event.id))
      last.content[last.content.length - 1] = {
        ...part,
        text: part.text + event.text,
      };
    else
      last.content.push({ type: "text", text: event.text, id: event.id || id });
  } else if (event.t === "text_phase") {
    if (event.phase === "commentary" || event.phase === "final_answer")
      meta.textPhases = { ...meta.textPhases, [event.id]: event.phase };
    if (
      event.phase === "final_answer" &&
      event.at &&
      meta.workEndedAt === undefined
    )
      meta.workEndedAt = event.at * 1000;
  } else if (event.t === "tool") {
    // Providers without phase markers still expose public pre-tool text as updates.
    meta.textPhases = { ...meta.textPhases };
    for (const part of last.content)
      if (part.type === "text" && part.id && !meta.textPhases[part.id])
        meta.textPhases[part.id] = "commentary";
    last.content.push({
      type: "tool-call",
      toolCallId: event.id || id,
      toolName: event.name,
      args: event.input || {},
      argsText: JSON.stringify(event.input || {}),
    });
  } else if (event.t === "tool_result") {
    const call = last.content.find(
      (part) => part.type === "tool-call" && part.toolCallId === event.id,
    );
    if (
      call?.type === "tool-call" &&
      call.toolName.split("__").at(-1) === "present_findings" &&
      !event.error &&
      readFindings(event.output) &&
      event.at &&
      meta.workEndedAt === undefined
    )
      meta.workEndedAt = event.at * 1000;
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
  else if (event.t === "approval_result") {
    meta.approvals = (meta.approvals || []).map((approval) =>
      approval.id === event.id ? { ...approval, state: event.state } : approval,
    );
  } else if (event.t === "stopped") {
    if (event.at) meta.endedAt = event.at * 1000;
    last.status = { type: "incomplete", reason: "cancelled" };
    meta.stopped = true;
  } else if (event.t === "error") {
    if (event.at) meta.endedAt = event.at * 1000;
    meta.error = event.error;
    last.status = { type: "incomplete", reason: "error", error: event.error };
  } else if (event.t === "done") {
    if (event.at) meta.endedAt = event.at * 1000;
    if (
      !meta.stopped &&
      !meta.error &&
      ["interrupted", "cancelled"].includes(event.status || "")
    ) {
      meta.stopped = true;
      last.status = { type: "incomplete", reason: "cancelled" };
    } else if (!meta.error && event.status === "failed") {
      meta.error = "The provider could not complete the response.";
      last.status = { type: "incomplete", reason: "error", error: meta.error };
    } else if (!meta.stopped && !meta.error)
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
