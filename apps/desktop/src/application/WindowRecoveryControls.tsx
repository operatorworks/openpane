import { useRef, useState } from 'react';
import type { NativePlacementIntent } from './window-context.js';
import type { DraftCarry } from './draft-carry.js';
import type { WindowRecovery, WindowRuntime } from './window-runtime.js';

function CarriedDraft({ runtime, carry }: { readonly runtime: WindowRuntime; readonly carry: DraftCarry }) {
  const field = useRef<HTMLTextAreaElement>(null), [notice, setNotice] = useState('');
  const pending = carry.kind === 'offered' || carry.kind === 'applied';
  const text = 'expected' in carry ? carry.expected.text : carry.retainedText;
  async function copy(): Promise<void> {
    if (!text) return;
    try { await navigator.clipboard.writeText(text); setNotice('Saved text copied.'); }
    catch { field.current?.focus(); field.current?.select(); setNotice('Saved text selected. Use Copy to keep it.'); }
  }
  if (!pending && !text) return null;
  return <section>
    <p>{pending ? 'The captured draft stays recoverable until its transfer finishes.' : 'Saved text from an earlier draft transfer. Later edits remain in their original chats.'}</p>
    {text && <><textarea data-openpane-part="textarea" ref={field} readOnly aria-label="Saved transfer text" value={text} /><button data-openpane-part="button" type="button" onClick={() => void copy()}>Copy saved transfer text</button></>}
    {pending ? <button data-openpane-part="button" type="button" onClick={() => void runtime.keepDraft(carry.requestId, carry.source)}>Keep the draft here</button>
      : <button data-openpane-part="button" type="button" onClick={() => void runtime.removeSavedCarry(carry)}>Remove saved transfer text</button>}
    {notice && <p data-openpane-part="status" role="status">{notice}</p>}
  </section>;
}
export function WindowRecoveryControls({ runtime, recovery }: { readonly runtime: WindowRuntime; readonly recovery: WindowRecovery }) {
  if (recovery.kind === 'none') return null;
  const carries = recovery.carries ?? [];
  if (recovery.kind === 'main') return recovery.windows.length || carries.length || recovery.carriesAfter || !recovery.carriesFirstPage || recovery.carryNotice ? <details className="window-recovery"><summary>Chat recovery · {recovery.windows.length} unfinished</summary>
    {recovery.carryNotice && <p data-openpane-part="status" role="status">{recovery.carryNotice}</p>}
    <p>These chats haven’t finished opening. Retrying uses the same conversation and saved draft.</p>
    {recovery.windows.map(window => <section key={JSON.stringify(window.scope)}><p>Unfinished chat {window.scope.conversationId.slice(-8)}</p>
      <button data-openpane-part="button" type="button" onClick={() => void runtime.resumeWindow(window)}>Retry chat window</button>
      <button data-openpane-part="button" type="button" onClick={() => void runtime.resumeWindow(window, true)}>Restore builtin and open here</button>
    </section>)}
    {carries.map(carry => <CarriedDraft key={carry.requestId} runtime={runtime} carry={carry} />)}
    {recovery.carriesAfter && <button data-openpane-part="button" type="button" onClick={() => void runtime.moreSavedTransfers()}>More saved transfer text</button>}
    {!recovery.carriesFirstPage && <button data-openpane-part="button" type="button" onClick={() => void runtime.firstSavedTransfers()}>First saved transfer text</button>}
  </details> : null;
  const request = (intent: NativePlacementIntent) => <section key={intent.requestId}>
    <p>{intent.action.kind === 'create' ? 'New chat request' : 'Continuation request'} · {intent.target?.scope.conversationId.slice(-8) ?? 'Waiting to start'}</p>
    <p data-openpane-part="status" role="status">{intent.result?.kind === 'refused' || intent.result?.kind === 'pending' ? intent.result.reason : intent.result ? 'Chat is ready.' : 'Waiting for main to finish opening this chat.'}</p>
    <button data-openpane-part="button" type="button" onClick={() => void runtime.retryIntent(intent)}>{intent.result?.kind === 'inline' || intent.result?.kind === 'detached' ? 'Open saved chat' : 'Retry same request'}</button>
  </section>;
  if (!recovery.pending.length && !recovery.history.length && !carries.length) return null;
  return <details className="window-recovery"><summary>Chat requests · {recovery.pending.length} pending</summary>
    {recovery.pending.map(request)}
    {carries.map(carry => <CarriedDraft key={carry.requestId} runtime={runtime} carry={carry} />)}
    {recovery.history.length > 0 && <details><summary>Recorded requests</summary>{recovery.history.map(request)}</details>}
    {recovery.after && <button data-openpane-part="button" type="button" onClick={() => void runtime.loadMoreRequests()}>More recorded requests</button>}
  </details>;
}
