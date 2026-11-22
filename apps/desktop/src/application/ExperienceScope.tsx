import { VisualContext, type VisualSelection } from './experience-state.js';
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { ThemeScope } from '@openpane/ui-primitives/desktop';
import type { UiClientSnapshot } from '@openpane/contracts';
import { UiConnection } from './ui-connection.js';
import './experience.css';

const connectionSubscribers = new WeakMap<UiConnection, number>();
function visibleFrame(): Promise<void> { return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))); }
function essentialControls(root: HTMLElement): void {
  const controls = root.querySelectorAll<HTMLElement>('[data-openpane-essential]');
  if (!controls.length) throw new Error('Essential OpenPane controls are missing');
  for (const control of controls) {
    if (control.closest('[hidden]')) continue;
    const bounds = control.getBoundingClientRect(), style = getComputedStyle(control);
    if (!bounds.width || !bounds.height || style.visibility !== 'visible' || style.display === 'none' || Number(style.opacity) === 0) throw new Error('An essential OpenPane control is hidden');
    const x = Math.max(0, Math.min(innerWidth - 1, bounds.x + bounds.width / 2)), y = Math.max(0, Math.min(innerHeight - 1, bounds.y + bounds.height / 2));
    const hit = document.elementFromPoint(x, y);
    if (!hit || !control.contains(hit) && !hit.contains(control)) throw new Error('An essential OpenPane control is covered');
  }
}
async function stage(state: UiClientSnapshot, signal: AbortSignal): Promise<HTMLLinkElement | null> {
  if (!state.bundle) return null;
  const { manifest, digest } = state.bundle;
  await Promise.all(manifest.assets.filter(asset => asset.mimeType === 'image/png').map(async asset => {
    const response = await fetch(`/ui-assets/${digest}/${asset.name}`, { signal });
    if (!response.ok) throw new Error('Experience artwork is unavailable');
    const bitmap = await createImageBitmap(await response.blob());
    try { if (bitmap.width > 2048 || bitmap.height > 2048) throw new Error('Experience artwork dimensions exceed limits'); }
    finally { bitmap.close(); }
  }));
  if (!manifest.stylesheet) return null;
  const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = `/ui-assets/${digest}/${manifest.stylesheet}`;
  await new Promise<void>((resolve, reject) => {
    const abort = () => { link.remove(); reject(new Error('Experience staging superseded')); };
    signal.addEventListener('abort', abort, { once: true });
    link.onload = () => { signal.removeEventListener('abort', abort); resolve(); };
    link.onerror = () => { signal.removeEventListener('abort', abort); link.remove(); reject(new Error('Experience stylesheet is unavailable')); };
    document.head.append(link);
  });
  return link;
}
export function ExperienceScope({ children }: { readonly children: ReactNode }) {
  const [connection] = useState(() => new UiConnection());
  const transport = useSyncExternalStore(connection.subscribe, connection.getSnapshot, connection.getSnapshot);
  const installedStylesheet = useRef<HTMLLinkElement | null>(null);
  const [visual, setVisual] = useState<VisualSelection | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [visible, setVisible] = useState(document.visibilityState === 'visible');
  useEffect(() => {
    connectionSubscribers.set(connection, (connectionSubscribers.get(connection) ?? 0) + 1);
    connection.start();
    const visibility = () => setVisible(document.visibilityState === 'visible');
    const recover = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key === 'Backspace') { event.preventDefault(); void connection.restore(); }
    };
    document.addEventListener('visibilitychange', visibility); window.addEventListener('keydown', recover, { capture: true });
    return () => { document.removeEventListener('visibilitychange', visibility); window.removeEventListener('keydown', recover, { capture: true }); const remaining = (connectionSubscribers.get(connection) ?? 1) - 1; if (remaining) connectionSubscribers.set(connection, remaining); else connectionSubscribers.delete(connection); queueMicrotask(() => { if (!connectionSubscribers.has(connection)) connection.close(); }); };
  }, [connection]);
  const state = transport.state;
  useEffect(() => {
    if (!state || !visible) return;
    const abort = new AbortController(); let link: HTMLLinkElement | null = null;
    const prior = visual;
    void (async () => {
      try {
        if (!transport.localBuiltin) link = await stage(state, abort.signal);
        if (abort.signal.aborted) { link?.remove(); return; }
        flushSync(() => setVisual(transport.localBuiltin ? null : state.bundle));
        await visibleFrame();
        if (abort.signal.aborted) return;
        const root = document.querySelector<HTMLElement>('.experience-content');
        if (!root) throw new Error('Experience frame unavailable');
        const deadline = performance.now() + 5000;
        while (!root.querySelector('[data-openpane-essential]') && performance.now() < deadline && !abort.signal.aborted) await visibleFrame();
        if (abort.signal.aborted) return;
        essentialControls(root);
        installedStylesheet.current?.remove(); installedStylesheet.current = link; link = null;
        setNotice(null);
        await connection.rendered(state).catch(() => setNotice('Appearance is visible locally; waiting for host confirmation.'));
      } catch (error) {
        if (abort.signal.aborted) return;
        link?.remove(); flushSync(() => setVisual(prior));
        const message = error instanceof Error ? error.message : 'Appearance could not render';
        setNotice(message); await connection.failed(state, message).catch(() => {});
      }
    })();
    return () => { abort.abort(); link?.remove(); };
    // Appearance delivery is keyed by its envelope, never the editor/controller or poll response object.
  }, [connection, state?.selection.deliveryGeneration, transport.localBuiltin, visible]);
  const applied = transport.localBuiltin ? null : visual;
  return <div className="experience-frame">
    <div className="experience-content" data-openpane-experience={applied?.digest} data-openpane-navigation={applied?.manifest.presentation.navigation}>
      <VisualContext value={applied}>{children}</VisualContext>
    </div>
    {(applied || transport.localBuiltin || notice || transport.diagnostic) && <ThemeScope className="experience-recovery" aria-label="Appearance recovery">
      <button type="button" onClick={() => void connection.restore()}>Restore OpenPane appearance</button>
      {(notice || transport.diagnostic) && <p role="status">{notice ?? transport.diagnostic}</p>}
    </ThemeScope>}
  </div>;
}
