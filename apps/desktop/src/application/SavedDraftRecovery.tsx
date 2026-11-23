import { useRef, useState } from 'react';
import type { SavedDraftRecovery as Recovery } from './view-state.js';

export function SavedDraftRecovery({ recovery, onOpen, onRemainingWork, onDismiss }: { readonly recovery: Recovery; readonly onOpen: () => void; readonly onRemainingWork: () => void; readonly onDismiss: () => void }) {
  const text = useRef<HTMLTextAreaElement>(null), [notice, setNotice] = useState('');
  async function copy(): Promise<void> {
    try { await navigator.clipboard.writeText(recovery.text); setNotice('Draft copied. Paste it into the chat when ready.'); }
    catch { text.current?.focus(); text.current?.select(); setNotice('Recovered text selected. Use Copy to put it on your clipboard.'); }
  }
  return <section className="saved-draft-recovery" aria-label="Saved draft recovery">
    <h2>{recovery.kind === 'bound' ? 'Saved unsent message' : recovery.kind === 'continued' ? 'Earlier unsent draft' : 'Independent saved draft'}</h2>
    <p>{recovery.kind === 'bound' ? 'This chat is unavailable. Copy its unsent text into a new chat when ready.' : recovery.kind === 'continued' ? 'This earlier chat still has unsent text. Copy it into the newest chat when ready.' : 'This saved view has its own unsent text. The chat keeps its current editor.'} Images and queued commands remain in the original saved view.</p>
    <textarea ref={text} readOnly aria-label="Recovered unsent draft" value={recovery.text} />
    <div><button type="button" disabled={!recovery.text} onClick={() => void copy()}>Copy recovered draft</button>
      <button type="button" onClick={onOpen}>{recovery.kind === 'bound' ? 'Start a new chat' : recovery.kind === 'continued' ? 'Open newest chat to paste' : 'Open chat to paste'}</button>
      {recovery.kind === 'independent' && <button type="button" onClick={onRemainingWork}>Open other saved work</button>}
      <button type="button" onClick={onDismiss}>Dismiss recovery</button></div>
    {notice && <p role="status">{notice}</p>}
  </section>;
}
