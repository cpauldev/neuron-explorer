import {
  WebSpeechDictationAdapter,
  type DictationAdapter,
} from "@assistant-ui/react";

// Keep capture/transcription in the documented browser adapter. Report failures
// separately from model errors so retrying speech never reruns an earlier turn.
export function browserDictation(
  report: (message: string) => void,
): DictationAdapter | undefined {
  if (!WebSpeechDictationAdapter.isSupported()) return undefined;
  const adapter = new WebSpeechDictationAdapter({ interimResults: true });
  const failed = () =>
    report(
      "Voice input could not start or was interrupted. Check microphone permission and your browser’s speech service, then try the microphone again.",
    );
  return {
    listen() {
      report("");
      let session: DictationAdapter.Session;
      try {
        session = adapter.listen();
      } catch (error) {
        failed();
        throw error;
      }
      let reported = false;
      return {
        ...session,
        get status() {
          const status = session.status;
          if (
            !reported &&
            status.type === "ended" &&
            status.reason === "error"
          ) {
            reported = true;
            queueMicrotask(failed);
          }
          return status;
        },
      };
    },
  };
}
