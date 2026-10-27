// Unit tests use the actual controller module; browser integration tests exercise the DOM handlers.
import assert from 'node:assert/strict';
import fs from 'node:fs';
const source = fs.readFileSync('explorer/static/chat_ui.js', 'utf8');
const { createChatUiController, parseDose } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
let state = { selected_neuron: null, open_tab: 'details', transitioning: false,
  chat: { dose: .8, mode: 'add', direction: 'writes', prompt: '', running: false, history_length: 2 } };
let finish, aborts = 0;
const controller = createChatUiController({ arch: { n_layers: 32, inter: 9216, attn_heads: 16, linear_v_heads: 32, layer_types: Array.from({length:32}, (_,i) => i % 4 === 3 ? "full_attention" : "linear_attention") }, state: () => structuredClone(state),
  select: async (layer, n) => { state.selected_neuron = {layer, n, kind: 'neuron'}; },
  selectHead: async (layer, head) => { state.selected_neuron = null; state.selected_head = {layer, head}; },
  openTab: tab => { state.open_tab = tab; }, controls: patch => Object.assign(state.chat, patch),
  prompt: prompt => { state.chat.prompt = prompt; },
  submit: () => { state.chat.running = true; return new Promise(resolve => { finish = result => {
    state.chat.running = false; state.chat.history_length++; state.chat.prompt = ''; resolve(result);
  }; }); }, cancel: () => { aborts++; finish({status: 'cancelled', error: 'generation cancelled'}); },
});
const command = (action, args = {}, id = 'test') => controller.execute({action, ...args}, id);
assert.match((await command('chat_prompt', {prompt: 'hello'})).error, /select/);
await command('select', {layer: 7, n: 1870});
await command('tab', {tab: 'chat'});
let result = await command('chat_controls', {mode: 'add', direction: 'writes', dose: .8});
assert.equal(result.state.chat.dose, .8);
await command('chat_prompt', {prompt: 'Reply only OK.'});
assert.equal((await command('state')).state.chat.prompt, 'Reply only OK.');
assert.equal(state.chat.history_length, 2);
for (const dose of [-.8, 0]) assert.equal((await command('chat_controls', {dose})).state.chat.dose, dose);
for (const patch of [{dose: '0'}, {dose: NaN}, {dose: Infinity}, {mode: 'bad'}, {direction: 'reads'}, {mode: 'mul', dose: 'bad'}]) {
  const previous = structuredClone(state);
  assert.ok((await command('chat_controls', patch)).error);
  assert.deepEqual(state, previous);
}
const pending = command('chat_submit', {}, 'generation');
assert.equal((await command('state')).state.chat.running, true);
assert.match((await command('chat_submit')).error, /already running/);
assert.match((await command('chat_controls', {dose: 1})).error, /already running/);
assert.equal(aborts, 0);
finish({status: 'completed', replies: ['OK', 'OK', 'OK']});
result = await pending;
assert.equal(result.submission.status, 'completed');
assert.equal(result.state.chat.history_length, 3);
assert.match((await command('chat_submit')).error, /empty/);
await command('chat_prompt', {prompt: 'another'});
const cancelled = command('chat_submit', {}, 'cancel-me');
controller.cancel('other-id'); assert.equal(aborts, 0);
controller.cancel('cancel-me'); assert.equal(aborts, 1);
assert.match((await cancelled).error, /cancelled/);
await command('chat_prompt', {prompt: 'error test'});
const failed = command('chat_submit'); finish({status: 'error', error: 'model failed'});
assert.equal((await failed).error, 'model failed');
assert.equal(parseDose('×-0.8'), -.8); assert.equal(parseDose('0'), 0);
assert.throws(() => parseDose('1oops')); assert.throws(() => parseDose(''));
console.log('Chat controller: selection, controls, history, submit, errors, running guard, cancellation, negative/zero and invalid doses passed.');

await command('head', {layer: 7, head: 15});
assert.deepEqual((await command('state')).state.selected_head, {layer:7, head:15});
assert.match((await command('chat_prompt', {prompt:'no neuron'})).error, /real neuron/);
for (const args of [{layer:7,head:16}, {layer:32,head:0}, {layer:0,head:-1}, {layer:true,head:0}, {layer:0,head:.5}]) {
  const before = structuredClone(state);
  assert.ok((await command('head', args)).error); assert.deepEqual(state, before);
}
assert.ok(!(await command('head', {layer:0,head:31})).error);
console.log('Head selection acknowledgement, layer-specific bounds, and neuron Chat exclusion passed.');
