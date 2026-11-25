import React from 'react';
import { createRoot } from 'react-dom/client';
import { ExperienceScope } from '../../../apps/desktop/src/application/ExperienceScope.tsx';
import { BrowserApplication } from '../../../apps/desktop/src/shell/BrowserApplication.tsx';
import { PersonalizationProvider } from '../../../apps/desktop/src/application/use-personalization.tsx';
import { DesktopCustomizationProvider } from '../../../apps/desktop/src/application/DesktopCustomizations.tsx';
import '../../../apps/desktop/src/shell/styles.css';

const assert = (value, message) => { if (!value) throw new Error(message); };
async function wait(predicate, label) {
  const deadline = performance.now() + 20000;
  while (!await predicate()) {
    if (performance.now() > deadline) throw new Error(`Timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
async function request(path, value) {
  const response = await fetch(`/qa/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  const result = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(result));
  return result;
}
const route = name => document.querySelector(`[aria-label="Workspace views"] button[aria-label="${name}"]`);
const visiblePanes = () => [...document.querySelectorAll('[data-home-pane]')].filter(node => !node.closest('[hidden]') && node.getBoundingClientRect().height > 0).map(node => node.dataset.homePane);
const checkPanes = expected => {
  assert(JSON.stringify(visiblePanes()) === JSON.stringify(expected), `Unexpected visible panes: ${JSON.stringify(visiblePanes())}`);
  const boxes = expected.map(kind => document.querySelector(`[data-home-pane="${kind}"]`).getBoundingClientRect());
  for (let i = 1; i < boxes.length; i++) assert(boxes[i - 1].left < boxes[i].left - 1 || Math.abs(boxes[i - 1].left - boxes[i].left) <= 1 && boxes[i - 1].top < boxes[i].top - 1, 'Pane visual order differs from its declared order');
};
const field = () => document.querySelector('textarea#message');
function edit(node, text) {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(node, text);
  node.dispatchEvent(new Event('input', { bubbles: true }));
}
async function painted(operation) {
  await wait(async () => (await request('status', { requestId: operation.receipt.requestId })).outcome !== 'pending', 'paint receipt');
  const status = await request('status', { requestId: operation.receipt.requestId });
  assert(status.outcome === 'all-rendered', `Appearance failed: ${JSON.stringify(status)}`);
}
async function run() {
  createRoot(document.getElementById('root')).render(<PersonalizationProvider><DesktopCustomizationProvider><ExperienceScope><BrowserApplication /></ExperienceScope></DesktopCustomizationProvider></PersonalizationProvider>);
  await wait(() => [...document.querySelectorAll('button')].some(button => button.textContent === 'New recorded conversation' && !button.disabled), 'real recorded agent');
  [...document.querySelectorAll('button')].find(button => button.textContent === 'New recorded conversation').click();
  await wait(() => field() && document.querySelector('.footer-status')?.textContent.includes('connected'), 'real connected editor');
  edit(field(), 'Synthetic WKWebView composition specimen');
  await wait(() => !document.querySelector('.composer-send').disabled, 'send enabled'); document.querySelector('.composer-send').click();
  await wait(() => document.querySelector('[data-openpane-part="approval-panel"]'), 'real pending approval');
  const editor = field(), approval = document.querySelector('[data-openpane-part="approval-panel"]');
  edit(editor, 'Keep this exact WKWebView draft');
  const first = await request('apply', { panes: ['conversation', 'conversations'], color: '#123456' }); await painted(first); route('Home').click(); await wait(() => route('Home').getAttribute('aria-pressed') === 'true', 'Home route'); checkPanes(['conversation', 'conversations']);
  editor.focus(); editor.setSelectionRange(3, 12, 'backward');
  editor.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: 'composing' }));
  const second = await request('apply', { panes: ['conversations', 'conversation'], color: '#abcdef' });
  await wait(() => document.querySelector('[data-experience-phase="composition-deferred"]'), 'IME hold');
  assert(document.querySelector('.experience-content').dataset.openpaneExperience === first.receipt.digest, 'Held candidate replaced the current frame');
  const third = await request('apply', { panes: ['conversation', 'status', 'conversations'], color: '#345678' });
  await wait(async () => (await request('status', { requestId: second.receipt.requestId })).outcome === 'superseded', 'held delivery superseded');
  await wait(() => document.querySelector(`link[href*="${third.receipt.digest}"]`)?.media === 'not all' && document.querySelector('[data-experience-phase="composition-deferred"]'), 'C staged and deferred');
  assert((await request('status', { requestId: third.receipt.requestId })).outcome === 'pending', 'C acknowledged before composition ended');
  assert(document.querySelector('.experience-content').dataset.openpaneExperience === first.receipt.digest && getComputedStyle(document.querySelector('.shell-header')).backgroundColor === 'rgb(18, 52, 86)', 'C changed the held visual frame');
  checkPanes(['conversation', 'conversations']);
  assert(field() === editor && document.activeElement === editor, 'Supersession replaced or unfocused the composing editor');
  assert(editor.selectionStart === 3 && editor.selectionEnd === 12, 'Supersession changed the caret');
  editor.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'composing' })); await painted(third);
  assert(field() === editor && document.querySelector('[data-openpane-part="approval-panel"]') === approval, 'Apply remounted editor or approval');
  checkPanes(['conversation', 'status', 'conversations']);
  for (const [name, expected] of [['Chats', ['conversation', 'conversations']], ['Settings', []], ['Home', ['conversation', 'status', 'conversations']]]) {
    route(name).click(); await wait(() => route(name).getAttribute('aria-pressed') === 'true', `${name} selected`);
    checkPanes(expected); assert(field() === editor && document.querySelector('[data-openpane-part="approval-panel"]') === approval, `${name} remounted editor or approval`);
  }
  editor.focus(); editor.setSelectionRange(4, 14, 'backward');
  editor.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: 'restore' }));
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', ctrlKey: true, shiftKey: true, bubbles: true }));
  await wait(() => document.querySelector('[data-experience-phase="composition-deferred"]'), 'builtin restore hold');
  assert(document.querySelector('.experience-content').dataset.openpaneExperience === third.receipt.digest, 'Builtin restore interrupted composition');
  editor.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'restore' }));
  await wait(() => !document.querySelector('.experience-content').dataset.openpaneExperience, 'builtin restored');
  assert(field() === editor && document.activeElement === editor, 'Restore replaced or unfocused editor');
  assert(editor.value === 'Keep this exact WKWebView draft' && editor.selectionStart === 4 && editor.selectionEnd === 14 && editor.selectionDirection === 'backward', 'Restore lost draft or caret');
  assert(document.querySelector('[data-openpane-part="approval-panel"]') === approval, 'Restore replaced approval');
  await wait(async () => (await request('context', {})).selection.selected.kind === 'builtin', 'host-persisted builtin selection');
  assert(route('Chats').getAttribute('aria-pressed') === 'true', 'Restore did not select builtin Chats'); checkPanes(['conversations', 'conversation']);
  const commands = await request('commands', {}); assert(commands.length === 1, 'Passive layout sent or approved a command');
  await request('report', { passed: true, userAgent: navigator.userAgent, commands: commands.length, sameEditor: true, sameApproval: true, supersession: true, imeRestore: true, builtinSelectionPersisted: true, draft: editor.value });
}
if (!location.search) void run().catch(error => request('report', { passed: false, error: error.message ?? String(error), stack: error.stack }));
