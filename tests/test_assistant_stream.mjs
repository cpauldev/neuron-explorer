import assert from 'node:assert/strict';
import fs from 'node:fs';
const source = fs.readFileSync('explorer/static/assistant_stream.js', 'utf8');
const {followAssistant} = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const encoder = new TextEncoder();
function response(events, breakAt = null) {
  const bytes = encoder.encode(events.map(e => JSON.stringify(e)).join('\n') + '\n');
  return new Response(new ReadableStream({start(controller) {
    for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3));
    if (breakAt) controller.error(new Error('network interrupted')); else controller.close();
  }}));
}
let calls = [], seen = [], attempts = 0;
const fetcher = async url => {
  calls.push(url);
  if (++attempts === 1) return response([{seq: 1, t: 'text', text: '你好'}]);
  return response([{seq: 1, t: 'text', text: 'duplicate'}, {seq: 2, t: 'text', text: 'again'}, {seq: 3, t: 'done'}]);
};
const cursor = await followAssistant('owned', 0, e => seen.push(e), new AbortController().signal, fetcher, async () => {});
assert.equal(cursor, 3); assert.deepEqual(seen.map(e => e.text).filter(Boolean), ['你好', 'again']);
assert.match(calls[1], /after=1$/);
await assert.rejects(followAssistant('bad', 0, () => {}, new AbortController().signal,
  async () => new Response(JSON.stringify({error:'not owned'}), {status:400}), async () => {}), /not owned/);
const ctl = new AbortController(); ctl.abort();
await assert.rejects(followAssistant('owned', 0, () => {}, ctl.signal, fetcher), /Disconnected/);
console.log('Assistant event replay: UTF-8 fragments, reconnect cursor, duplicate suppression, ownership errors and cancellation passed.');
