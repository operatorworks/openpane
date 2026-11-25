import { useRef, useState } from 'react';
import type { SavedDraftRecovery as Recovery } from './view-state.js';

export function SavedDraftRecovery({ recovery, onOpen, onRemainingWork, onSelectScope, onDismiss }: { readonly recovery: Recovery; readonly onOpen: () => void; readonly onRemainingWork: () => void; readonly onSelectScope: (scope: Recovery['scope']) => void; readonly onDismiss: () => void }) {
  const text = useRef<HTMLTextAreaElement>(null), [notice, setNotice] = useState('');
  async function copy(): Promise<void> {
    try { await navigator.clipboard.writeText(recovery.text); setNotice('Draft copied. Paste it into the chat when ready.'); }
    catch { text.current?.focus(); text.current?.select(); setNotice('Recovered text selected. Use Copy to put it on your clipboard.'); }
  }
  return <section className="saved-draft-recovery" aria-label="Saved draft recovery">
    <h2>{recovery.kind === 'bound' ? 'Saved unsent message' : recovery.kind === 'continued' ? 'Earlier unsent draft' : 'Independent saved draft'}</h2>
    <p>{recovery.kind === 'bound' ? 'This chat is unavailable. Copy its unsent text into a new chat when ready.' : recovery.kind === 'continued' ? 'This earlier chat still has unsent text. Copy it into the newest chat when ready.' : 'This saved view has its own unsent text. The chat keeps its current editor.'} Images and queued commands remain in the original saved view.</p>
    {(recovery.scopes?.length ?? 0) > 1 && <label data-openpane-part="field-label">Saved conversation<select data-openpane-part="select" aria-label="Saved conversation recovery" value={recovery.scope.conversationId} onChange={event => { const scope = recovery.scopes?.find(scope => scope.conversationId === event.target.value); if (scope) onSelectScope(scope); }}>{recovery.scopes?.map(scope => <option key={scope.conversationId} value={scope.conversationId}>{scope.conversationId}</option>)}</select></label>}
    {recovery.queuedTexts?.map((message, index) => <label data-openpane-part="field-label" key={index}>Saved queued message<textarea data-openpane-part="textarea" readOnly value={message} /></label>)}
    {Boolean(recovery.queuedCount) && <p>{recovery.queuedCount} saved queued actions remain in the original view. Recovery does not send them.</p>}
    {recovery.image && <button data-openpane-part="button" type="button" onClick={() => { if (!recovery.image) return; const url = URL.createObjectURL(new Blob([new Uint8Array(recovery.image.bytes)])); const link = document.createElement('a'); link.href = url; link.download = recovery.image.name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }}>Save original image</button>}
    <textarea data-openpane-part="textarea" ref={text} readOnly aria-label="Recovered unsent draft" value={recovery.text} />
    <div><button data-openpane-part="button" type="button" disabled={!recovery.text} onClick={() => void copy()}>Copy recovered draft</button>
      <button data-openpane-part="button" type="button" onClick={onOpen}>{recovery.kind === 'bound' ? 'Start a new chat' : recovery.kind === 'continued' ? 'Open newest chat to paste' : 'Open chat to paste'}</button>
      {recovery.kind === 'independent' && <button data-openpane-part="button" type="button" onClick={onRemainingWork}>Open other saved work</button>}
      <button data-openpane-part="button" type="button" onClick={onDismiss}>Dismiss recovery</button></div>
    {notice && <p data-openpane-part="status" role="status">{notice}</p>}
  </section>;
}
