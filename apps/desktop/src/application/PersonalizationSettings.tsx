import { useState, type ChangeEvent, type ReactNode } from 'react';
import { canonicalPaletteText, parsePaletteDocument, starterPalette, type PaletteDocumentV1 } from '@openpane/theme';
import { ThemeScope } from '@openpane/ui-primitives/desktop';
import { parseDesktopPreferences, parseNamespace, type GlobalSlot, type SlotPreference } from './personalization.js';
import type { usePersonalization } from './use-personalization.js';
import type { DesktopCustomization, NamespaceActivation } from './DesktopCustomizations.js';

type State = ReturnType<typeof usePersonalization>;
const slots: readonly GlobalSlot[] = ['transcript', 'activity', 'contentLayout'];
const labels = { transcript: 'Transcript', activity: 'Activity', contentLayout: 'Content layout' };
function PreferenceCheckbox({ checked, onChange, children }: {
  readonly checked: boolean; readonly onChange: (checked: boolean) => Promise<void>; readonly children: ReactNode;
}) {
  const [pending, setPending] = useState<boolean | null>(null);
  return <label><input type="checkbox" checked={pending ?? checked} disabled={pending !== null} onChange={event => {
    const next = event.target.checked;
    setPending(next);
    void onChange(next).finally(() => setPending(null));
  }} />{children}</label>;
}
export function PersonalizationSettings({ state, customizations, namespaces }: {
  readonly state: State; readonly customizations: readonly DesktopCustomization[]; readonly namespaces: readonly NamespaceActivation[];
}) {
  const { session, document, saved } = state;
  const [message, setMessage] = useState('');
  const [paletteText, setPaletteText] = useState('');
  const [preview, setPreview] = useState<PaletteDocumentV1 | null>(null);
  const [exported, setExported] = useState('');
  const [editor, setEditor] = useState<{ text: string; revision: number } | null>(null);
  async function perform(operation: Promise<{ kind: string; diagnostic?: string }>) {
    const result = await operation;
    setMessage(result.kind === 'committed' ? 'Saved locally.' : result.diagnostic ?? 'Could not save this change.');
  }
  function previewPalette() {
    try {
      if (new TextEncoder().encode(paletteText).length > 65536) throw new TypeError('Palette exceeds 64 KiB.');
      setPreview(parsePaletteDocument(JSON.parse(paletteText)));
      setMessage('Preview ready. Import saves this palette without selecting it.');
    } catch (error) { setPreview(null); setMessage(error instanceof Error ? error.message : 'Invalid palette JSON.'); }
  }
  async function readFile(event: ChangeEvent<HTMLInputElement>, kind: 'palette' | 'preferences') {
    const file = event.target.files?.[0];
    if (!file) return;
    event.target.value = '';
    if (file.size > 65536) { setMessage('File exceeds 64 KiB.'); return; }
    try {
      const text = await file.text();
      if (kind === 'palette') { setPaletteText(text); setPreview(null); }
      else if (saved && (saved.preferences.kind === 'valid' || saved.preferences.kind === 'invalid') && saved.preferences.revision !== null) {
        setEditor({ text, revision: saved.preferences.revision });
        setMessage('Review the imported preferences, then save JSON to replace your choices.');
      } else setMessage('Reset or retry saved preferences before importing JSON.');
    } catch { setMessage('Could not read this file.'); }
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
      <label>Appearance mode <select aria-label="Appearance mode" value={document.appearance} onChange={event => {
        const appearance = event.target.value;
        if (appearance === 'system' || appearance === 'light' || appearance === 'dark') void perform(session.patchPreferences({ kind: 'appearance', appearance }));
      }}><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></label>
      <div className="personalization-controls">
        <button onClick={() => void perform(session.selectPalette(null))}>Use builtin palette</button>
        <button onClick={() => setExported(canonicalPaletteText(starterPalette()))}>Export starter palette</button>
        <button onClick={() => void perform(session.resetAppearance())}>Restore default appearance</button>
      </div>
      <p>Imported namespace/name are declared metadata, not verified publisher identity. Palettes contain colors only and never enable code.</p>
      {document.palette.kind === 'imported' && <p>Selected palette: {document.palette.digest}</p>}
      <ul className="palette-list">{saved?.palettes.map(resource => <li key={resource.digest}>
        {resource.kind === 'ready' ? <>
          <strong>{resource.document.label}</strong> · {resource.document.namespace}/{resource.document.name} · {resource.digest.slice(0, 12)}
          <div className="personalization-controls">
            <button aria-label={`Select ${resource.document.label} ${resource.digest.slice(0, 12)}`} onClick={() => void perform(session.selectPalette(resource.digest))}>Select</button>
            <button aria-label={`Export ${resource.document.label} ${resource.digest.slice(0, 12)}`} onClick={() => setExported(resource.text)}>Export palette</button>
          </div>
        </> : <p role="alert">{resource.digest.slice(0, 12)}: {resource.diagnostic}</p>}
        <button aria-label={`Remove palette ${resource.digest.slice(0, 12)}`} onClick={() => void perform(session.removePalette(resource.digest))}>Remove</button>
      </li>)}</ul>
      <label>Palette JSON<textarea aria-label="Palette JSON" className="personalization-json" value={paletteText} onChange={event => { setPaletteText(event.target.value); setPreview(null); }} /></label>
      <label>Import palette file<input type="file" accept="application/json,.json" onChange={event => void readFile(event, 'palette')} /></label>
      <button onClick={previewPalette}>Preview palette</button>
      {preview && <>
        <ThemeScope palette={preview.colors} className="palette-preview" aria-label="Palette preview"><h3>{preview.label}</h3><p>Example conversation text.</p><p style={{ color: 'var(--aui-color-muted)' }}>Muted text</p><button>Example control</button><p style={{ color: 'var(--aui-color-danger)' }}>Example error</p></ThemeScope>
        <button onClick={() => void perform(session.importPalette(canonicalPaletteText(preview)))}>Import palette</button>
      </>}
    </section>
    <section className="settings-section" aria-label="Executable UI"><h2>Executable UI</h2>
      <p>Full-trust code in this app build. Disabling a desktop view leaves its host provider, credentials, palettes and remote runs available.</p>
      <PreferenceCheckbox checked={document.ui.enabled} onChange={enabled => perform(session.patchPreferences({ kind: 'ui-enabled', enabled }))}>Enable executable UI customizations</PreferenceCheckbox>
      {customizations.map(item => <PreferenceCheckbox key={item.manifest.namespace} checked={!document.ui.disabledNamespaces.some(namespace => namespace === item.manifest.namespace)} onChange={enabled => perform(session.patchPreferences({ kind: 'namespace-enabled', namespace: parseNamespace(item.manifest.namespace), enabled }))}>Enable {item.manifest.namespace} desktop UI</PreferenceCheckbox>)}
      {slots.map(slot => {
        const choice = document.ui.slots[slot];
        const available = namespaces.filter(owner => owner.kind === 'ready' && owner.presentation[slot] !== undefined).map(owner => owner.namespace);
        const selected = choice.kind === 'extension' ? choice.namespace : choice.kind;
        return <label key={slot}>{labels[slot]} owner <select aria-label={`${labels[slot]} owner`} value={selected} onChange={event => {
          const value = event.target.value;
          const selection: SlotPreference = value === 'automatic' || value === 'builtin' ? { kind: value } : { kind: 'extension' as const, namespace: parseNamespace(value) };
          void perform(session.patchPreferences({ kind: 'slot', slot, selection }));
        }}><option value="automatic">Automatic</option><option value="builtin">Builtin</option>
          {choice.kind === 'extension' && !available.includes(choice.namespace) && <option value={choice.namespace}>{choice.namespace} · unavailable saved choice</option>}
          {available.map(namespace => <option key={namespace} value={namespace}>{namespace}</option>)}
        </select></label>;
      })}
    </section>
    <section className="settings-section" aria-label="Preferences JSON"><h2>Preferences JSON</h2>
      <div className="personalization-controls">
        <button onClick={() => {
          const preferences = saved?.preferences;
          if (preferences?.kind === 'valid') setEditor({ text: JSON.stringify(preferences.document, null, 2), revision: preferences.revision });
          else if (preferences?.kind === 'invalid' && preferences.revision !== null && preferences.repairable) setEditor({ text: JSON.stringify(document, null, 2), revision: preferences.revision });
          else setMessage('Reset or retry saved preferences before editing JSON.');
        }}>Edit preferences JSON</button>
        <button onClick={() => {
          if (saved?.preferences.kind === 'valid') setExported(JSON.stringify(saved.preferences.document, null, 2));
          else setMessage('Saved preferences are unavailable.');
        }}>Export preferences</button>
        <label>Import preferences file<input type="file" accept="application/json,.json" onChange={event => void readFile(event, 'preferences')} /></label>
      </div>
      {editor && <><label>Preferences JSON<textarea aria-label="Preferences JSON" className="personalization-json" value={editor.text} onChange={event => setEditor({ ...editor, text: event.target.value })} /></label>
        <button onClick={() => {
          try { void perform(session.replacePreferences({ expectedRevision: editor.revision, document: parseDesktopPreferences(JSON.parse(editor.text)) })); }
          catch (error) { setMessage(error instanceof Error ? error.message : 'Invalid preferences JSON.'); }
        }}>Save JSON</button><button onClick={() => setEditor(null)}>Close editor</button></>}
      <button onClick={() => void session.retry().then(() => setMessage('Saved preferences checked.'))}>Retry saved preferences</button>
      <button disabled={saved?.preferences.kind === 'unavailable' || saved?.preferences.kind === 'invalid' && !saved.preferences.repairable} onClick={() => void perform(session.resetPersonalization())}>Reset saved preferences</button>
      <p>Reset keeps palettes, conversations and drafts, and saves executable UI disabled.</p>
    </section>
    {message && <p role="status">{message}</p>}
    {exported && <section aria-label="JSON export"><label>Exported JSON<textarea aria-label="Exported JSON" className="personalization-json" readOnly value={exported} /></label>{nativeExport ? <p>Select and copy the JSON to save it in a text file. File downloads are available in a browser.</p> : <button onClick={download}>Download JSON</button>}<button onClick={() => void navigator.clipboard?.writeText(exported).then(() => setMessage('Copied JSON.'), () => setMessage('Select and copy the exported JSON.'))}>Copy JSON</button></section>}
  </>;
}
