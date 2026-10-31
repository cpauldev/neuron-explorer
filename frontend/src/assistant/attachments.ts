import type { AttachmentAdapter } from "@assistant-ui/react";
import type { AssistantStore } from "../types";

// Uploads stay local; the official composer owns selection, drop, paste and chips.
export function attachmentAdapter(store: AssistantStore): AttachmentAdapter {
  return {
    accept: "*",
    async *add({ file }) {
      const before = new Set(store.getSnapshot().pending.map((p) => p.key));
      const upload = store.actions.attachFiles([file]);
      const pending = store
        .getSnapshot()
        .pending.find((p) => !before.has(p.key));
      if (!pending) throw new Error("Could not start upload.");
      const base = {
        id: pending.key!,
        type: file.type.startsWith("image/") ? "image" : "document",
        name: file.name,
        contentType: file.type,
        file,
      };
      yield {
        ...base,
        status: { type: "running", reason: "uploading", progress: 0 },
      };
      await upload;
      const ready = store
        .getSnapshot()
        .pending.find((p) => p.key === pending.key);
      yield {
        ...base,
        status: ready?.id
          ? { type: "requires-action", reason: "composer-send" }
          : {
              type: "incomplete",
              reason: "error",
              message: "Upload failed. Remove the file and try again.",
            },
      };
    },
    async send(attachment) {
      return { ...attachment, status: { type: "complete" }, content: [] };
    },
    async remove(attachment) {
      store.actions.removeAttachment(attachment.id);
    },
  };
}
