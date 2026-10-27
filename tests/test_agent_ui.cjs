// Exercise the actual provider-picker code with an in-memory DOM and storage.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('explorer/static/app.js', 'utf8');
const elements = new Map();
function $(selector) {
  if (!elements.has(selector)) elements.set(selector, {
    value: '', innerHTML: '', handlers: {}, querySelectorAll: () => [],
    addEventListener(type, callback) { this.handlers[type] = callback; },
  });
  return elements.get(selector);
}
const storage = new Map([["explorer.agent.provider", "codex"]]);
const context = vm.createContext({ $, index: {cache_key: ''}, localStorage: {
  getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value),
}, resumeAgent() {}, renderPending() {}, growInput() {}, addTurnControls() {}, clearAgentMarks() {} });
const setup = source.slice(source.indexOf('const savedProvider ='), source.indexOf('function mdInline'));
const persistence = source.slice(source.indexOf('const agentKey ='), source.indexOf('// quick actions'));
const modelKeys = source.slice(source.indexOf('const modelKey ='), source.indexOf('const tip ='));
vm.runInContext(modelKeys + setup + '\nconst EMPTY = "empty";\n' + persistence, context);
vm.runInContext('loadAgent(); agent.chat = "codex-chat"; agent.pending = [{id:"codex-file"}];', context);
$('#a-input').value = 'codex draft'; $('#a-thread').innerHTML = 'codex history';
$('#a-provider').value = 'claude'; $('#a-provider').handlers.change();
assert.equal(vm.runInContext('agent.chat', context), null);
assert.equal($('#a-input').value, '');
assert.equal($('#a-input').placeholder, 'Ask Claude…');
vm.runInContext('agent.chat = "claude-chat"; agent.pending = [{id:"claude-file"}];', context);
$('#a-input').value = 'claude draft'; $('#a-thread').innerHTML = 'claude history';
$('#a-provider').value = 'codex'; $('#a-provider').handlers.change();
assert.equal(vm.runInContext('agent.chat', context), 'codex-chat');
assert.equal($('#a-input').value, 'codex draft');
assert.equal($('#a-thread').innerHTML, 'codex history');
assert.equal(vm.runInContext('agent.pending[0].id', context), 'codex-file');
vm.runInContext('agent.ctl = {};', context);
$('#a-provider').value = 'claude'; $('#a-provider').handlers.change();
assert.equal(vm.runInContext('agent.provider', context), 'codex');
vm.runInContext('agent.ctl = null;', context);
storage.delete('explorer.agent.claude');
storage.set('explorer.agent', JSON.stringify({chat: 'legacy-claude', html: 'legacy history'}));
$('#a-provider').value = 'claude'; $('#a-provider').handlers.change();
assert.equal(vm.runInContext('agent.chat', context), 'legacy-claude');
assert.equal($('#a-thread').innerHTML, 'legacy history');
console.log('Provider picker preserves separate histories, drafts, and attachments; busy switch blocked.');

storage.clear();
assert.equal(vm.runInContext("savedProvider()", context), "claude");
assert.equal(vm.runInContext("savedAccess()", context), "project");
$('#a-access').value = 'home'; $('#a-access').handlers.change();
assert.equal(vm.runInContext('agent.access', context), 'home');
$('#a-provider').value = 'codex'; $('#a-provider').handlers.change();
assert.equal(vm.runInContext('agent.access', context), 'home');
assert.equal(storage.get('explorer.agent.access'), 'home');
vm.runInContext('agent.ctl = {};', context);
$('#a-access').value = 'project'; $('#a-access').handlers.change();
assert.equal(vm.runInContext('agent.access', context), 'home');
assert.equal($('#a-access').value, 'home');

vm.runInContext('agent.ctl = null; index.cache_key = "other-model"; loadAgent();', context);
assert.equal(vm.runInContext('agent.chat', context), null);
assert.equal($('#a-thread').innerHTML, 'empty');
vm.runInContext('agent.chat = "other-chat"; saveAgent(); index.cache_key = "third-model"; loadAgent();', context);
assert.equal(vm.runInContext('agent.chat', context), null);
vm.runInContext('index.cache_key = "other-model"; loadAgent();', context);
assert.equal(vm.runInContext('agent.chat', context), 'other-chat');
