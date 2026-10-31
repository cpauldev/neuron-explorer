"use client";

import { AuiIf, useAuiState, ThreadPrimitive } from "@assistant-ui/react";
import { useState } from "react";
import { Button } from "./ui/button";
import { Popover, PopoverTrigger, PopoverContent } from "./ui/popover";

function FollowupQuestion({
  title,
  prompt,
}: {
  title: string;
  prompt: string;
}) {
  const [open, setOpen] = useState(false);
  const hasDraft = useAuiState((s) => Boolean(s.composer.text.trim()));
  // Clarify a legacy suggestion without rewriting its persisted research question.
  const label = /^break the label[.!?]?$/i.test(title.trim())
    ? "Find counterexamples"
    : title;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            className="h-auto max-w-full whitespace-normal py-1 text-left"
          />
        }
      >
        {label}
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="max-h-[60vh] w-80 max-w-[calc(100vw-2rem)] space-y-3 overflow-y-auto"
      >
        <h3 className="text-sm font-medium">Suggested question</h3>
        <p className="whitespace-pre-wrap text-sm leading-relaxed [overflow-wrap:anywhere]">
          {prompt}
        </p>
        <ThreadPrimitive.Suggestion
          prompt={prompt}
          send={false}
          asChild
          onClick={() => setOpen(false)}
        >
          <Button size="sm">
            {hasDraft ? "Replace draft" : "Use question"}
          </Button>
        </ThreadPrimitive.Suggestion>
      </PopoverContent>
    </Popover>
  );
}

function FollowupSuggestionsRow() {
  const suggestions = useAuiState((s) => s.thread.suggestions);
  return (
    <div
      className="aui-thread-followup-suggestions flex w-full flex-wrap gap-2"
      aria-label="Suggested follow-up questions"
    >
      {suggestions.map((suggestion, i) => (
        <FollowupQuestion
          key={`${i}/${suggestion.prompt}`}
          title={suggestion.title ?? suggestion.prompt}
          prompt={suggestion.prompt}
        />
      ))}
    </div>
  );
}

export const ThreadFollowupSuggestions = () => (
  <AuiIf
    condition={(s) =>
      !s.thread.isEmpty &&
      !s.thread.isRunning &&
      s.thread.suggestions.length > 0
    }
  >
    <FollowupSuggestionsRow />
  </AuiIf>
);
