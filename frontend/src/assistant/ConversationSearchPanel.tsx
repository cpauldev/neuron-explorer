import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { ConversationSearch } from "../components/conversation-search";
import { TooltipIconButton } from "../components/tooltip-icon-button";
import { XIcon } from "lucide-react";
import { useAssistant } from "../context";
import { findConversationHits } from "./conversation-search";

export function ConversationSearchPanel({
  transcript,
  onClose,
}: {
  transcript: RefObject<HTMLDivElement | null>;
  onClose: () => void;
}) {
  const [s] = useAssistant(["messages"]);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const hits = useMemo(
    () => findConversationHits(s.messages, query),
    [s.messages, query],
  );
  const index = Math.min(activeIndex, Math.max(0, hits.length - 1));
  const active = hits[index];
  useEffect(() => {
    root.current?.querySelector("input")?.focus();
  }, []);
  // Only the active hit changes the viewport; streaming elsewhere cannot steal it.
  useEffect(() => {
    if (!active) return;
    const message = Array.from(
      transcript.current?.querySelectorAll<HTMLElement>("[data-message-id]") ||
        [],
    ).find((el) => el.dataset.messageId === active.messageId);
    message?.scrollIntoView({ block: "center", behavior: "instant" });
  }, [active?.id, active?.messageId, transcript]);
  const step = (delta: number) => {
    if (hits.length)
      setActiveIndex((index + delta + hits.length) % hits.length);
  };
  return (
    <section
      aria-label="Search current conversation"
      className="shrink-0 border-b p-2"
      ref={root}
      onKeyDown={(event) => {
        if (
          event.target instanceof HTMLInputElement &&
          event.key === "Enter" &&
          !event.nativeEvent.isComposing
        ) {
          event.preventDefault();
          step(event.shiftKey ? -1 : 1);
        }
      }}
    >
      <div className="flex items-start gap-1">
        <ConversationSearch
          query={query}
          hits={hits}
          activeIndex={index}
          onQueryChange={(value) => {
            setQuery(value);
            setActiveIndex(0);
          }}
          onStep={hits.length ? step : undefined}
          className="max-w-none"
        />
        <TooltipIconButton
          tooltip="Close conversation search"
          onClick={onClose}
        >
          <XIcon />
        </TooltipIconButton>
      </div>
      <p role="status" className="sr-only">
        {query
          ? `${hits.length} matches${hits.length ? `, match ${index + 1}` : ""}`
          : "Type to search this conversation"}
      </p>
    </section>
  );
}
