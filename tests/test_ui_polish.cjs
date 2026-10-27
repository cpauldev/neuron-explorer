// Regression checks execute the app's actual handlers with a small DOM fixture.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('explorer/static/app.js', 'utf8');
function element(dataset = {}) {
  const classes = new Set();
  return { dataset, style: {}, disabled: false, value: '', textContent: '', innerHTML: '', handlers: {}, attrs: {},
    scrollHeight: 100, clientHeight: 100, scrollTop: 0,
    classList: { contains: x => classes.has(x), add: x => classes.add(x), remove: x => classes.delete(x),
      toggle(x, on = !classes.has(x)) { on ? classes.add(x) : classes.delete(x); } },
    setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener(k, f) { this.handlers[k] = f; },
    setCustomValidity(v) { this.validationMessage = v; }, reportValidity() { return !this.validationMessage; },
    getBoundingClientRect() { return {width: 300}; }, focus() {}, querySelectorAll() { return []; },
    click() { if (!this.disabled) this.onclick?.({target: this}); },
  };
}
const elements = new Map();
const $ = s => { if (!elements.has(s)) elements.set(s, element()); return elements.get(s); };
const html = fs.readFileSync('explorer/static/index.html', 'utf8');
const tabs = [...html.matchAll(/data-tab="(\w+)"/g)].map(([, tab]) => element({tab}));
const tabFor = name => tabs.find(b => b.dataset.tab === name);
tabFor('agent').classList.add('on');
const panels = tabs.map(b => Object.assign(element(), {id: `tab-${b.dataset.tab}`}));
const action = $('#f-collapse');
const document = { body: element(), querySelectorAll(s) {
  if (s === '#tabs button[data-tab]') return tabs;
  if (s === '#tabs button') return [...tabs, action];
  if (s === '.tab') return panels;
  return [];
} };
const select = s => {
  const tab = s.match(/^#tabs button\[data-tab="(\w+)"\]$/);
  if (tab) return tabs.find(b => b.dataset.tab === tab[1]);
  if (s === '#tabs button.on') return tabs.find(b => b.classList.contains('on'));
  return $(s);
};
const context = vm.createContext({ $: select, document, state: { focus: {layer: 7, n: 1870, kind: 'neuron'}, inf: {pos:-1} },
  map: {setInsets() {}, select() {}, selectHead() {}, setNeuronHeads() {}}, scatter: {setInsets() {}, select() {}},
  saveFocus() {}, lightHeads() {},
  addEventListener() {}, saveCurrentChatSession() {}, flushName() {}, cancelChat() {},
  refreshWeb() {}, renderAgentActions() {}, renderList() {}, growInput() {},
  history: {replaceState() {}},
});
vm.runInContext('let selectionEpoch = 0, selectionPending = false;\n' + source.slice(
  source.indexOf('function updateInsets()'), source.indexOf('const chatSessions =')), context);
$('#focus').classList.add('on');
$('#f-collapse').click();
assert.equal($('#focus').classList.contains('collapsed'), true, 'collapse keeps its own handler');
assert.equal(tabFor('agent').classList.contains('on'), true, 'collapse preserves the selected tab');
vm.runInContext('setTab(undefined)', context);
assert.equal(tabFor('agent').classList.contains('on'), true, 'invalid tabs leave the UI intact');
$('#f-close').click();
for (const name of ['chat', 'details', 'examples']) assert.equal(tabFor(name).disabled, true);
assert.equal(tabFor('agent').disabled, false);
assert.ok(tabs.every(b => b.style.display !== 'none'), 'tabs stay in place without a selection');
vm.runInContext('setTab("chat")', context);
assert.equal(tabFor('agent').classList.contains('on'), true, 'disabled tab cannot be activated');
vm.runInContext('state.focus = {layer: 7, n: 1870, kind: "neuron"}; syncTabs(); setTab("chat")', context);
assert.ok(tabs.every(b => !b.disabled));
assert.equal(tabFor('chat').attrs['aria-pressed'], 'true');

const doseContext = vm.createContext({ $,
  state: { chat: {mode: 'add', dose: {add: .8, mul: 2}} },
  document: {querySelectorAll: () => []}, updateChatEmpty() {},
  ADD_STEPS: [.05, .1], MUL_STEPS: [0, .5],
  parseDose(value) { const n = Number(value); if (!String(value).trim() || !Number.isFinite(n)) throw new Error('dose must be finite'); return n; },
});
vm.runInContext(source.slice(source.indexOf('const doseEl ='), source.indexOf('let running =')), doseContext);
$('#c-dose').value = 'oops'; $('#c-dose').handlers.change();
assert.equal($('#c-dose').value, 'oops', 'invalid dose remains visible for correction');
assert.equal(vm.runInContext('state.chat.dose.add', doseContext), .8, 'invalid dose does not change applied dose');
assert.match($('#c-dose').validationMessage, /finite/);
for (const n of [-.8, 0, .8]) {
  $('#c-dose').value = String(n); $('#c-dose').handlers.change();
  assert.equal(vm.runInContext('state.chat.dose.add', doseContext), n);
  assert.equal($('#c-dose').validationMessage, '');
}

// A failed upload which the user removed must not splice(-1) and remove another file.
let rejectUpload;
const uploads = vm.createContext({ $, agent: {ctl: null}, esc: x => x, saveAgent() {}, addMsg() {},
  FileReader: class { readAsDataURL() { this.result = 'data:text/plain;base64,eA=='; this.onload(); } },
  api: () => new Promise((resolve, reject) => { rejectUpload = reject; }),
});
vm.runInContext('agent.pending = [];\n' + source.slice(source.indexOf('function renderPending()'), source.indexOf('$("#a-attach").onclick')), uploads);
const uploading = vm.runInContext('attachFiles([{name:"first.txt", type:"text/plain"}])', uploads);

let saves = 0, scheduled;
const lifecycle = {};
const draftContext = vm.createContext({ $, growInput() {}, saveAgent() { saves++; },
  setTimeout(fn) { scheduled = fn; return 1; }, clearTimeout() {},
  addEventListener(name, fn) { lifecycle[name] = fn; },
});
vm.runInContext(source.slice(source.indexOf('let draftTimer;'), source.indexOf('// Enter sends;')), draftContext);
lifecycle.pagehide(); assert.equal(saves, 0, 'closing an untouched tab cannot overwrite another tab history');
$('#a-input').handlers.input(); scheduled();
assert.equal(saves, 1, 'drafts save after typing');
lifecycle.pagehide(); assert.equal(saves, 1, 'already-saved drafts are not rewritten on close');
$('#a-input').handlers.input(); lifecycle.pagehide();
assert.equal(saves, 2, 'a pending draft saves on close');
Promise.resolve().then(async () => {
  vm.runInContext('agent.pending.splice(0, 1); agent.pending.push({name:"keep.txt", id:"keep"})', uploads);
  rejectUpload(new Error('failed'));
  await uploading;
  assert.equal(vm.runInContext('agent.pending.length', uploads), 1);
  assert.equal(vm.runInContext('agent.pending[0].name', uploads), 'keep.txt');
  // Sending a queued message must wait for cancellation cleanup, rather than an arbitrary timer.
  let closeTurn, flushed = 0, stopped = 0;
  const queueAgent = {ctl: {}, finished: new Promise(resolve => { closeTurn = resolve; })};
  const queueContext = vm.createContext({agent: queueAgent, stopAgent() { stopped++; }, flushQueue() { flushed++; }});
  const start = source.indexOf('async function interruptQueue()');
  vm.runInContext(source.slice(start, source.indexOf('$("#a-thread").addEventListener', start)), queueContext);
  const waiting = vm.runInContext('interruptQueue()', queueContext);
  await Promise.resolve();
  assert.equal(stopped, 1); assert.equal(flushed, 0);
  queueAgent.ctl = null; closeTurn(); await waiting;
  assert.equal(flushed, 1);
  queueAgent.finished = new Promise(resolve => { closeTurn = resolve; });
  const stale = vm.runInContext('interruptQueue()', queueContext);
  queueAgent.finished = null; closeTurn(); await stale;
  assert.equal(flushed, 1, 'a reset must not send messages queued for an old conversation');
  console.log('UI regressions passed: panels, dose validation, uploads, drafts, and interruption cleanup.');
}).catch(error => { console.error(error); process.exitCode = 1; });
