import { UiActionsContext, VisualContext, ExperienceBootstrapContext, ExperienceCommittedContext, type ExperienceBootstrap, type VisualSelection } from './experience-state.js';
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { ThemeScope } from '@openpane/ui-primitives/desktop';
import { canonicalJson, homePaneOrder, type UiClientSnapshot } from '@openpane/contracts';
import { UiConnection, type UiTransport } from './ui-connection.js';
import './experience.css';
import { homeLayout } from '../shell/home-layout.js';
import type { HomePaneKind } from '@openpane/contracts';
import { DisplayTransportContext } from './display-state.js';

const connectionSubscribers = new WeakMap<UiTransport, number>();
function visibleFrame(): Promise<void> { return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))); }
function essentialControls(root: HTMLElement): void {
  const controls = root.querySelectorAll<HTMLElement>('[data-openpane-essential]');
  if (!controls.length) throw new Error('Essential OpenPane controls are missing');
  for (const control of controls) {
    if (control.closest('[hidden]')) continue;
    const bounds = control.getBoundingClientRect(), style = getComputedStyle(control);
    if (!bounds.width || !bounds.height || style.visibility !== 'visible' || style.display === 'none' || Number(style.opacity) === 0) throw new Error('An essential OpenPane control is hidden');
    if (/^(?:rgba|hsla)\([^)]*[,/]\s*0(?:\.0+)?\s*\)$/u.test(style.color) || style.color === 'transparent') throw new Error('An essential OpenPane control has transparent text');
    let left = bounds.left, top = bounds.top, right = bounds.right, bottom = bounds.bottom, scrollReachable = false;
    for (let ancestor = control.parentElement; ancestor && ancestor !== root.parentElement; ancestor = ancestor.parentElement) {
      const clip = ancestor.getBoundingClientRect(), css = getComputedStyle(ancestor);
      if (left < right && top < bottom) {
        if (['auto', 'scroll'].includes(css.overflowX) && ancestor.scrollWidth > ancestor.clientWidth) {
          const shift = Math.max(-(ancestor.scrollWidth - ancestor.clientWidth - ancestor.scrollLeft), Math.min(ancestor.scrollLeft, left >= clip.right ? clip.right - right : right <= clip.left ? clip.left - left : 0));
          left += shift; right += shift; scrollReachable ||= shift !== 0;
        }
        if (['auto', 'scroll'].includes(css.overflowY) && ancestor.scrollHeight > ancestor.clientHeight) {
          const shift = Math.max(-(ancestor.scrollHeight - ancestor.clientHeight - ancestor.scrollTop), Math.min(ancestor.scrollTop, top >= clip.bottom ? clip.bottom - bottom : bottom <= clip.top ? clip.top - top : 0));
          top += shift; bottom += shift; scrollReachable ||= shift !== 0;
        }
      }
      if (css.overflowX !== 'visible') { left = Math.max(left, clip.left + ancestor.clientLeft); right = Math.min(right, clip.left + ancestor.clientLeft + ancestor.clientWidth); }
      if (css.overflowY !== 'visible') { top = Math.max(top, clip.top + ancestor.clientTop); bottom = Math.min(bottom, clip.top + ancestor.clientTop + ancestor.clientHeight); }
    }
    left = Math.max(0, left); top = Math.max(0, top); right = Math.min(innerWidth, right); bottom = Math.min(innerHeight, bottom);
    if (left >= right || top >= bottom) throw new Error('An essential OpenPane control is clipped');
    if (scrollReachable) continue;
    const x = (left + right) / 2, y = (top + bottom) / 2;
    const hit = document.elementFromPoint(x, y);
    if (!hit || !control.contains(hit) && !hit.contains(control) && !hit.closest('[data-openpane-transient-overlay]')) throw new Error('An essential OpenPane control is covered');
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
  const link = document.createElement('link'); link.rel = 'stylesheet'; link.media = 'not all'; link.href = `/ui-assets/${digest}/${manifest.stylesheet}`;
  await new Promise<void>((resolve, reject) => {
    const abort = () => { link.remove(); reject(new Error('Experience staging superseded')); };
    signal.addEventListener('abort', abort, { once: true });
    link.onload = () => { signal.removeEventListener('abort', abort); resolve(); };
    link.onerror = () => { signal.removeEventListener('abort', abort); link.remove(); reject(new Error('Experience stylesheet is unavailable')); };
    document.head.append(link);
  });
  return link;
}
function structure(visual: VisualSelection | null): string {
  return canonicalJson(visual ? { presentation: visual.manifest.presentation, density: visual.manifest.theme.density } : null);
}
function captureFrame(root: HTMLElement | null) {
  const focused = document.activeElement instanceof HTMLElement && root?.contains(document.activeElement) ? document.activeElement : null;
  const selection = focused instanceof HTMLTextAreaElement || focused instanceof HTMLInputElement
    ? { start: focused.selectionStart, end: focused.selectionEnd, direction: focused.selectionDirection } : null;
  const scroll = [...(root?.querySelectorAll<HTMLElement>('*') ?? [])].filter(node => node.scrollTop || node.scrollLeft).map(node => ({ node, top: node.scrollTop, left: node.scrollLeft }));
  return (force = false) => {
    for (const item of scroll) if (item.node.isConnected) { item.node.scrollTop = item.top; item.node.scrollLeft = item.left; }
    if (!focused || !force && document.activeElement !== document.body && document.activeElement !== focused) return;
    if (focused.isConnected && !focused.closest('[hidden]') && focused.getClientRects().length) {
      focused.focus({ preventScroll: true });
      if (selection?.start !== null && selection?.end !== null && selection && (focused instanceof HTMLTextAreaElement || focused instanceof HTMLInputElement)) focused.setSelectionRange(selection.start, selection.end, selection.direction ?? undefined);
    } else root?.querySelector<HTMLElement>('.home-heading:not([hidden])')?.focus({ preventScroll: true });
  };
}
function validateHome(root: HTMLElement, visual: VisualSelection): void {
  const home = root.querySelector<HTMLElement>('[data-home-destination="home"]');
  if (!home || home.closest('[hidden]')) return;
  const actual = [...home.querySelectorAll<HTMLElement>('[data-home-pane]:not([hidden])')].map(pane => {
    const bounds = pane.getBoundingClientRect();
    if (!bounds.width || !bounds.height) throw new Error('A declared Home pane could not render');
    return pane.dataset.homePane;
  });
  if (JSON.stringify(actual) !== JSON.stringify(homePaneOrder(visual.manifest.presentation.home))) throw new Error('Home pane composition did not render in the declared order');
}
/** Measures the existing Home synchronously, then restores every DOM attribute before the browser can paint. */
function validateDestination(root: HTMLElement, visual: VisualSelection, destination: 'home' | 'chats'): void {
  const home = root.querySelector<HTMLElement>('[data-home-destination]');
  if (!home || home.dataset.homeDestination === destination && !home.closest('[hidden]')) return;
  const undo: (() => void)[] = [];
  const attribute = (node: HTMLElement, name: string, value: string | null) => {
    const previous = node.getAttribute(name);
    undo.push(() => previous === null ? node.removeAttribute(name) : node.setAttribute(name, previous));
    if (value === null) node.removeAttribute(name); else node.setAttribute(name, value);
  };
  const restoreFrame = captureFrame(root);
  try {
    const view = home.closest<HTMLElement>('.shell-view');
    if (view?.parentElement) for (const sibling of view.parentElement.children) {
      if (sibling instanceof HTMLElement && sibling.classList.contains('shell-view')) attribute(sibling, 'hidden', sibling === view ? null : '');
    }
    const layout = homeLayout(visual.manifest.presentation.home, destination);
    attribute(home, 'data-home-destination', destination);
    attribute(home, 'data-home-columns', layout.columns ? 'two' : 'one');
    attribute(home, 'data-home-balance', layout.balance);
    const heading = home.querySelector<HTMLElement>('.home-heading');
    if (heading) attribute(heading, 'hidden', destination === 'home' ? null : '');
    const host = home.querySelector<HTMLElement>('.pane-host');
    if (host) { attribute(host, 'style', host.getAttribute('style')); host.style.gridTemplateRows = layout.gridTemplateRows; }
    for (const pane of home.querySelectorAll<HTMLElement>('[data-home-pane]')) {
      const kind = pane.dataset.homePane as HomePaneKind;
      attribute(pane, 'hidden', layout.visible.includes(kind) ? null : '');
      attribute(pane, 'style', pane.getAttribute('style'));
      const placement = layout.placement(kind);
      pane.style.gridColumn = String(placement.gridColumn ?? ''); pane.style.gridRow = String(placement.gridRow ?? '');
    }
    essentialControls(root); validateHome(root, visual);
  } finally { for (const restore of undo.reverse()) restore(); restoreFrame(); }
}
export function ExperienceScope({ children, connection: supplied }: { readonly children: ReactNode; readonly connection?: UiTransport }) {
  const [connection] = useState(() => supplied ?? new UiConnection());
  const transport = useSyncExternalStore(connection.subscribe, connection.getSnapshot, connection.getSnapshot);
  const installedStylesheet = useRef<HTMLLinkElement | null>(null);
  const validatedVisual = useRef<VisualSelection | null>(null);
  const content = useRef<HTMLDivElement | null>(null);
  const composing = useRef<HTMLElement | null>(null);
  const initialized = useRef(false);
  const [bootstrap, setBootstrap] = useState<ExperienceBootstrap>({ kind: 'pending' });
  const [visual, setVisual] = useState<VisualSelection | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [phase, setPhase] = useState<'staging' | 'composition-deferred' | 'validating' | 'committed' | 'failed'>('staging');
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
    if (!state && transport.diagnostic && !initialized.current) { initialized.current = true; setBootstrap({ kind: 'settled', initial: 'builtin' }); }
  }, [state, transport.diagnostic]);
  useEffect(() => {
    if ((!state && !transport.localBuiltin) || !visible) return;
    const abort = new AbortController(); let link: HTMLLinkElement | null = null;
    const prior = validatedVisual.current;
    const candidate = transport.localBuiltin ? null : state?.bundle ?? null;
    let committed = false;
    let restoreCandidateFrame: ((force?: boolean) => void) | null = null;
    let candidateFocus: Element | null = null;
    void (async () => {
      await Promise.resolve();
      if (abort.signal.aborted) return;
      try {
        setPhase('staging');
        if (!transport.localBuiltin && state) link = await stage(state, abort.signal);
        if (abort.signal.aborted) { link?.remove(); return; }
        if ((candidate || structure(prior) !== structure(candidate)) && composing.current) {
          setPhase('composition-deferred'); setNotice(transport.localBuiltin ? 'Restore waiting for text input to finish' : 'Appearance waiting for text input to finish');
          while (composing.current && !abort.signal.aborted) {
            await visibleFrame();
            if (composing.current && (!composing.current.isConnected || document.activeElement !== composing.current)) composing.current = null;
          }
        }
        if (abort.signal.aborted) return;
        const root = content.current;
        if (!root) throw new Error('Experience frame unavailable');
        const deadline = performance.now() + 5000;
        while (!root.querySelector('[data-openpane-essential]') && (!candidate || performance.now() < deadline) && !abort.signal.aborted) await visibleFrame();
        if (abort.signal.aborted) return;
        setPhase('validating');
        const restoreFrame = captureFrame(content.current); restoreCandidateFrame = restoreFrame;
        if (link) link.media = 'all';
        flushSync(() => {
          if (!initialized.current && candidate) setBootstrap({ kind: 'candidate', initial: 'experience' });
          setVisual(candidate);
        });
        if (candidate) { essentialControls(root); validateHome(root, candidate); validateDestination(root, candidate, 'home'); validateDestination(root, candidate, 'chats'); }
        restoreFrame(); candidateFocus = document.activeElement;
        installedStylesheet.current?.remove(); installedStylesheet.current = link; link = null;
        validatedVisual.current = candidate; committed = true;
        if (!initialized.current) { initialized.current = true; setBootstrap({ kind: 'settled', initial: candidate ? 'experience' : 'builtin' }); }
        flushSync(() => { setPhase('committed'); setNotice(null); });
        await visibleFrame();
        if (abort.signal.aborted) return;
        await connection.rendered(state, transport.localBuiltin, transport.deliveryContext).catch(() => { if (!abort.signal.aborted) setNotice('Appearance is visible locally; waiting for host confirmation.'); });
      } catch (error) {
        if (abort.signal.aborted) return;
        link?.remove(); flushSync(() => {
          setVisual(prior);
          if (!initialized.current) { initialized.current = true; setBootstrap({ kind: 'settled', initial: 'builtin' }); }
        });
        restoreCandidateFrame?.(document.activeElement === candidateFocus);
        const message = error instanceof Error ? error.message : 'Appearance could not render';
        setPhase('failed'); setNotice(message);
        if (state) await connection.failed(state, message, transport.deliveryContext).catch(() => {});
      }
    })();
    return () => { abort.abort(); link?.remove(); if (!committed) { setVisual(validatedVisual.current); queueMicrotask(() => { if (document.activeElement === candidateFocus || document.activeElement === document.body) restoreCandidateFrame?.(true); }); } };
  }, [connection, transport.deliveryContext, state?.selection.deliveryGeneration, state?.selection.revision, state?.bundle?.digest, transport.localBuiltin, visible]);
  const waitingNotice = notice === 'Appearance is visible locally; waiting for host confirmation.' && transport.confirmedGeneration === state?.selection.deliveryGeneration ? null : notice;
  return <div className="experience-frame">
    <div ref={content} className="experience-content" data-openpane-experience={visual?.digest} data-openpane-navigation={visual?.manifest.presentation.navigation}
      data-openpane-transcript={visual?.manifest.presentation.transcript} data-experience-phase={phase}
      onCompositionStartCapture={event => { if (event.target instanceof HTMLElement) composing.current = event.target; }}
      onCompositionEndCapture={() => { composing.current = null; }}>
      <ExperienceCommittedContext value={phase === 'committed'}><ExperienceBootstrapContext value={bootstrap}><DisplayTransportContext value={connection}><UiActionsContext value={{ restore: () => connection.restore() }}><VisualContext value={visual}>{children}</VisualContext></UiActionsContext></DisplayTransportContext></ExperienceBootstrapContext></ExperienceCommittedContext>
    </div>
    {(visual || transport.localBuiltin || waitingNotice || transport.diagnostic) && <ThemeScope className="experience-recovery" aria-label="Appearance recovery">
      <button data-openpane-part="button" type="button" onClick={() => void connection.restore()}>Restore OpenPane appearance</button>
      {(waitingNotice || transport.diagnostic) && <p data-openpane-part="status" role="status">{waitingNotice ?? transport.diagnostic}</p>}
    </ThemeScope>}
  </div>;
}
