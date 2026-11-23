import { SavedDraftRecovery } from '../application/SavedDraftRecovery.js';
import { sameScope } from '@openpane/contracts';
import { useExperience, useUiActions } from '../application/experience-state.js';
import { useDisplayScope } from '../application/display-state.js';
import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { DesktopShell } from './Shell.js';
import { HostStatusLabel } from './HostStatusLabel.js';
import { applicationEnabled } from '../application/application-controller.js';
import { useApplication } from '../application/use-application.js';
import { ConversationStatus, ConversationView } from '../application/ConversationView.js';
import { agentPresentation, conversationPresentation } from '../application/agent-presentation.js';
import '../application/application.css';
import customization from '../application/customization-selection.js';
import { useDesktopCustomizations } from '../application/DesktopCustomizations.js';
import { CustomizationModules, type ModuleSurface } from '../application/CustomizationModules.js';
import { ConversationSearch } from '../application/ConversationSearch.js';
import { ComposerAgentControls } from '../application/ComposerAgentControls.js';
import { NewConversation } from '../application/NewConversation.js';
import { continuationAnnouncement } from '../application/continuation-copy.js';
import { ExtensionsList, ExtensionWorkspace, conversationSlots, extensionRows, openableRow } from '../application/ExtensionsView.js';
import { ThemeScope } from '@openpane/ui-primitives/desktop';
import { palettes } from '@openpane/theme';
import { usePersonalization } from '../application/use-personalization.js';
import { PersonalizationSettings } from '../application/PersonalizationSettings.js';
import { conversationLabel } from '@openpane/contracts/conversation';
import type { ApplicationController, OpenConversation } from '../application/application-controller.js';

type ConnectionPresentation =
  | { readonly kind: 'browser' }
  | { readonly kind: 'native'; readonly controls: ReactElement; readonly reconnect: () => void };

/** Resolves true once the store reports a live connection; false as soon as it leaves `connecting` any other way, or after `ms`. */
function whenConnected(store: OpenConversation['store'], ms = 10_000): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false, unsubscribe: (() => void) | null = null;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe?.();
      resolve(value);
    };
    const check = () => {
      const kind = store.getSnapshot().connection.kind;
      if (kind === 'connected') finish(true);
      else if (kind !== 'connecting') finish(false);
    };
    const timer = setTimeout(() => finish(false), ms);
    unsubscribe = store.subscribe(check);
    check();
  });
}

/**
 * Applies a view change as one animated step where the platform supports view transitions. The composer and greeting
 * carry transition names only while `data-morphing` is set, so they are not a permanent stacking context.
 */
function reveal(update: () => void, after: () => void): void {
  const reduced = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced || typeof document.startViewTransition !== 'function') {
    flushSync(update);
    after();
    return;
  }
  const root = document.documentElement;
  root.dataset.morphing = 'true';
  try {
    const transition = document.startViewTransition(() => { flushSync(update); after(); });
    void transition.finished.catch(() => {}).finally(() => { delete root.dataset.morphing; });
  } catch {
    delete root.dataset.morphing;
    flushSync(update);
    after();
  }
}

export function BrowserApplication({ children, artifact, controller: supplied, connection = { kind: 'browser' }, suspended = false, catalogOnly = false, fixedChat = false, managedLifecycle = false, windowRecovery = null, placementNotice = null }: {
  readonly children?: ReactNode; readonly artifact?: ReactNode; readonly controller?: ApplicationController;
  readonly connection?: ConnectionPresentation;
  readonly suspended?: boolean;
  readonly catalogOnly?: boolean;
  readonly fixedChat?: boolean;
  readonly managedLifecycle?: boolean;
  readonly windowRecovery?: ReactNode;
  readonly placementNotice?: string | null;
}) {
  const { controller, snapshot: app } = useApplication(supplied, managedLifecycle);
  useDisplayScope(catalogOnly ? null : app.active?.scope ?? null);
  // The new-conversation composer's text, and whether it is opening a conversation. While it opens, the new-conversation
  // screen stays up; the conversation replaces it in one step once its first message is on its way.
  const [launchText, setLaunchText] = useState('');
  const [opening, setOpening] = useState(false);
  const openingGuard = useRef(false);
  useEffect(() => {
    // The webview receives OS file drops itself; a file dropped anywhere the conversation panel did not handle must
    // not navigate the window away from the app.
    const guard = (event: DragEvent) => {
      if (event.defaultPrevented || !event.dataTransfer?.types.includes('Files')) return;
      event.preventDefault();
      if (event.type === 'dragover') event.dataTransfer.dropEffect = 'none';
    };
    window.addEventListener('dragover', guard);
    window.addEventListener('drop', guard);
    return () => { window.removeEventListener('dragover', guard); window.removeEventListener('drop', guard); };
  }, []);
  const [selectedView, setSelectedView] = useState<'chats' | 'extensions' | 'settings'>('chats');
  const [selectedExtension, setSelectedExtension] = useState<string | null>(null);
  const personalization = usePersonalization();
  const { document: preferences, session: personalizationSession } = personalization;
  const customizationEnabled = personalization.readiness === 'ready' && preferences.ui.enabled;
  const customizationsOn = children === undefined && customizationEnabled;
  const selectedPalette = preferences.palette;
  const paletteResource = selectedPalette.kind === 'imported' ? personalization.saved?.palettes.find(item => item.digest === selectedPalette.digest && item.kind === 'ready') : undefined;
  const experience = useExperience();
  const uiActions = useUiActions();
  const contentPalette = experience ? { light: { ...palettes.light, ...experience.manifest.theme.light.colors }, dark: { ...palettes.dark, ...experience.manifest.theme.dark.colors } } : paletteResource?.kind === 'ready' ? paletteResource.document.colors : palettes;
  const custom = useDesktopCustomizations({ customizations: customization, sink: controller.frontendGenerations, enabled: customizationsOn,
    disabledNamespaces: preferences.ui.disabledNamespaces, slots: preferences.ui.slots, loading: personalization.readiness === 'loading' });
  const [recoveryChoice, setRecoveryChoice] = useState<{ scopeKey: string; agentId: string } | null>(null);
  const pendingScope = app.saved.pendingCreation?.scope;
  const pendingScopeKey = JSON.stringify([pendingScope?.hostId, pendingScope?.conversationId]);
  const recoveryAgent = app.saved.pendingCreation?.agentId === null && recoveryChoice?.scopeKey === pendingScopeKey ? recoveryChoice.agentId : undefined;
  const enabled = applicationEnabled(app) && !suspended;
  const metadata = 'metadata' in app.host ? app.host.metadata : null;
  const choices = metadata?.agents ?? [];
  const pi = choices.find(agent => 'runtime' in agent && agent.runtime.engine === 'pi');
  const [launchNotice, setLaunchNotice] = useState('');
  useEffect(() => setLaunchNotice(''), [app.active?.scope.hostId, app.active?.scope.conversationId]);
  const setupPi = () => setSelectedView('settings');
  /** Starts a conversation from the new-conversation screen, carrying its text over as the draft or the first message. */
  async function startConversation(agentId: string | undefined, send: boolean): Promise<void> {
    // The launch composer is read-only while this runs, so the text cannot change under it.
    if (openingGuard.current) return;
    openingGuard.current = true;
    const text = launchText, before = controller.getSnapshot().active;
    let opened = false, carried = !text;
    setLaunchNotice(''); setOpening(true);
    try {
      const result = await controller.create(agentId, text || undefined);
      if (result.kind !== 'inline') {
        if (result.kind === 'detached' || result.kind === 'pending' && result.scope) {
          carried = true;
          if (text) setLaunchNotice('Your message is saved as an unsent draft in the new chat. Send it there when ready.');
        }
        return;
      }
      const active = controller.getSnapshot().active;
      // A refused creation reports its own error; the typed text stays where it was.
      if (!active || active === before || !sameScope(active.scope, result.scope)) return;
      opened = true;
      if (text) await active.store.setDraft(text);
      carried = true;
      // Send only as the conversation's own Send would: connected, and an agent that takes messages. Otherwise the
      // text waits in its draft.
      if (send && text.trim() && active.agent.commands.includes('send') && await whenConnected(active.store) && controller.canAutomaticallySend(active.scope))
        await controller.conversationActions(active).submit(() => active.store.send());
    } catch {
      // A failed send leaves the message in the conversation's outbox or draft; a failed draft write keeps the launch text.
    } finally {
      openingGuard.current = false;
      const swap = () => { setOpening(false); if (carried) setLaunchText(''); };
      // Clear the text in the same step that swaps the screens, so the composer morphs with its text still in it.
      if (!opened) swap();
      else reveal(swap, () => {
        const field = document.getElementById('message');
        if (field && (document.activeElement === null || document.activeElement === document.body)) field.focus();
      });
    }
  }
  const selected = choices.find(agent => agent.id === app.active?.agent.id && agent.availability.kind === 'ready')
    ?? choices.find(agent => agent.id === metadata?.defaultAgentId && agent.availability.kind === 'ready')
    ?? choices.find(agent => agent.availability.kind === 'ready');
  const options = choices.map(agent => <option key={agent.id} value={agent.id} disabled={agent.availability.kind !== 'ready'}>
    {agent.label}{agent.availability.kind !== 'ready' ? ' · Unavailable' : ''}
  </option>);
  const searchConnection = app.host.kind === 'ready' && !app.storageFailure
    ? JSON.stringify([app.host.metadata.hostId, app.host.metadata.principalId]) : null;
  const displayedAgent = app.active?.agent ?? selected;
  const runtime = displayedAgent ? ('runtime' in displayedAgent ? displayedAgent.runtime : displayedAgent) : metadata?.compatibility.nativeRuntime ?? null;
  const { agent, presentation } = agentPresentation(runtime);
  const activeActions = app.active ? controller.conversationActions(app.active) : null;
  const moduleList = (surface: ModuleSurface) => custom.namespaces.map(owner => <CustomizationModules key={owner.namespace} owner={owner}
    active={app.active} actions={activeActions} enabled={enabled} agent={agent} surface={surface} />);
  // Tools leave the conversation column: it keeps load notices, a claimed layout places everything, Extensions runs the rest.
  const layoutClaimed = custom.contentLayout.kind === 'claimed';
  const modules = moduleList(layoutClaimed ? 'all' : 'status');
  const rows = extensionRows({ customizations: customization, activations: custom.namespaces, enabled: customizationsOn, disabledNamespaces: preferences.ui.disabledNamespaces, metadata });
  const workspaceRow = openableRow(rows.find(row => row.namespace === selectedExtension));
  const workspaceOpen = selectedView === 'extensions' && workspaceRow !== null;
  // One element, placed in one slot: the Chats view, or the open workspace of the active conversation's namespace.
  const slots = conversationSlots({ row: workspaceOpen ? workspaceRow : null, active: app.active, metadata, custom, modules, agents: choices });
  const customizationNotices = custom.namespaces.some(owner => owner.kind === 'loading' || owner.kind === 'failed');
  const activeAgent = app.active?.agent;
  const composerAgents = fixedChat && activeAgent ? slots.composerAgents.filter(choice => ('kind' in choice ? choice.namespace : null) === ('kind' in activeAgent ? activeAgent.namespace : null)) : slots.composerAgents;
  const activeConversation = !catalogOnly && app.active && activeActions
    ? <ConversationView
        key={`${app.active.viewId}/${app.active.scope.hostId}/${app.active.scope.conversationId}`}
        contentPalette={contentPalette} transcript={slots.transcript} activity={custom.activity} contentLayout={slots.contentLayout} modules={slots.modules} permissionState={app.permissionState} observation={app.observation} continuation={app.continuation} actions={activeActions} active={app.active} enabled={enabled} storageFailure={app.storageFailure} agent={agent} customizationNotices={customizationNotices}
        composerControls={canSwitch => <ComposerAgentControls agents={composerAgents} agent={app.active?.agent ?? null} hasConversation enabled={canSwitch && app.saved.pendingCreation === null} onStartConversation={id => void controller.create(id)} {...(fixedChat ? {} : { onSetupPi: setupPi })} />}
      />
    : null;
  const workspaceConversation = slots.workspace ? activeConversation : null;
  const toolsEligible = Boolean(app.active) && !layoutClaimed &&
    custom.namespaces.some(owner => owner.kind === 'ready' && owner.presentation.modules.length > 0);
  const toolsTarget = app.active && toolsEligible ? (() => {
    const scope = app.active.scope, entry = app.catalog.items.find(item => item.scope.conversationId === scope.conversationId && item.scope.hostId === scope.hostId);
    return entry ? conversationLabel(entry) : scope.conversationId;
  })() : null;
  // The footer carries the conversation's disclosure wherever its composer is on screen.
  const composerVisible = Boolean(activeConversation) && ((selectedView === 'chats' && !slots.workspace) || (workspaceOpen && Boolean(slots.workspace)));
  const canStart = enabled && app.saved.pendingCreation === null && !opening;
  const conversation = catalogOnly ? <section className="chat-catalog-empty" aria-label="Chats in separate windows"><h1>Chats open in their own windows</h1><p>Choose a chat from the catalog or start a new chat with an available agent.</p>{placementNotice && <p role="status">{placementNotice}</p>}</section> : !slots.workspace && activeConversation && !opening
    ? activeConversation
    : <NewConversation text={launchText} onText={setLaunchText} placeholder={presentation.placeholder} opening={opening}
        note={app.host.kind === 'ready' && !selected ? 'No agents are available to start a conversation.'
          : app.host.kind !== 'ready' ? 'Connect to your local host, then start a conversation. Your chats and drafts stay here when you come back.' : null}
        canSend={canStart && Boolean(selected?.commands.includes('send')) && Boolean(launchText.trim())}
        onSend={() => void startConversation(selected?.id, true)}
        controls={<ComposerAgentControls agents={choices} agent={selected ?? null} hasConversation={false} enabled={canStart} onStartConversation={id => void startConversation(id, false)} {...(fixedChat ? {} : { onSetupPi: setupPi })} />} />;
  const hostAlerts = <>
    {launchNotice && <p role="status">{launchNotice}</p>}
    {catalogOnly && launchText && !opening && <details><summary>Unsent launch text</summary><textarea readOnly aria-label="Unsent launch text" value={launchText} /></details>}
    {app.savedDraftRecovery && <SavedDraftRecovery key={`${app.savedDraftRecovery.viewId}/${app.savedDraftRecovery.scope.conversationId}`} recovery={app.savedDraftRecovery} onSelectScope={scope => { if (app.savedDraftRecovery) void controller.inspectSavedDraft(app.savedDraftRecovery.viewId, scope); }} onOpen={() => { if (app.savedDraftRecovery) void (app.savedDraftRecovery.kind === 'bound' ? controller.create() : controller.open(app.savedDraftRecovery.scope)); }} onRemainingWork={() => { if (app.savedDraftRecovery) void controller.openRemainingSavedWork(app.savedDraftRecovery); }} onDismiss={() => { if (app.savedDraftRecovery) controller.dismissSavedDraftRecovery(app.savedDraftRecovery); }} />}
    {app.storageFailure && <div className="application-alert" role="alert"><strong>Local storage unavailable. Commands are blocked.</strong><p>{app.storageFailure}</p><p>Existing records have not been discarded. Restore browser storage access, then reload.</p></div>}
    {app.error && <p className="application-alert" role="alert">{app.error}</p>}
    {!placementNotice && app.lastPlacement?.kind === 'pending' && <p role="status">{app.lastPlacement.reason}</p>}
    {placementNotice && <p role="status">{placementNotice}</p>}
    {app.host.kind === 'incompatible' && <div className="application-alert" role="alert"><strong>This host is incompatible. Commands are blocked.</strong>
      {app.host.issues.map(issue => <p key={issue.dimension}>{issue.reason} {issue.action}</p>)}
    </div>}
  </>;
  const creationRecovery = app.saved.pendingCreation && <div className="creation-recovery"><p>Creation of {app.saved.pendingCreation.scope.conversationId} needs confirmation. Recovery uses the saved conversation and agent.</p>
    {app.saved.pendingCreation.agentId === null && <label className="agent-choice">Agent if this chat was not created<select aria-label="Agent for pending creation" disabled={!enabled} value={recoveryAgent ?? ''} onChange={event => setRecoveryChoice(event.target.value ? { scopeKey: pendingScopeKey, agentId: event.target.value } : null)}>
      <option value="">Check the saved chat first</option>{options}
    </select></label>}
    <button disabled={!enabled} onClick={() => void controller.recoverCreation(recoveryAgent ?? undefined)}>Recover creation</button>
  </div>;
  const personalizationNotice = <>{personalization.diagnostic && <p className="application-alert" role="alert">{personalization.diagnostic}</p>}
    {selectedPalette.kind === 'imported' && !paletteResource && <p role="alert">Selected palette is unavailable. Reimport it or choose builtin in Settings.</p>}
    {personalization.recovery.appearance === 'session' && <p role="alert">Default appearance restored for this session.</p>}
    {personalization.recovery.view === 'session' && <p role="alert">Default view restored for this session.</p>}</>;
  const extensionsView = <div className="extensions-view" inert={suspended}>
    {workspaceOpen
      ? <ExtensionWorkspace contentPalette={contentPalette} row={workspaceRow} metadata={metadata} workspaces={app.workspaces} active={catalogOnly ? null : app.active} controller={controller}
          conversation={workspaceConversation} status={<>{personalizationNotice}{hostAlerts}{creationRecovery}</>} onBack={() => setSelectedExtension(null)} />
      : <ExtensionsList rows={rows} enabled={!suspended} onOpen={setSelectedExtension}
          tools={toolsEligible ? <ThemeScope palette={contentPalette} className="content-theme">{moduleList('tools')}</ThemeScope> : null} conversation={toolsTarget} />}
  </div>;
  const controls = <div className="application-controls">
    {windowRecovery}
    {!workspaceOpen && personalizationNotice}
    <h2 className="sidebar-title">{selectedView === 'chats' ? 'Chats' : selectedView === 'extensions' ? 'Extensions' : 'Settings'}</h2>
    {app.capturedSends.length > 0 && <section aria-label="Captured tools"><h3>Captured tools</h3>
      <p>Tools are retained for these sends. Execution is not enabled.</p>
      {app.capturedSends.map(send => <div key={send.key} data-captured-command={send.command.clientCommandId}>
        <p role="status">{send.status === 'waiting' ? 'Waiting for confirmed run' : send.status === 'bound' ? 'Bound to confirmed run' : 'Captured tools unavailable'} · {send.command.body.text}</p>
        {send.binding && <p>Run {send.binding.run.runId}</p>}
        {send.status !== 'unavailable' && <button type="button" onClick={() => void controller.releaseCapturedSend(send.key)}>Release captured tools</button>}
      </div>)}
    </section>}
    {app.savedViewNotice && <p role="note">{app.savedViewNotice}</p>}
    {!workspaceOpen && hostAlerts}
    {selectedView === 'extensions' && !workspaceOpen && creationRecovery}
    <div className="chat-navigation" hidden={selectedView !== 'chats'}>
      <div className="action-row">
        <button disabled={!enabled || opening || app.saved.pendingCreation !== null || selected?.availability.kind !== 'ready'} onClick={() => void (catalogOnly || app.active ? controller.create(selected?.id) : startConversation(selected?.id, false))}>{selected && 'runtime' in selected && selected.runtime.engine === 'openpane-recorded' ? 'New recorded conversation' : 'New conversation'}</button>
      </div>
      {creationRecovery}
      <ConversationSearch controller={controller} connectionKey={searchConnection} enabled={enabled} active={app.active?.scope ?? null}>
      {app.catalog.items.length > 0 && <nav className="conversation-catalog" data-openpane-part="chat-directory" aria-label="Host conversations">
        {app.catalog.items.map(({ scope, preview }) => {
          const label = conversationLabel({ scope, preview });
          return <button key={scope.conversationId} disabled={!enabled}
            title={scope.conversationId} aria-label={`${label} · Open conversation ${scope.conversationId}`}
            aria-current={scope.conversationId === app.active?.scope.conversationId ? 'page' : undefined}
            onClick={() => void controller.open(scope)}>{label}</button>;
        })}
        {app.catalog.after !== null && <button disabled={!enabled} onClick={() => void controller.moreConversations()}>More conversations</button>}
      </nav>}
      {(app.savedViews.items.length > 0 || app.savedViews.after !== null) && <nav className="conversation-catalog" data-openpane-part="chat-directory" aria-label="Saved local views">
        {app.savedViews.items.map(viewId => <button key={viewId} disabled={!enabled} onClick={() => void controller.reopenView(viewId)}>Reopen saved view {viewId}</button>)}
        {app.savedViews.after !== null && <button disabled={!enabled} onClick={() => void controller.moreSavedViews()}>More saved views</button>}
      </nav>}
      </ConversationSearch>
    </div>
    {selectedView === 'settings' && <a className="settings-link" href="#connection-settings">Connection and app</a>}
  </div>;
  const views = <div className="chat-view" inert={suspended}>
      {conversation}
      {!app.active && moduleList('status')}
    </div>;
  const settings = <section className="settings-panel" aria-label="Settings" id="connection-settings">
      <h1>Settings</h1>
      <section className="settings-section"><h2>Connection</h2>
        <div className="application-status"><strong>{presentation.hostLabel}</strong><HostStatusLabel host={app.host} /></div>
        <p>{presentation.settings}</p>
        {connection.kind === 'native' && connection.controls}
        <button disabled={suspended || app.busy || Boolean(app.storageFailure)} onClick={() => connection.kind === 'native' ? connection.reconnect() : void controller.reconnect()}>Reconnect</button>
      </section>
      <section className="settings-section" aria-label="Pi and OpenCode Go"><h2>Pi and OpenCode Go</h2>
        <p>OpenPane includes a compatible Pi runtime. Your installed Pi command is separate and is not required for this chat.</p>
        <p role="status">{pi?.availability.kind === 'ready' ? 'Pi is configured for GLM 5.3 through OpenCode Go.'
          : pi?.availability.kind === 'unavailable' ? pi.availability.reason
          : 'This host does not offer Pi. Start OpenPane with ./openpane to include Pi, or ./openpane --agent pi for Pi only.'}</p>
        {pi && <><a className="settings-link" href="/setup/pi">Open secure Pi setup</a>
          <p>In the Mac app, setup opens a separate protected window. Your API key is saved in macOS Keychain. Return here and select Reconnect after setup.</p>
          <p>In a browser, reopen this host with the OpenPane Mac app to use protected setup. You can also supply OPENCODE_GO_API_KEY in the host environment.</p></>}
        <p>Pi supports text chat, saved conversations, and Stop. Tools and file access are unavailable in this integration.</p>
      </section>
      <PersonalizationSettings state={personalization} customizations={customization} namespaces={custom.namespaces} />
      <section className="settings-section"><h2>About this build</h2>{artifact}</section>
    </section>;
  // On the rail, outside the keyed conversation and outside the chats pane the shell hides while a workspace is open.
  const continuationStatus = <div id="continuation-status" className="visually-hidden" aria-live="polite" aria-atomic="true">
    {continuationAnnouncement(app.continuation, app.observation?.status.kind === 'concluded')}</div>;
  const rail = <nav className="view-rail" data-openpane-part="page-rail" aria-label="Workspace views">
    {continuationStatus}
    <button type="button" data-openpane-essential="chats" data-openpane-part="button" aria-label="Chats" title="Chats" aria-pressed={selectedView === 'chats'} onClick={() => setSelectedView('chats')}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11.5a7.5 7.5 0 0 1-7.5 7.5H5l-3 3v-9.5A7.5 7.5 0 0 1 9.5 5H12"/><path d="M16 5h6m-3-3v6"/></svg>{experience?.manifest.presentation.navigation === 'pages' && <span className="page-label">Chats</span>}
    </button>
    <button type="button" data-openpane-essential="extensions" data-openpane-part="button" aria-label="Extensions" title="Extensions" aria-pressed={selectedView === 'extensions'} onClick={() => setSelectedView('extensions')}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="7.5" height="7.5" rx="1.5"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5"/><path d="M17.25 13.5v7.5M13.5 17.25H21"/></svg>{experience?.manifest.presentation.navigation === 'pages' && <span className="page-label">Extensions</span>}
    </button>
    <button type="button" data-openpane-essential="settings" data-openpane-part="button" className="settings-view-button" aria-label="Settings" title="Settings" aria-pressed={selectedView === 'settings'} onClick={() => setSelectedView('settings')}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h4m4 0h8M4 12h8m4 0h4M4 18h2m4 0h10"/><circle cx="10" cy="6" r="2"/><circle cx="14" cy="12" r="2"/><circle cx="8" cy="18" r="2"/></svg>{experience?.manifest.presentation.navigation === 'pages' && <span className="page-label">Settings</span>}
    </button>
  </nav>;
  if (personalization.readiness === 'loading') return <ThemeScope><p role="status">Loading local preferences…</p></ThemeScope>;
  const resolvedAppearance = experience ? (experience.manifest.theme.mode === 'system' ? undefined : experience.manifest.theme.mode) : preferences.appearance === 'system' ? undefined : preferences.appearance;
  if (fixedChat) return <ThemeScope inert={suspended} variants={experience?.manifest.theme} appearance={resolvedAppearance} palette={contentPalette} className="application-chat-window" data-openpane-part="main">
    <header className="application-chat-header" data-openpane-part="page-header"><h1>{app.active?.agent.label ?? 'Opening chat'}</h1>
      <button type="button" data-openpane-essential="new-chat" disabled={!enabled || !app.active} onClick={() => void controller.create(app.active?.agent.id)}>New chat</button>
    </header>
    {personalizationNotice}{hostAlerts}{creationRecovery}{windowRecovery}
    {activeConversation ?? <section aria-label="Chat ownership"><p role="status">Waiting for this window's assigned editor.</p><button data-openpane-essential="retry-editor" type="button" onClick={() => window.location.reload()}>Retry assigned editor</button></section>}
    <footer>{app.active ? <ConversationStatus active={app.active} /> : 'No editor ready'}</footer>
  </ThemeScope>;
  return <DesktopShell experience={experience?.manifest} contentPalette={experience ? contentPalette : undefined} appearance={resolvedAppearance} onRestoreAppearance={() => { if (experience && uiActions) void uiActions.restore(); else void personalizationSession.resetAppearance(); }} navigation={rail} activeView={selectedView} protectedContent={controls} defaultView={views} settingsView={settings}
    extensionsView={extensionsView} workspaceOpen={workspaceOpen} restoreMode={children === undefined ? 'managed' : 'remount'}
    onRestore={() => { void personalizationSession.restoreDefaultView(); setSelectedView('chats'); }}
    status={app.active ? <ConversationStatus active={app.active} /> : 'No conversation open'}
    buildLabel={composerVisible && app.active ? conversationPresentation(app.active.agent, agent).footer : presentation.buildLabel}>{children}</DesktopShell>;
}
