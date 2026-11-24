import { UiActionsContext, VisualContext, ExperienceBootstrapContext, ExperienceCommittedContext, type ExperienceBootstrap, type VisualSelection } from './experience-state.js';
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { ThemeScope } from '@openpane/ui-primitives/desktop';
import { canonicalJson, homePaneOrder, type UiClientSnapshot } from '@openpane/contracts';
import { UiConnection, type UiTransport } from './ui-connection.js';
import './experience.css';
import { homeLayout } from '../shell/home-layout.js';
import type { HomePaneKind } from '@openpane/contracts';
import { DisplayTransportContext } from './display-state.js';

interface InstalledAppearance {
  readonly visual: VisualSelection;
  readonly state: UiClientSnapshot;
  readonly context: string | null;
  readonly key: string;
}
const connectionSubscribers = new WeakMap<UiTransport, number>();
function visibleFrame(): Promise<void> { return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))); }
function rgb(value: string) {
  const match = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/u.exec(value);
  return match ? { red: Number(match[1]), green: Number(match[2]), blue: Number(match[3]), alpha: Number(match[4] ?? 1) } : null;
}
type Rgb = NonNullable<ReturnType<typeof rgb>>;
function composite(front: Rgb, back: Rgb): Rgb {
  const alpha = front.alpha + back.alpha * (1 - front.alpha);
  const channel = (a: number, b: number) => alpha ? (a * front.alpha + b * back.alpha * (1 - front.alpha)) / alpha : 0;
  return { red: channel(front.red, back.red), green: channel(front.green, back.green), blue: channel(front.blue, back.blue), alpha };
}
function luminance(color: Rgb): number {
  const linear = (value: number) => { const channel = value / 255; return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * linear(color.red) + 0.7152 * linear(color.green) + 0.0722 * linear(color.blue);
}
function luminanceRange(start: Rgb, end: Rgb): readonly [number, number] {
  const at = (position: number) => luminance({ red: start.red + (end.red - start.red) * position,
    green: start.green + (end.green - start.green) * position, blue: start.blue + (end.blue - start.blue) * position, alpha: 1 });
  // sRGB luminance is convex along an RGB segment: its maximum is an endpoint,
  // but differently colored stops can have a darker interpolated interior.
  let left = 0, right = 1;
  for (let step = 0; step < 24; step++) {
    const first = left + (right - left) / 3, second = right - (right - left) / 3;
    if (at(first) < at(second)) right = second; else left = first;
  }
  // The normalized sRGB derivative is below 3. Scale that bound by this
  // segment's channel changes to bound the finite minimum search error.
  const slope = 3 * (0.2126 * Math.abs(end.red - start.red) + 0.7152 * Math.abs(end.green - start.green) + 0.0722 * Math.abs(end.blue - start.blue)) / 255;
  return [Math.max(0, Math.min(at(0), at(1), at((left + right) / 2)) - slope * (right - left)), Math.max(at(0), at(1))];
}
function readableText(control: HTMLElement, style: CSSStyleDeclaration): void {
  const foreground = rgb(style.color);
  if (!foreground) return;
  if (foreground.alpha < 0.5) throw new Error('An essential OpenPane control has transparent text');
  let backgrounds: Rgb[] = [{ red: 0, green: 0, blue: 0, alpha: 0 }];
  let gradient = false;
  for (let surface: HTMLElement | null = control; surface; surface = surface.parentElement) {
    const css = getComputedStyle(surface);
    const layer = rgb(css.backgroundColor);
    if (!layer) return;
    const decoration = css.backgroundSize.split(',').every(size => {
      const dimensions = /^\s*([\d.]+)px\s+([\d.]+)px\s*$/u.exec(size);
      return dimensions !== null && Number(dimensions[1]) <= 8 && Number(dimensions[2]) <= 8;
    }) && css.backgroundRepeat.split(',').every(repeat => repeat.trim() === 'no-repeat');
    if (css.backgroundImage !== 'none' && !decoration) {
      const stops = [...css.backgroundImage.matchAll(/rgba?\([^)]*\)/gu)].flatMap(match => { const color = rgb(match[0]); return color ? [color] : []; });
      // Small app-owned decorations do not replace the text's underlying fill.
      if (css.backgroundImage.startsWith('url(')) throw new Error('Essential controls need a readable fill over artwork');
      if (!css.backgroundImage.startsWith('linear-gradient(') || (css.backgroundImage.match(/linear-gradient\(/gu) ?? []).length !== 1
        || stops.length < 2 || stops.length > 64 || gradient) throw new Error('Essential controls need one verifiable background gradient');
      gradient = true;
      const front = backgrounds[0];
      if (!front) return;
      backgrounds = stops.map(stop => composite(front, composite(stop, layer)));
    } else {
      backgrounds = backgrounds.map(background => composite(background, layer));
    }
    if (backgrounds.every(background => background.alpha === 1)) break;
  }
  backgrounds = backgrounds.map(background => composite(background, { red: 255, green: 255, blue: 255, alpha: 1 }));
  for (const [index, start] of backgrounds.entries()) {
    const end = backgrounds[index + 1] ?? start;
    const pending = [{ start, end, depth: 0 }];
    let remaining = 128;
    while (pending.length) {
      const segment = pending.pop();
      if (!segment) break;
      const [fillMin, fillMax] = luminanceRange(segment.start, segment.end);
      const [textMin, textMax] = luminanceRange(composite(foreground, segment.start), composite(foreground, segment.end));
      const bound = textMin > fillMax ? (textMin + 0.05) / (fillMax + 0.05)
        : fillMin > textMax ? (fillMin + 0.05) / (textMax + 0.05) : 1;
      if (bound >= 1.5) continue;
      const middle = { red: (segment.start.red + segment.end.red) / 2, green: (segment.start.green + segment.end.green) / 2,
        blue: (segment.start.blue + segment.end.blue) / 2, alpha: 1 };
      const unreadable = [segment.start, middle, segment.end].some(fill => {
        const text = luminance(composite(foreground, fill)), background = luminance(fill);
        return (Math.max(text, background) + 0.05) / (Math.min(text, background) + 0.05) < 1.5;
      });
      if (unreadable || segment.depth >= 12 || --remaining === 0) throw new Error('An essential OpenPane control has unreadable text');
      pending.push({ start: segment.start, end: middle, depth: segment.depth + 1 }, { start: middle, end: segment.end, depth: segment.depth + 1 });
    }
  }
}
const essentialSelector = '[data-openpane-essential], .settings-panel button, .settings-panel label, .settings-panel input, .settings-panel textarea, .settings-panel select, .extension-list [data-openpane-part="button"], .extension-back';
function essentialControls(root: HTMLElement): void {
  const controls = root.querySelectorAll<HTMLElement>(essentialSelector);
  if (!controls.length) throw new Error('Essential OpenPane controls are missing');
  for (const control of controls) {
    if (control.closest('[hidden]')) continue;
    const bounds = control.getBoundingClientRect(), style = getComputedStyle(control);
    if (!bounds.width || !bounds.height || style.visibility !== 'visible' || style.display === 'none' || Number(style.opacity) === 0) throw new Error('An essential OpenPane control is hidden');
    if (/^(?:rgba|hsla)\([^)]*[,/]\s*0(?:\.0+)?\s*\)$/u.test(style.color) || style.color === 'transparent') throw new Error('An essential OpenPane control has transparent text');
    readableText(control, style);
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
    const image = new Image();
    const abort = () => { image.src = ''; };
    signal.addEventListener('abort', abort, { once: true });
    try {
      signal.throwIfAborted();
      image.src = `/ui-assets/${digest}/${asset.name}`;
      await image.decode();
      signal.throwIfAborted();
      if (image.naturalWidth > 2048 || image.naturalHeight > 2048) throw new Error('Experience artwork dimensions exceed limits');
    } finally { signal.removeEventListener('abort', abort); }
  }));
  signal.throwIfAborted();
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
/** Measures mounted destinations synchronously and restores their DOM before the browser can paint. */
function validateDestination(root: HTMLElement, visual: VisualSelection, destination: 'home' | 'chats' | 'settings' | 'extensions'): void {
  const home = root.querySelector<HTMLElement>('[data-home-destination]');
  const view = destination === 'home' || destination === 'chats' ? home?.closest<HTMLElement>('.shell-view') : root.querySelector<HTMLElement>(`[data-shell-destination="${destination}"]`);
  if (!view || !home || home.dataset.homeDestination === destination && !home.closest('[hidden]')) return;
  const undo: (() => void)[] = [];
  const attribute = (node: HTMLElement, name: string, value: string | null) => {
    const previous = node.getAttribute(name);
    undo.push(() => previous === null ? node.removeAttribute(name) : node.setAttribute(name, previous));
    if (value === null) node.removeAttribute(name); else node.setAttribute(name, value);
  };
  const restoreFrame = captureFrame(root);
  try {
    if (view.parentElement) for (const sibling of view.parentElement.children) {
      if (sibling instanceof HTMLElement && sibling.classList.contains('shell-view')) attribute(sibling, 'hidden', sibling === view ? null : '');
    }
    for (const button of root.querySelectorAll<HTMLElement>('[data-openpane-role="navigation"][data-openpane-essential]')) {
      const selected = button.dataset.openpaneEssential === destination;
      attribute(button, 'data-openpane-state', selected ? 'selected' : null); attribute(button, 'aria-pressed', String(selected));
    }
    if (destination === 'settings' || destination === 'extensions') { essentialControls(root); return; }
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
  const [installedAppearance, setInstalledAppearance] = useState<InstalledAppearance | null>(null);
  const validatedVisual = useRef<VisualSelection | null>(null);
  const mountedVisual = useRef<VisualSelection | null>(null);
  const failedDelivery = useRef<string | null>(null);
  const content = useRef<HTMLDivElement | null>(null);
  const composing = useRef<HTMLElement | null>(null);
  const deferredReadability = useRef<(() => void) | null>(null);
  const readabilityFrame = useRef<number | null>(null);
  function settleReadability(): void {
    readabilityFrame.current = null;
    if (!deferredReadability.current) return;
    if (composing.current?.isConnected && document.activeElement === composing.current) {
      readabilityFrame.current = requestAnimationFrame(settleReadability);
      return;
    }
    composing.current = null;
    deferredReadability.current();
  }
  const initialized = useRef(false);
  const [bootstrap, setBootstrap] = useState<ExperienceBootstrap>({ kind: 'pending' });
  const [visual, setVisual] = useState<VisualSelection | null>(null);
  useLayoutEffect(() => { mountedVisual.current = visual; }, [visual]);
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
    return () => { if (readabilityFrame.current !== null) cancelAnimationFrame(readabilityFrame.current); readabilityFrame.current = null; document.removeEventListener('visibilitychange', visibility); window.removeEventListener('keydown', recover, { capture: true }); const remaining = (connectionSubscribers.get(connection) ?? 1) - 1; if (remaining) connectionSubscribers.set(connection, remaining); else connectionSubscribers.delete(connection); queueMicrotask(() => { if (!connectionSubscribers.has(connection)) connection.close(); }); };
  }, [connection]);
  const state = transport.state;
  const deliveryKey = state ? canonicalJson([transport.deliveryContext, state.selection.deliveryGeneration, state.selection.revision, state.bundle?.digest ?? null]) : null;
  useEffect(() => {
    if (!state && transport.diagnostic && !initialized.current) { initialized.current = true; setBootstrap({ kind: 'settled', initial: 'builtin' }); }
  }, [state, transport.diagnostic]);
  useEffect(() => {
    if ((!state && !transport.localBuiltin) || !visible || !transport.localBuiltin && failedDelivery.current === deliveryKey) return;
    const abort = new AbortController(); let link: HTMLLinkElement | null = null;
    const mounted = mountedVisual.current;
    const prior = () => validatedVisual.current === mounted ? mounted : null;
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
        if (abort.signal.aborted) return;
        const root = content.current;
        if (!root) throw new Error('Experience frame unavailable');
        const deadline = performance.now() + 5000;
        while (!root.querySelector('[data-openpane-essential]') && (!candidate || performance.now() < deadline) && !abort.signal.aborted) await visibleFrame();
        if (abort.signal.aborted) return;
        if (!transport.localBuiltin && failedDelivery.current === deliveryKey) { link?.remove(); return; }
        if ((candidate || structure(mounted) !== structure(candidate)) && composing.current) {
          setPhase('composition-deferred'); setNotice(transport.localBuiltin ? 'Restore waiting for text input to finish' : 'Appearance waiting for text input to finish');
          while (composing.current && !abort.signal.aborted) {
            await visibleFrame();
            if (composing.current && (!composing.current.isConnected || document.activeElement !== composing.current)) composing.current = null;
          }
        }
        if (abort.signal.aborted) return;
        if (!transport.localBuiltin && failedDelivery.current === deliveryKey) { link?.remove(); return; }
        setPhase('validating');
        const restoreFrame = captureFrame(content.current); restoreCandidateFrame = restoreFrame;
        if (link) link.media = 'all';
        flushSync(() => {
          if (!initialized.current && candidate) setBootstrap({ kind: 'candidate', initial: 'experience' });
          setVisual(candidate);
        });
        if (candidate) {
          essentialControls(root); validateHome(root, candidate);
          for (const destination of ['home', 'chats', 'settings', 'extensions'] as const) validateDestination(root, candidate, destination);
        }
        restoreFrame(); candidateFocus = document.activeElement;
        deferredReadability.current = null;
        if (readabilityFrame.current !== null) cancelAnimationFrame(readabilityFrame.current);
        readabilityFrame.current = null;
        installedStylesheet.current?.remove(); installedStylesheet.current = link; link = null;
        validatedVisual.current = candidate; committed = true;
        failedDelivery.current = null;
        if (!initialized.current) { initialized.current = true; setBootstrap({ kind: 'settled', initial: candidate ? 'experience' : 'builtin' }); }
        flushSync(() => {
          setInstalledAppearance(candidate && state && deliveryKey !== null ? { visual: candidate, state, context: transport.deliveryContext, key: deliveryKey } : null);
          setPhase('committed'); setNotice(null);
        });
        await visibleFrame();
        if (abort.signal.aborted || validatedVisual.current !== candidate) return;
        await connection.rendered(state, transport.localBuiltin, transport.deliveryContext).catch(() => { if (!abort.signal.aborted && validatedVisual.current === candidate) setNotice('Appearance is visible locally; waiting for host confirmation.'); });
      } catch (error) {
        if (abort.signal.aborted) return;
        link?.remove();
        if (!transport.localBuiltin && failedDelivery.current === deliveryKey) return;
        if (!deferredReadability.current) {
          flushSync(() => {
            setVisual(prior());
            if (!initialized.current) { initialized.current = true; setBootstrap({ kind: 'settled', initial: 'builtin' }); }
          });
          restoreCandidateFrame?.(document.activeElement === candidateFocus);
        }
        const message = error instanceof Error ? error.message : 'Appearance could not render';
        failedDelivery.current = deliveryKey;
        setPhase(deferredReadability.current ? 'composition-deferred' : 'failed');
        setNotice(deferredReadability.current ? 'Appearance recovery waiting for text input to finish' : message);
        if (state) await connection.failed(state, message, transport.deliveryContext).catch(() => {});
      }
    })();
    return () => { abort.abort(); link?.remove(); if (!committed && !deferredReadability.current) { setVisual(prior()); queueMicrotask(() => { if (document.activeElement === candidateFocus || document.activeElement === document.body) restoreCandidateFrame?.(true); }); } };
  }, [connection, transport.deliveryContext, state?.selection.deliveryGeneration, state?.selection.revision, state?.bundle?.digest, transport.localBuiltin, visible, deliveryKey]);
  useEffect(() => {
    const root = content.current;
    if (!installedAppearance || !root) return;
    let frame: number | null = null;
    const check = () => {
      frame = null;
      if (document.visibilityState !== 'visible' || validatedVisual.current !== installedAppearance.visual || mountedVisual.current !== installedAppearance.visual) return;
      try {
        for (const control of root.querySelectorAll<HTMLElement>(essentialSelector)) {
          if (!control.closest('[hidden]') && control.getClientRects().length) readableText(control, getComputedStyle(control));
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Appearance text became unreadable';
        // Keep a newer candidate's failure sticky when its preceding frame also fails.
        failedDelivery.current ??= installedAppearance.key;
        validatedVisual.current = null;
        const finish = () => {
          const restoreFrame = captureFrame(root);
          deferredReadability.current = null;
          if (readabilityFrame.current !== null) cancelAnimationFrame(readabilityFrame.current);
          readabilityFrame.current = null;
          installedStylesheet.current?.remove(); installedStylesheet.current = null;
          flushSync(() => { setInstalledAppearance(null); setVisual(null); setPhase('failed'); setNotice(message); });
          restoreFrame();
        };
        if (composing.current) {
          deferredReadability.current = finish;
          if (readabilityFrame.current === null) readabilityFrame.current = requestAnimationFrame(settleReadability);
          setPhase('composition-deferred'); setNotice('Appearance recovery waiting for text input to finish');
        } else finish();
        void connection.failed(installedAppearance.state, message, installedAppearance.context).catch(() => {});
      }
    };
    const schedule = () => { if (frame === null) frame = requestAnimationFrame(check); };
    const events = ['pointerover', 'pointerout', 'pointerdown', 'pointerup', 'focusin', 'focusout', 'keydown', 'keyup', 'change'];
    for (const event of events) root.addEventListener(event, schedule, true);
    const observer = new MutationObserver(records => {
      if (records.some(record => record.type === 'attributes' || [...record.addedNodes].some(node =>
        node instanceof HTMLElement && (node.matches(essentialSelector) || node.querySelector(essentialSelector))))) schedule();
    });
    observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['disabled', 'checked', 'hidden', 'data-openpane-state', 'data-appearance'] });
    const queries = new Set<string>(['(prefers-color-scheme: dark)']);
    const collect = (rules: CSSRuleList) => {
      for (const rule of rules) {
        if (rule instanceof CSSMediaRule) queries.add(rule.conditionText);
        if (rule instanceof CSSGroupingRule) collect(rule.cssRules);
      }
    };
    if (installedStylesheet.current?.sheet) collect(installedStylesheet.current.sheet.cssRules);
    const media = [...queries].map(query => window.matchMedia(query));
    for (const query of media) query.addEventListener('change', schedule);
    document.addEventListener('visibilitychange', schedule);
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      observer.disconnect();
      for (const event of events) root.removeEventListener(event, schedule, true);
      for (const query of media) query.removeEventListener('change', schedule);
      document.removeEventListener('visibilitychange', schedule);
    };
  }, [connection, installedAppearance]);
  const waitingNotice = notice === 'Appearance is visible locally; waiting for host confirmation.' && transport.confirmedGeneration === state?.selection.deliveryGeneration ? null : notice;
  return <div className="experience-frame">
    <div ref={content} className="experience-content" data-openpane-experience={visual?.digest} data-openpane-navigation={visual?.manifest.presentation.navigation}
      data-openpane-transcript={visual?.manifest.presentation.transcript} data-experience-phase={phase}
      onCompositionStartCapture={event => { if (event.target instanceof HTMLElement) composing.current = event.target; }}
      onCompositionEndCapture={() => { composing.current = null; deferredReadability.current?.(); }}
      onBlurCapture={event => { if (composing.current === event.target) { composing.current = null; deferredReadability.current?.(); } }}>
      <ExperienceCommittedContext value={phase === 'committed'}><ExperienceBootstrapContext value={bootstrap}><DisplayTransportContext value={connection}><UiActionsContext value={{ restore: () => connection.restore() }}><VisualContext value={visual}>{children}</VisualContext></UiActionsContext></DisplayTransportContext></ExperienceBootstrapContext></ExperienceCommittedContext>
    </div>
    {(visual || transport.localBuiltin || waitingNotice || transport.diagnostic) && <ThemeScope className="experience-recovery" aria-label="Appearance recovery">
      <button data-openpane-part="button" type="button" onClick={() => void connection.restore()}>Restore OpenPane appearance</button>
      {(waitingNotice || transport.diagnostic) && <p data-openpane-part="status" role="status">{waitingNotice ?? transport.diagnostic}</p>}
    </ThemeScope>}
  </div>;
}
