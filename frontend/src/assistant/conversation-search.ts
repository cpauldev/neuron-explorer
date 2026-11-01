import type { AssistantMessage } from "../types";
import type { SearchHit } from "../components/conversation-search";

export type ConversationHit = SearchHit & { messageId: string };

// Search public transcript text, never tool payloads or collapsed commentary.
export function findConversationHits(
  messages: readonly AssistantMessage[],
  query: string,
): ConversationHit[] {
  if (!query.trim()) return [];
  const pattern = new RegExp(
    query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    "giu",
  );
  return messages.flatMap((message, index) =>
    message.content.flatMap((part, partIndex) => {
      if (
        part.type !== "text" ||
        (part.id &&
          message.metadata.custom.textPhases?.[part.id] === "commentary")
      )
        return [];
      return Array.from(part.text.matchAll(pattern), (match) => ({
        id: `${message.id}:${part.id || partIndex}:${match.index}`,
        messageId: message.id,
        before: part.text.slice(Math.max(0, match.index - 45), match.index),
        match: match[0],
        after: part.text.slice(
          match.index + match[0].length,
          match.index + match[0].length + 65,
        ),
        position: (index * 100) / Math.max(1, messages.length - 1),
      }));
    }),
  );
}
