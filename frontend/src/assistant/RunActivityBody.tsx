import { useRef, useState, type PropsWithChildren } from "react";
import {
  MessagePrimitive,
  useAuiState,
  useScrollLock,
  type TextMessagePartComponent,
} from "@assistant-ui/react";
import {
  RunActivity,
  type RunActivityEntry,
  type RunActivityStatus,
} from "../components/run-activity";
import { ToolFallback } from "../components/tool-fallback.aui";
import type { MessageMetadata } from "../types";
import { isRecord, unpack } from "./research";

/** Presentation annotations come from provider item IDs, never inferred prose. */
export function RunActivityBody({
  children,
  Text,
}: PropsWithChildren<{ Text: TextMessagePartComponent }>) {
  const message = useAuiState((s) => s.message);
  const meta = message.metadata.custom as MessageMetadata;
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const lockScroll = useScrollLock(root, 200);
  const entries: RunActivityEntry[] = [];
  const attention = [];
  const answer = [];
  const components = { Text, tools: { Fallback: ToolFallback } };
  for (const [index, part] of message.parts.entries()) {
    const content = (
      <MessagePrimitive.PartByIndex
        key={
          part.type === "tool-call"
            ? `tool:${part.toolCallId}`
            : part.type === "text" && part.id
              ? `text:${part.id}`
              : index
        }
        index={index}
        components={components}
      />
    );
    if (part.type === "tool-call") {
      const result = unpack(part.result);
      const name = part.toolName.split("__").at(-1) || part.toolName;
      // This app's findings tool is answer content, as declared by its toolkit.
      if (name === "present_findings") {
        answer.push(content);
        continue;
      }
      if (
        part.isError ||
        (isRecord(result) && typeof result.error === "string") ||
        part.status.type === "requires-action" ||
        part.status.type === "incomplete"
      )
        attention.push(content);
      else
        entries.push({
          id: part.toolCallId,
          kind: "tool",
          label: name,
          content,
        });
    } else if (
      part.type === "text" &&
      part.id &&
      meta.textPhases?.[part.id] === "commentary"
    ) {
      entries.push({
        id: part.id,
        kind: "commentary",
        label: "Working",
        content,
      });
    } else answer.push(content);
  }
  // Keep the standard Thread for empty runs and transcripts with no activity.
  if (!entries.length && !attention.length) return children;
  const pending = meta.approvals?.some((a) => a.state === "request");
  let status: RunActivityStatus = "complete";
  if (pending) status = "requires-action";
  else if (message.status?.type === "running") status = "running";
  else if (message.status?.type === "incomplete") {
    status =
      message.status.reason === "cancelled"
        ? "cancelled"
        : message.status.reason === "error"
          ? "error"
          : "incomplete";
  }
  const label = {
    running: "Working",
    "requires-action": "Waiting for approval",
    complete: "Completed",
    cancelled: "Stopped",
    incomplete: "Incomplete",
    error: "Could not complete",
  }[status];
  const duration =
    meta.startedAt !== undefined && meta.endedAt !== undefined
      ? `${Math.max(0, Math.round((meta.endedAt - meta.startedAt) / 1000))}s`
      : undefined;
  return (
    <div ref={root}>
      <RunActivity
        status={status}
        statusLabel={label}
        durationLabel={duration}
        entries={entries}
        open={open}
        onOpenChange={(value) => {
          lockScroll();
          setOpen(value);
        }}
        attention={attention}
      >
        {answer}
      </RunActivity>
    </div>
  );
}
