import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PropsWithChildren,
} from "react";
import { useAuiState, useScrollLock } from "@assistant-ui/react";
import {
  RunActivity,
  type RunActivityStatus,
} from "../components/run-activity";
import {
  ThreadMessageParts,
  messageGroupBy,
  type ThreadGroupPart,
  type ThreadPartGroupBy,
} from "../components/thread.aui";
import type { MessageMetadata } from "../types";
import { isRecord, unpack } from "./research";

function formatDuration(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function ActivityGroup({
  group,
  children,
}: PropsWithChildren<{ group: ThreadGroupPart }>) {
  const message = useAuiState((s) => s.message);
  const meta = message.metadata.custom as MessageMetadata;
  const [disclosure, setDisclosure] = useState<{
    active: boolean;
    open: boolean;
  }>();
  const [now, setNow] = useState(Date.now);
  const root = useRef<HTMLDivElement>(null);
  const lockScroll = useScrollLock(root, 200);
  const pending = meta.approvals?.some((a) => a.state === "request");
  let status: RunActivityStatus = "complete";
  if (pending) status = "requires-action";
  else if (message.status?.type === "incomplete") {
    status =
      message.status.reason === "cancelled"
        ? "cancelled"
        : message.status.reason === "error"
          ? "error"
          : "incomplete";
  } else if (
    message.status?.type === "running" &&
    meta.workEndedAt === undefined
  )
    status = "running";
  const active = status === "running" || status === "requires-action";
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  const startedAt = meta.startedAt ?? group.timing?.startedAt;
  const endedAt = meta.workEndedAt ?? meta.endedAt ?? group.timing?.completedAt;
  const duration =
    startedAt === undefined
      ? undefined
      : formatDuration((active ? now : (endedAt ?? startedAt)) - startedAt);
  const open = disclosure?.active === active ? disclosure.open : active;
  const label = {
    running: duration ? "Working for" : "Working",
    "requires-action": "Waiting for approval",
    complete: duration ? "Worked for" : "Worked",
    cancelled: "Stopped",
    incomplete: "Incomplete",
    error: "Could not complete",
  }[status];
  return (
    <div ref={root}>
      <RunActivity
        status={status}
        statusLabel={label}
        durationLabel={duration}
        entries={[
          {
            id: "parts",
            kind: "commentary",
            label: "",
            content: <div className="space-y-3">{children}</div>,
          },
        ]}
        open={open}
        onOpenChange={(value) => {
          lockScroll();
          setDisclosure({ active, open: value });
        }}
      />
    </div>
  );
}

/** Classify public commentary by persisted IDs; all leaves use Thread's shared renderer. */
export function ResearchMessageParts() {
  const phases = useAuiState(
    (s) => (s.message.metadata.custom as MessageMetadata).textPhases,
  );
  const groupBy = useCallback<ThreadPartGroupBy>(
    (part, context) => {
      if (part.type === "text" && part.id && phases?.[part.id] === "commentary")
        return ["group-activity"];
      const standard = messageGroupBy(part, context);
      if (part.type === "reasoning") return ["group-activity", ...standard];
      if (part.type !== "tool-call" || !standard.length) return standard;
      const result = unpack(part.result);
      if (
        part.isError ||
        (isRecord(result) && typeof result.error === "string") ||
        part.status.type === "requires-action" ||
        part.status.type === "incomplete"
      )
        return [];
      return ["group-activity", "group-tool"];
    },
    [phases],
  );
  return <ThreadMessageParts groupBy={groupBy} ActivityGroup={ActivityGroup} />;
}
