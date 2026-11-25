import { useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { canonicalPaletteText, parsePaletteDocument, starterPalette, type PaletteDocumentV1 } from '@openpane/theme';
import { ThemeScope } from '@openpane/ui-primitives/desktop';
import { parseDesktopPreferences, parseNamespace, type GlobalSlot, type SlotPreference } from './personalization.js';
import { MAX_PALETTE_BYTES, PALETTE_SIZE_DIAGNOSTIC, type PersonalizationOutcome } from './personalization-storage.js';
import type { usePersonalization } from './use-personalization.js';
import { useExperience, useUiActions } from './experience-state.js';
import type { DesktopCustomization, NamespaceActivation } from './DesktopCustomizations.js';

type State = ReturnType<typeof usePersonalization>;
const slots: readonly GlobalSlot[] = ['transcript', 'activity', 'contentLayout'];
const labels = { transcript: 'Transcript', activity: 'Activity', contentLayout: 'Content layout' };
function PreferenceCheckbox({ checked, onChange, children }: {
  readonly checked: boolean; readonly onChange: (checked: boolean) => Promise<unknown>; readonly children: ReactNode;
}) {
  const [pending, setPending] = useState<boolean | null>(null);
  return <label data-openpane-part="field-label"><input data-openpane-part="checkbox" type="checkbox" checked={pending ?? checked} disabled={pending !== null} onChange={event => {
    const next = event.target.checked;
    setPending(next);
    void onChange(next).finally(() => setPending(null));
  }} />{children}</label>;
}
export function PersonalizationSettings({ state, customizations, namespaces }: {
  readonly state: State; readonly customizations: readonly DesktopCustomization[]; readonly namespaces: readonly NamespaceActivation[];
}) {
  const { session, document, saved } = state;
  const experience = useExperience(), uiActions = useUiActions();
  const [message, setMessage] = useState('');
  const [paletteText, setPaletteText] = useState('');
  const [preview, setPreview] = useState<PaletteDocumentV1 | null>(null);
  const [exported, setExported] = useState('');
  const [editor, setEditor] = useState<{ id: number; text: string; epoch: number; revision: number } | null>(null);
  const nextEditorId = useRef(0);
  const fileIntents = useRef({ palette: 0, preferences: 0 });
  const palettesUnavailable = saved?.preferences.kind === 'unavailable';
  const feedbackRequest = useRef(0);
  function report(message: string) { feedbackRequest.current++; setMessage(message); }
  async function perform(operation: Promise<PersonalizationOutcome>) {
    const request = ++feedbackRequest.current;
    const result = await operation;
    if (request === feedbackRequest.current) setMessage(result.kind === 'committed' ? result.diagnostic ?? 'Saved locally.' : result.diagnostic ?? 'Could not save this change.');
    return result;
  }
  function previewPalette() {
    try {
      if (new TextEncoder().encode(paletteText).length > MAX_PALETTE_BYTES) throw new TypeError(PALETTE_SIZE_DIAGNOSTIC);
      setPreview(parsePaletteDocument(JSON.parse(paletteText)));
      report('Preview ready. Import saves this palette without selecting it.');
    } catch (error) { setPreview(null); report(error instanceof Error ? error.message : 'Invalid palette JSON.'); }
  }
  async function readFile(event: ChangeEvent<HTMLInputElement>, kind: 'palette' | 'preferences') {
    const file = event.target.files?.[0];
    if (!file) return;
    event.target.value = '';
    const intent = ++fileIntents.current[kind];
    if (kind === 'palette' && file.size > MAX_PALETTE_BYTES) { report(PALETTE_SIZE_DIAGNOSTIC); return; }
    try {
      const text = await file.text();
      if (intent !== fileIntents.current[kind]) return;
      if (kind === 'palette') { setPaletteText(text); setPreview(null); }
      else if (saved && (saved.preferences.kind === 'valid' || saved.preferences.kind === 'invalid') && saved.preferences.revision !== null) {
        setEditor({ id: ++nextEditorId.current, text, epoch: saved.preferences.epoch, revision: saved.preferences.revision });
        report('Review the imported preferences, then save JSON to replace your choices.');
      } else report('Reset or retry saved preferences before importing JSON.');
    } catch { if (intent === fileIntents.current[kind]) report('Could not read this file.'); }
  }
  const nativeExport = location.protocol === 'tauri:' || '__TAURI_INTERNALS__' in window;
  function download() {
    if (nativeExport) return;
    const url = URL.createObjectURL(new Blob([exported], { type: 'application/json' }));
    const link = window.document.createElement('a');
    link.href = url; link.download = 'openpane-personalization.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
  return <>
    <section className="settings-section" aria-label="Appearance"><h2>Appearance</h2>
      <p>Saved for this origin and browser profile. The Mac app, other workspaces and ports can have separate choices. Export/import moves choices manually.</p>
      <label data-openpane-part="field-label">Appearance mode <select data-openpane-part="select" aria-label="Appearance mode" value={document.appearance} onChange={event => {
        const appearance = event.target.value;
        if (appearance === 'system' || appearance === 'light' || appearance === 'dark') void perform(session.patchPreferences({ kind: 'appearance', appearance }));
      }}><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></label>
      <div className="personalization-controls">
        <button data-openpane-part="button" onClick={() => void perform(session.selectPalette(null))}>Use builtin palette</button>
        <button data-openpane-part="button" onClick={() => setExported(canonicalPaletteText(starterPalette()))}>Export starter palette</button>
        <button data-openpane-part="button" onClick={() => {
          if (experience && uiActions) {
            const request = ++feedbackRequest.current;
            void uiActions.restore().then(() => { if (request === feedbackRequest.current) setMessage('Appearance restore requested.'); }, () => { if (request === feedbackRequest.current) setMessage('Could not restore the appearance. Retry with the protected restore control.'); });
          }
          else void perform(session.resetAppearance());
        }}>{experience && uiActions ? 'Restore OpenPane appearance' : 'Restore default appearance'}</button>
      </div>
      <p>Imported namespace/name are declared metadata, not verified publisher identity. Palettes contain colors only and never enable code.</p>
      {document.palette.kind === 'imported' && <p>Selected palette: {document.palette.digest}</p>}
      <ul className="palette-list">{saved?.palettes.map((resource, index) => <li key={index}>
        {resource.kind === 'ready' ? <>
          <strong>{resource.document.label}</strong> · {resource.document.namespace}/{resource.document.name} · {resource.digest.slice(0, 12)}
          <div className="personalization-controls">
            <button data-openpane-part="button" aria-label={`Select ${resource.document.label} ${resource.digest.slice(0, 12)}`} disabled={palettesUnavailable} onClick={() => void perform(session.selectPalette(resource.digest))}>Select</button>
            <button data-openpane-part="button" aria-label={`Export ${resource.document.label} ${resource.digest.slice(0, 12)}`} onClick={() => setExported(resource.text)}>Export palette</button>
          </div>
        </> : <p role="alert">{resource.digest.slice(0, 12)}: {resource.diagnostic}</p>}
        <button data-openpane-part="button" aria-label={resource.kind === 'ready' ? `Remove palette ${resource.digest.slice(0, 12)}` : `Remove unavailable palette ${index + 1} ${resource.digest.slice(0, 12)}`} disabled={palettesUnavailable} onClick={() => void perform(session.removePalette(resource.key))}>Remove</button>
      </li>)}</ul>
      <label data-openpane-part="field-label">Palette JSON<textarea data-openpane-part="textarea" aria-label="Palette JSON" className="personalization-json" value={paletteText} onChange={event => { fileIntents.current.palette++; setPaletteText(event.target.value); setPreview(null); }} /></label>
      <label data-openpane-part="field-label">Import palette file<input data-openpane-part="input" type="file" accept="application/json,.json" onChange={event => void readFile(event, 'palette')} /></label>
      <button data-openpane-part="button" onClick={previewPalette}>Preview palette</button>
      {preview && <>
        <ThemeScope palette={preview.colors} className="palette-preview" aria-label="Palette preview"><h3>{preview.label}</h3><p>Example conversation text.</p><p style={{ color: 'var(--aui-color-muted)' }}>Muted text</p><button data-openpane-part="button">Example control</button><p style={{ color: 'var(--aui-color-danger)' }}>Example error</p></ThemeScope>
        <button data-openpane-part="button" disabled={palettesUnavailable} onClick={() => void perform(session.importPalette(canonicalPaletteText(preview)))}>Import palette</button>
      </>}
    </section>
    <section className="settings-section" aria-label="Executable UI"><h2>Executable UI</h2>
      <p>Full-trust code in this app build. Disabling a desktop view leaves its host provider, credentials, palettes and remote runs available.</p>
      <PreferenceCheckbox checked={document.ui.enabled} onChange={enabled => perform(session.patchPreferences({ kind: 'ui-enabled', enabled }))}>Enable executable UI customizations</PreferenceCheckbox>
      {customizations.map(item => <PreferenceCheckbox key={item.manifest.namespace} checked={!document.ui.disabledNamespaces.some(namespace => namespace === item.manifest.namespace)} onChange={enabled => perform(session.patchPreferences({ kind: 'namespace-enabled', namespace: parseNamespace(item.manifest.namespace), enabled }))}>Enable {item.manifest.namespace} desktop UI</PreferenceCheckbox>)}
      {slots.map(slot => {
        const choice = document.ui.slots[slot];
        const available = namespaces.filter(owner => owner.kind === 'ready' && owner.presentation[slot] !== undefined).map(owner => owner.namespace);
        const selected = choice.kind === 'extension' ? `extension:${choice.namespace}` : choice.kind;
        return <label data-openpane-part="field-label" key={slot}>{labels[slot]} owner <select data-openpane-part="select" aria-label={`${labels[slot]} owner`} value={selected} onChange={event => {
          const value = event.target.value;
          const selection: SlotPreference = value === 'automatic' || value === 'builtin' ? { kind: value } : { kind: 'extension', namespace: parseNamespace(value.slice('extension:'.length)) };
          void perform(session.patchPreferences({ kind: 'slot', slot, selection }));
        }}><option value="automatic">Automatic</option><option value="builtin">Builtin</option>
          {choice.kind === 'extension' && !available.includes(choice.namespace) && <option value={`extension:${choice.namespace}`}>{choice.namespace} · unavailable saved choice</option>}
          {available.map(namespace => <option key={namespace} value={`extension:${namespace}`}>{namespace}</option>)}
        </select></label>;
      })}
    </section>
    <section className="settings-section" aria-label="Preferences JSON"><h2>Preferences JSON</h2>
      <div className="personalization-controls">
        <button data-openpane-part="button" onClick={() => {
          fileIntents.current.preferences++;
          const preferences = saved?.preferences;
          if (preferences?.kind === 'valid') setEditor({ id: ++nextEditorId.current, text: JSON.stringify(preferences.document, null, 2), epoch: preferences.epoch, revision: preferences.revision });
          else if (preferences?.kind === 'invalid' && preferences.revision !== null) setEditor({ id: ++nextEditorId.current, text: JSON.stringify(document, null, 2), epoch: preferences.epoch, revision: preferences.revision });
          else report('Reset or retry saved preferences before editing JSON.');
        }}>Edit preferences JSON</button>
        <button data-openpane-part="button" onClick={() => {
          if (saved?.preferences.kind === 'valid') setExported(JSON.stringify(saved.preferences.document, null, 2));
          else report('Saved preferences are unavailable.');
        }}>Export preferences</button>
        <label data-openpane-part="field-label">Import preferences file<input data-openpane-part="input" type="file" accept="application/json,.json" onChange={event => void readFile(event, 'preferences')} /></label>
      </div>
      {editor && <><label data-openpane-part="field-label">Preferences JSON<textarea data-openpane-part="textarea" aria-label="Preferences JSON" className="personalization-json" value={editor.text} onChange={event => { fileIntents.current.preferences++; setEditor({ ...editor, text: event.target.value }); }} /></label>
        <button data-openpane-part="button" onClick={() => {
          try { void perform(session.replacePreferences({ expectedEpoch: editor.epoch, expectedRevision: editor.revision, document: parseDesktopPreferences(JSON.parse(editor.text)) })).then(result => {
            if (result.kind === 'committed' && result.epoch !== null && result.revision !== null) {
              const revision = result.revision, epoch = result.epoch;
              setEditor(current => current?.id === editor.id && current.epoch === editor.epoch && current.revision === editor.revision ? { ...current, epoch, revision } : current);
            }
          }); }
          catch (error) { report(error instanceof Error ? error.message : 'Invalid preferences JSON.'); }
        }}>Save JSON</button><button data-openpane-part="button" onClick={() => { fileIntents.current.preferences++; setEditor(null); }}>Close editor</button></>}
      <button data-openpane-part="button" onClick={() => void session.retry().then(() => report('Saved preferences checked.'))}>Retry saved preferences</button>
      <button data-openpane-part="button" disabled={saved?.preferences.kind === 'unavailable'} onClick={() => void perform(session.resetPersonalization())}>Reset saved preferences</button>
      <p>Reset keeps palettes, conversations and drafts, and saves executable UI disabled.</p>
    </section>
    {message && <p data-openpane-part="status" role="status">{message}</p>}
    {exported && <section aria-label="JSON export"><label data-openpane-part="field-label">Exported JSON<textarea data-openpane-part="textarea" aria-label="Exported JSON" className="personalization-json" readOnly value={exported} /></label>{nativeExport ? <p>Select and copy the JSON to save it in a text file. File downloads are available in a browser.</p> : <button data-openpane-part="button" onClick={download}>Download JSON</button>}<button data-openpane-part="button" onClick={() => {
      if (!navigator.clipboard) { report('Select and copy the exported JSON.'); return; }
      void navigator.clipboard.writeText(exported).then(() => report('Copied JSON.'), () => report('Select and copy the exported JSON.'));
    }}>Copy JSON</button></section>}
  </>;
}
