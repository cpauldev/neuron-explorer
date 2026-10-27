// Resume an owned conversation after network interruptions without repeating events.
export async function followAssistant(chat, after, onEvent, signal, fetcher = fetch, pause = ms => new Promise(r => setTimeout(r, ms))) {
  let cursor = after, failures = 0;
  while (!signal.aborted) {
    try {
      const response = await fetcher(`/api/agent/events?chat=${encodeURIComponent(chat)}&after=${cursor}`, { signal });
      if (!response.ok) {
        const body = await response.json();
        const error = new Error(body.error || `Could not reconnect (${response.status})`);
        error.permanent = response.status < 500;
        throw error;
      }
      const reader = response.body.getReader(), decoder = new TextDecoder();
      let buffer = '';
      try {
        for (;;) {
          const { value, done } = await reader.read();
          buffer += decoder.decode(value, { stream: !done });
          let newline;
          while ((newline = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
            if (!line.trim()) continue;
            const event = JSON.parse(line);
            if (event.seq <= cursor) continue;
            if (event.seq !== cursor + 1) throw new Error('Conversation events changed; reload its history.');
            onEvent(event); cursor = event.seq; failures = 0;
            if (event.t === 'done') return cursor;
          }
          if (done) break;
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      throw new Error('Connection ended before the reply completed.');
    } catch (error) {
      if (signal.aborted || error.name === 'AbortError') throw error;
      if (error.permanent || ++failures > 6) throw error;
      await pause(Math.min(500 * 2 ** (failures - 1), 5000));
    }
  }
  throw new DOMException('Disconnected', 'AbortError');
}
