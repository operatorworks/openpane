import type { NativePlacementIntent } from './window-context.js';
import type { WindowRecovery, WindowRuntime } from './window-runtime.js';

export function WindowRecoveryControls({ runtime, recovery }: { readonly runtime: WindowRuntime; readonly recovery: WindowRecovery }) {
  if (recovery.kind === 'none') return null;
  if (recovery.kind === 'main') return recovery.windows.length ? <details className="window-recovery"><summary>Chat recovery · {recovery.windows.length} unfinished</summary>
    <p>These chats haven’t finished opening. Retrying uses the same conversation and saved draft.</p>
    {recovery.windows.map(window => <section key={JSON.stringify(window.scope)}><p>Unfinished chat {window.scope.conversationId.slice(-8)}</p>
      <button type="button" onClick={() => void runtime.resumeWindow(window)}>Retry chat window</button>
      <button type="button" onClick={() => void runtime.resumeWindow(window, true)}>Restore builtin and open here</button>
    </section>)}
  </details> : null;
  const request = (intent: NativePlacementIntent) => <section key={intent.requestId}>
    <p>{intent.action.kind === 'create' ? 'New chat request' : 'Continuation request'} · {intent.target?.scope.conversationId.slice(-8) ?? 'Waiting to start'}</p>
    <p role="status">{intent.result?.kind === 'refused' || intent.result?.kind === 'pending' ? intent.result.reason : intent.result ? 'Chat is ready.' : 'Waiting for main to finish opening this chat.'}</p>
    <button type="button" onClick={() => void runtime.retryIntent(intent)}>{intent.result?.kind === 'inline' || intent.result?.kind === 'detached' ? 'Open saved chat' : 'Retry same request'}</button>
  </section>;
  if (!recovery.pending.length && !recovery.history.length && !recovery.carries.length) return null;
  return <details className="window-recovery"><summary>Chat requests · {recovery.pending.length} pending</summary>
    {recovery.pending.map(request)}
    {recovery.carries.map(carry => <section key={carry.requestId}><p>{carry.kind === 'applied' ? 'The draft reached its new chat; this chat is confirming its saved copy.' : 'The draft stays here until its new chat confirms it.'}</p>
      <button type="button" onClick={() => void runtime.keepDraft(carry.requestId)}>{carry.kind === 'applied' ? 'Keep the draft here too' : 'Keep the draft here'}</button>
    </section>)}
    {recovery.history.length > 0 && <details><summary>Recorded requests</summary>{recovery.history.map(request)}</details>}
    {recovery.after && <button type="button" onClick={() => void runtime.loadMoreRequests()}>More recorded requests</button>}
  </details>;
}
