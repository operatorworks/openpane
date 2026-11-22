# Research brief — simplify the new-conversation screen

## Request (user, 2026-11-21)
"Compared to these other platforms our new conversation screen is so busy. Please redesign it to make it simpler and remove this text box highlight when I start typing a prompt. The blinking cursor is sufficient UX. We also want to get rid of that resize handle. Add photo should be drag and drop. Custom tools should be configured elsewhere. Come up with some designs that still look like OpenPane but clean up some of the clutter on this screen. Leave the left two vertical navigation panes alone. Focus only on this new conversation screen and things that use its components."

### Current screen (screenshot, Codex conversation, dark appearance), top to bottom in the main column
1. Header: "Your conversation" (h1) and "GPT-6.2 Sol" (agent label), with a bottom border.
2. Bordered "Permissions" card: "This conversation does not report permissions." + "Refresh permissions" button (Codex returns `unsupported`).
3. "Send a message to begin." empty-state text.
4. Two empty bordered fieldsets each with legend "Custom tools" (one per bundled extension namespace: crew and coworkers, both of which contribute `modules: []`).
5. Composer (rounded, raised background) with a 2px accent ring while focused (`.composer:focus-within`), a textarea with a visible vertical resize grip, an "Add image" button row, a footer row: "Codex ⌄", "GPT-6.2 Sol ⌄", disabled "Default ⌄" (effort), "Send" pill, then disclosure "Local Codex · Approvals required for changes".
6. Shell footer strip: "● Conversation connected" (left) and "Local Codex host" (right).

### Comparators the user showed (for tone, not to copy)
- Cursor: empty chat is a centred composer with a context row above (repo / branch / machine), a single "+" button bottom-left, model picker + mic bottom-right, a few suggestion chips under it. No header, no cards.
- Claude desktop: empty state = centred mascot + small choice cards; composer pinned at bottom: "+", placeholder, mic; under it a thin row with "This computer ⌄", "Choose folder ⌄", model + effort on the right.
- ChatGPT desktop: big centred "What should we work on?", composer with "+", one access chip, model+effort on right, mic; below the composer a row of context chips (project, Files, Plugins), then suggestions.
Common thread: no page header, no bordered panels on an empty chat, a single "+" for attachments, settings collapsed into compact chips, no focus ring on the composer, no resize grip.

## Application context (reused)
A confirmed application context exists for this repository target from the extensions plan (`.agents/plans/extensions-nav-crew-coworkers/00-overview.md`, confirmed 2026-11-18T04:10:00Z): has_active_users=false, backward_compatibility_required=false, feature_flags=not-applicable. OpenPane runs for one user on a private overlay network (AGENTS.md). No pairing/attestation features may be added.

## Hard constraints
- Do not change the icon rail (`.view-rail`) or the Chats sidebar (`.application-controls`) markup/behaviour.
- Scope: the conversation panel (`ConversationView`), its composer, components it renders (permissions, modules/custom tools, image attach, agent controls) and the empty-workspace composer in `BrowserApplication.tsx` (it reuses `ComposerAgentControls` and `.composer`). The shell footer is shared by all views; changes to it are allowed only insofar as they affect this screen.
- Must remain keyboard accessible: textarea keeps an accessible name ("Message"), focus must remain discoverable for keyboard users on buttons. Removing the composer ring is an explicit user request.
- Image upload contract stays: PNG/JPEG only, `IMAGE_MAX_BYTES` (4 MB) check, `active.store.selectImage({name, bytes})`, `retryImage`, `removeImage`. Only one pending image at a time (`view.image`).
- Permission revocation for providers that report permissions (Crew) must remain reachable; Crew tests use `getByRole('region', { name: 'Permissions' })` and the button "Refresh permissions" (extensions/crew/tests/provider.test.mjs:927-944).
- Custom tool modules (`ConversationModule` from `@openpane/sdk/react`) need an active conversation context (`ConversationModuleProps`: conversation scope, activity, commands, permissions) to run actions. A content layout customization (`ConversationContentLayoutProps`) receives `modules` as a slot and may place them itself.
- Repo verification commands: `npm run check`, `npm run lint`, `npm test` (node --test incl. Playwright browser tests in tests/application/*.browser.test.mjs), `npm run build`, root `npm run verify`.

## Repository map
- `apps/desktop/src/application/ConversationView.tsx` (220 lines) — conversation panel, composer, image attach, decisions, observation notices.
- `apps/desktop/src/application/ConversationPermissions.tsx` (58) — Permissions card.
- `apps/desktop/src/application/CustomizationModules.tsx` (91) — "Custom tools" fieldset per namespace.
- `apps/desktop/src/application/CustomizationContent.tsx` (25) — default/claimed content layout; default = transcript + modules.
- `apps/desktop/src/application/ComposerAgentControls.tsx` (128) — harness/model/effort chips + picker popover.
- `apps/desktop/src/application/ExtensionsView.tsx` (188) — Extensions list (rail icon 2) with per-namespace rows (state Ready/Not configured/No view/...), and extension workspaces.
- `apps/desktop/src/shell/BrowserApplication.tsx` (179) — wires everything; empty workspace screen; `views` puts `modules` under the empty workspace when no conversation is active.
- `apps/desktop/src/shell/Shell.tsx` (101) — DesktopShell with footer status/build label.
- `apps/desktop/src/application/application.css` (299) — all styles.
- `apps/desktop/src/application/agent-presentation.ts` — per-agent `placeholder`, `footer` ("Local Codex · Approvals required for changes"), `assistant` strings.
- Tests: `tests/application/composer-image.browser.test.mjs` (uses `getByLabel('Image file').setInputFiles`, button 'Add image', 'Replace image'), `content-layout-image.browser.test.mjs`, `selective-activity.browser.test.mjs` (also `getByLabel('Image file')`), `module-actions.browser.test.mjs`, `frontend-tools.browser.test.mjs` / `journey.browser.test.mjs` / `transcript-overrides.browser.test.mjs` (assert alert text 'Custom tools could not load.'), `content-layout.browser.test.mjs`, `extensions-view.browser.test.mjs`, `extensions/coworkers/tests/desktop.browser.test.mjs`, `extensions/crew/tests/provider.test.mjs`.

## Source excerpts

### apps/desktop/src/application/ConversationView.tsx
```tsx
     1	import { canRetryObservation } from '@openpane/contracts';
     2	import type { ConversationClosure, ObservationStopReason } from '@openpane/contracts';
     3	import { IMAGE_MAX_BYTES } from '@openpane/contracts/image';
     4	import { useEffect, useRef, useState, type ReactNode } from 'react';
     5	import { useConversation } from '@openpane/client/react';
     6	import type { ConversationActions, ConversationContinuation, OpenConversation, ConversationObservation, PermissionState } from './application-controller.js';
     7	import { ContinuationChoices, ContinuationHistory } from './ContinuationNotice.js';
     8	import { ConversationPermissions } from './ConversationPermissions.js';
     9	import { CommandRecovery } from './CommandRecovery.js';
    10	import { recoveryModel } from './recovery.js';
    11	import { AGENT_PRESENTATION, agentPresentation } from './agent-presentation.js';
    12	import { conversationResponding } from './responding.js';
    13	import { FileActivity } from './FileActivity.js';
    14	import { CommandActivity } from './CommandActivity.js';
    15	import { AssistantReply } from './AssistantReply.js';
    16	import { CustomizationActivity, CustomizationTranscript, type ActivitySelection, type ContentLayoutSelection, type TranscriptSelection } from './DesktopCustomizations.js';
    17	import { CustomizationContent } from './CustomizationContent.js';
    18	import { ImageAttachmentCard, imageSize } from './ImageAttachmentCard.js';
    19	
    20	const OBSERVATION_NOTICE: Record<ObservationStopReason, string> = {
    21	  'unsupported': 'This provider does not support live updates.',
    22	  'snapshot-unavailable': 'The provider could not refresh this conversation.',
    23	  'invalid-projection': 'The provider’s saved state or updates could not be validated.',
    24	  'recovery-failed': 'The provider could not resume updates.',
    25	  'retry-exhausted': 'Updates stopped after repeated gaps without progress.',
    26	  'provider-disconnected': 'The provider stopped delivering updates.',
    27	  'original-provider-unavailable': 'Restore this conversation’s original provider configuration to resume updates.',
    28	  'original-credentials-unavailable': 'Restore this conversation’s original provider credentials to resume updates.',
    29	  'original-binding-unavailable': 'This conversation’s original provider binding is unavailable. Restore its original configuration.',
    30	  'cleanup-failed': 'The previous observer could not close safely. Restart the host before resuming updates.',
    31	};
    32	const CLOSURE_NOTICE: Record<ConversationClosure, string> = {
    33	  cancelled: 'it was stopped',
    34	  failed: 'the provider reported a failure',
    35	  exhausted: 'it reached its turn limit',
    36	};
    37	
    38	type DraftEditor =
    39	  | { readonly kind: 'saved' | 'saving'; readonly text: string }
    40	  | { readonly kind: 'failed'; readonly text: string; readonly message: string };
    41	
    42	export function ConversationStatus({ active }: { readonly active: OpenConversation }) {
    43	  const view = useConversation(active.store);
    44	  return <span role="status">Conversation {view.connection.kind}{'reason' in view.connection ? ` · ${view.connection.reason}` : ''}</span>;
    45	}
    46	
    47	export function ConversationView({ actions, active, enabled, storageFailure, observation = null, continuation = null, permissionState, agent = 'recorded', composerControls, transcript = { kind: 'default' }, activity = { kind: 'default' }, contentLayout = { kind: 'default' }, modules = null }: {
    48	  readonly actions: ConversationActions; readonly active: OpenConversation; readonly enabled: boolean; readonly storageFailure: string; readonly agent?: keyof typeof AGENT_PRESENTATION;
    49	  readonly permissionState?: PermissionState;
    50	  readonly observation?: ConversationObservation | null;
    51	  readonly continuation?: ConversationContinuation | null;
    52	  readonly transcript?: TranscriptSelection;
    53	  readonly activity?: ActivitySelection;
    54	  readonly contentLayout?: ContentLayoutSelection;
    55	  readonly modules?: ReactNode;
    56	  readonly composerControls?: (canSwitch: boolean) => ReactNode;
    57	}) {
    58	  const presentation = 'kind' in active.agent ? agentPresentation(active.agent).presentation : AGENT_PRESENTATION[agent];
    59	  const view = useConversation(active.store);
    60	  const [editor, setEditor] = useState<DraftEditor>({ kind: 'saved', text: view.draft });
    61	  const editVersion = useRef(0);
    62	  const stopGuard = useRef<{ readonly store: OpenConversation['store']; readonly runId: string } | null>(null);
    63	  const approvalGuards = useRef(new Map<OpenConversation['store'], Set<string>>());
    64	  const [approving, setApproving] = useState<ReadonlySet<string>>(new Set());
    65	  const [stopPending, setStopPending] = useState<typeof stopGuard.current>(null);
    66	  const imageInput = useRef<HTMLInputElement>(null);
    67	  const composer = useRef<HTMLTextAreaElement>(null);
    68	  const arrived = continuation?.arrived ?? null;
    69	  useEffect(() => {
    70	    // The click that led here removed its own control; focus the user moved elsewhere is left alone.
    71	    if (arrived && (document.activeElement === null || document.activeElement === document.body)) composer.current?.focus();
    72	  }, [arrived]);
    73	  const [imageError, setImageError] = useState<{ readonly store: OpenConversation['store']; readonly message: string } | null>(null);
    74	  useEffect(() => {
    75	    setEditor(previous => previous.kind === 'saved' && previous.text !== view.draft ? { kind: 'saved', text: view.draft } : previous);
    76	  }, [view.draft]);
    77	  async function edit(value: string): Promise<void> {
    78	    const version = ++editVersion.current;
    79	    setEditor({ kind: 'saving', text: value });
    80	    try {
    81	      await active.store.setDraft(value);
    82	      if (version === editVersion.current) setEditor({ kind: 'saved', text: active.store.getSnapshot().draft });
    83	    } catch (error) {
    84	      if (version === editVersion.current) setEditor({ kind: 'failed', text: value,
    85	        message: error instanceof Error ? error.message : 'Your draft could not be saved.' });
    86	    }
    87	  }
    88	  const observationStatus = observation?.status;
    89	  const paused = observationStatus?.kind === 'stopped';
    90	  const concluded = observationStatus?.kind === 'concluded';
    91	  const available = active.agent.availability.kind === 'ready';
    92	  const connected = enabled && available && view.connection.kind === 'connected';
    93	  const live = presentation.live;
    94	  const run = live ? view.document.domain.currentRun : null;
    95	  const responding = conversationResponding(agent, view.document.domain);
    96	  const retainedCancel = run && view.outbox.some(entry => entry.command.body.kind === 'cancel' && entry.command.body.runId === run.runId);
    97	  const stopping = run?.kind === 'stopping' || Boolean(retainedCancel) ||
    98	    (stopPending?.store === active.store && stopPending.runId === run?.runId);
    99	  function stop(): void {
   100	    if (!connected || !active.agent.commands.includes('cancel') || run?.kind !== 'running' || stopping ||
   101	      (stopGuard.current?.store === active.store && stopGuard.current.runId === run.runId)) return;
   102	    const target = { store: active.store, runId: run.runId };
   103	    stopGuard.current = target;
   104	    setStopPending(target);
   105	    void actions.submit(() => target.store.cancel(target.runId)).finally(() => {
   106	      if (stopGuard.current === target) {
   107	        stopGuard.current = null;
   108	        setStopPending(null);
   109	      }
   110	    });
   111	  }
   112	  function approve(pendingId: string, choiceId: string): void {
   113	    const store = active.store, decision = store.getSnapshot().document.decisions[pendingId];
   114	    const guards = approvalGuards.current.get(store) ?? new Set<string>();
   115	    if (!connected || !active.agent.commands.includes('approve') || !decision || decision.reserved || guards.has(pendingId)) return;
   116	    guards.add(pendingId);
   117	    approvalGuards.current.set(store, guards);
   118	    setApproving(new Set(guards));
   119	    void actions.submit(() => store.approve(pendingId, choiceId)).finally(() => {
   120	      guards.delete(pendingId);
   121	      setApproving(new Set(guards));
   122	    });
   123	  }
   124	  const image = view.image;
   125	  const acceptsImages = active.agent.imageInput.kind === 'supported' && active.agent.commands.includes('send');
   126	  const canSend = connected && !concluded && active.agent.commands.includes('send') && !responding && editor.kind === 'saved' &&
   127	    (image ? image.status === 'ready' && acceptsImages : Boolean(editor.text.trim()));
   128	  const sentImages = view.document.domain.messages.flatMap(message => message.image ? [{ messageId: message.messageId, image: message.image }] : []);
   129	  function imageAction(operation: () => Promise<void>): void {
   130	    const store = active.store;
   131	    setImageError(null);
   132	    void operation().catch((error: unknown) => setImageError({ store, message: error instanceof Error ? error.message : 'The image could not be changed.' }));
   133	  }
   134	  const conversationKey = `${active.viewId}/${active.scope.hostId}/${active.scope.conversationId}`;
   135	  const context = { conversation: active.scope, activity: view.document, commands: actions.commands, permissions: actions.permissions };
   136	  const nativeMessages = <>
   137	      {view.document.domain.messages.length === 0 && <p className="empty-state">{agent === 'recorded' ? 'Send a message to begin this recorded demonstration.' : 'Send a message to begin.'}</p>}
   138	      {view.document.domain.messages.map(message => <article className={`message message-${message.role}`} key={message.messageId}>
   139	        <strong>{message.role === 'user' ? 'You' : presentation.assistant}</strong>
   140	        {message.role === 'assistant' ? <AssistantReply text={message.text} /> : message.text && <p>{message.text}</p>}
   141	        {message.image && <ImageAttachmentCard attachment={message.image} read={actions.readImage} />}
   142	        {!message.complete && <span className="progress-label">{concluded ? 'Did not finish' : paused ? 'Updates paused' : agent === 'recorded' ? 'Recorded response in progress…' : 'Responding…'}</span>}
   143	      </article>)}
   144	    </>;
   145	  const nativeActivity = <>
   146	      <CommandActivity transcript={view.document.domain} connected={view.connection.kind === 'connected'} paused={paused} />
   147	      <FileActivity transcript={view.document.domain} connected={view.connection.kind === 'connected'} paused={paused} />
   148	    </>;
   149	  const nativeTranscript = <div className="transcript" aria-label="Messages" aria-live="polite">{nativeMessages}{nativeActivity}</div>;
   150	  const selectiveTranscript = <div className="transcript" aria-label="Messages" aria-live="polite">{nativeMessages}
   151	    <CustomizationActivity selection={activity} conversationKey={conversationKey} fallback={nativeActivity}
   152	      context={{ ...context, updates: paused ? 'paused' : view.connection.kind === 'connected' ? 'connected' : 'reconnecting' }} />
   153	  </div>;
   154	
   155	  return <section className="conversation-panel" aria-label="Conversation">
   156	    <header><p className="eyebrow">{agent === 'recorded' ? 'RECORDED CONVERSATION' : 'CONVERSATION'}</p><h1>Your conversation</h1><p className="agent-label">{active.agent.label}</p><p className="scope-label">{active.scope.conversationId}</p></header>
   157	    {active.agent.availability.kind === 'unavailable' && <p role="status">{active.agent.availability.reason} Saved history remains available.</p>}
   158	    {observationStatus?.kind === 'unknown' && <p role="status">Observation status unavailable. Reconnect to check for updates.</p>}
   159	    {observationStatus?.kind === 'recovering' && <p role="status">Resuming provider updates…</p>}
   160	    {observationStatus?.kind === 'stopped' && <div role="status" className="observation-notice">
   161	      <p>Updates paused. {OBSERVATION_NOTICE[observationStatus.reason]} Saved messages and your draft remain available.{run && run.kind !== 'ended' ? ' The provider may still be running.' : ''}</p>
   162	      {canRetryObservation(observationStatus) && <>
   163	        <p>Checking for updates does not restart this request or resend commands.</p>
   164	        <button type="button" disabled={!enabled || observation?.retrying}
   165	          onClick={() => void actions.retryObservation()}>{observation?.retrying ? 'Checking for updates…' : 'Check for updates'}</button>
   166	      </>}
   167	    </div>}
   168	    {observationStatus?.kind === 'concluded' && <div role="status" className="observation-notice">
   169	      <p>This conversation ended: {CLOSURE_NOTICE[observationStatus.cause]}. Earlier messages and your draft stay available.</p>
   170	      {continuation && <ContinuationChoices continuation={continuation} actions={actions} enabled={enabled && available} />}
   171	    </div>}
   172	    {permissionState && <ConversationPermissions retained={recoveryModel(view).retained} state={permissionState} actions={actions} enabled={connected} />}
   173	    <CustomizationContent before={continuation && <ContinuationHistory continuation={continuation} actions={actions} enabled={enabled} assistant={presentation.assistant} />}
   174	      selection={contentLayout} conversationKey={conversationKey} modules={modules} nativeTranscript={nativeTranscript}
   175	      transcript={<CustomizationTranscript selection={transcript} conversationKey={conversationKey}
   176	        context={context}
   177	        fallback={transcript.kind === 'claimed' ? nativeTranscript : selectiveTranscript}
   178	        appendix={sentImages.length > 0 && <section className="sent-images" aria-label="Sent images">
   179	          <h2>Sent images</h2>{sentImages.map(sent => <ImageAttachmentCard key={sent.messageId} attachment={sent.image} read={actions.readImage} />)}
   180	        </section>} />} />
   181	    {Object.values(view.document.decisions).map(decision => <section className="decision-card" key={decision.pendingId} aria-label="Approval required">
   182	      <h2>Approval required</h2><p>{decision.prompt}</p><div className="action-row">
   183	        {decision.choices.map(choice => <button key={choice} disabled={!connected || !active.agent.commands.includes('approve') || decision.reserved || approving.has(decision.pendingId)} onClick={() => approve(decision.pendingId, choice)}>{decision.choiceLabels?.[choice] ?? (agent === 'codex' && choice === 'accept' ? 'Allow' : agent === 'codex' && choice === 'decline' ? 'Deny' : choice)}</button>)}
   184	      </div>
   185	    </section>)}
   186	    <form className="composer" onSubmit={event => { event.preventDefault(); if (canSend) void actions.submit(() => active.store.send()); }}>
   187	      <label htmlFor="message">Message</label>
   188	      <textarea ref={composer} id="message" value={editor.text} onChange={event => void edit(event.target.value)} readOnly={Boolean(storageFailure)} placeholder={presentation.placeholder} rows={3} />
   189	      {editor.kind === 'failed' && <p role={storageFailure ? 'note' : 'alert'}>Draft not saved. {storageFailure ? 'Copy your text before reloading.' : editor.message}</p>}
   190	      {(image || acceptsImages) && <div className="composer-attachments">
   191	        {image && <div className="composer-image" aria-label="Attached image">
   192	          <span>{image.name} · {imageSize(image.byteLength)}</span>
   193	          <span role="status">{image.status === 'uploading' ? 'Uploading…' : image.status === 'ready' ? 'Ready' : image.status === 'interrupted' ? 'Upload interrupted' : image.reason}</span>
   194	          {(image.status === 'failed' || image.status === 'interrupted') && <button type="button" disabled={!enabled}
   195	            onClick={() => imageAction(() => active.store.retryImage())}>Retry</button>}
   196	          <button type="button" disabled={Boolean(storageFailure)} onClick={() => imageAction(() => active.store.removeImage())}>Remove</button>
   197	        </div>}
   198	        {image && !acceptsImages && <span>{active.agent.imageInput.kind === 'unsupported' ? active.agent.imageInput.reason : 'This agent cannot receive images.'} Remove the image to send.</span>}
   199	        {acceptsImages && <>
   200	          <input ref={imageInput} type="file" accept="image/png,image/jpeg" aria-label="Image file" hidden onChange={event => {
   201	            const file = event.target.files?.[0];
   202	            event.target.value = '';
   203	            if (file) imageAction(async () => {
   204	              if (file.size > IMAGE_MAX_BYTES) throw new Error('Choose an image of at most 4 MB.');
   205	              await active.store.selectImage({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
   206	            });
   207	          }} />
   208	          <button type="button" disabled={!enabled || Boolean(storageFailure) || image?.status === 'uploading'}
   209	            onClick={() => imageInput.current?.click()}>{image ? 'Replace image' : 'Add image'}</button>
   210	        </>}
   211	        {imageError?.store === active.store && <p role="alert">{imageError.message}</p>}
   212	      </div>}
   213	      <div className="composer-footer">{composerControls?.(enabled && editor.kind === 'saved' && !responding)}<div className="composer-send-actions"><button disabled={!canSend}>Send</button>
   214	        {run && run.kind !== 'ended' && !concluded && <button type="button" disabled={!connected || !active.agent.commands.includes('cancel') || stopping} onClick={stop}>{stopping ? 'Stopping…' : 'Stop'}</button>}</div>
   215	      <p className="composer-disclosure">{presentation.footer}</p>
   216	      </div>
   217	    </form>
   218	    <CommandRecovery view={view} actions={actions} enabled={enabled} canRetry={available} retry={id => active.store.retry(id)} />
   219	  </section>;
   220	}
```

### apps/desktop/src/application/ConversationPermissions.tsx
```tsx
     1	import { useEffect, useState } from 'react';
     2	import type { OutboxEntry } from '@openpane/client';
     3	import type { ConversationPermission } from '@openpane/contracts';
     4	import type { ConversationActions, PermissionState } from './application-controller.js';
     5	
     6	export function ConversationPermissions({ state, actions, enabled, retained }: {
     7	  readonly retained: readonly OutboxEntry[];
     8	  readonly state: PermissionState; readonly actions: ConversationActions; readonly enabled: boolean;
     9	}) {
    10	  const [confirming, setConfirming] = useState<ConversationPermission | null>(null);
    11	  const [error, setError] = useState('');
    12	  const listing = 'listing' in state ? state.listing : null;
    13	  const fresh = enabled && state.kind === 'fresh';
    14	  const unresolved = new Set(retained.flatMap(entry => entry.command.body.kind === 'revoke-permission' ? [entry.command.body.permissionId] : []));
    15	  useEffect(() => {
    16	    const refresh = () => { if (enabled) void actions.permissions.read().catch(() => {}); };
    17	    window.addEventListener('focus', refresh);
    18	    return () => window.removeEventListener('focus', refresh);
    19	  }, [actions, enabled]);
    20	  async function revoke(permission: ConversationPermission) {
    21	    setConfirming(null);
    22	    setError('');
    23	    try { await actions.commands.revokePermission(permission.permissionId, permission.scope); }
    24	    catch (cause) { setError(cause instanceof Error ? cause.message : 'Revocation failed. Refresh permissions.'); }
    25	  }
    26	  function refresh() {
    27	    setConfirming(null);
    28	    setError('');
    29	    void actions.permissions.read().catch(() => {});
    30	  }
    31	  return <section aria-label="Permissions" className="permissions-panel" onFocus={event => {
    32	    if (!event.currentTarget.contains(event.relatedTarget) && enabled && state.kind === 'stale') refresh();
    33	  }}>
    34	    <h2>Permissions</h2>
    35	    {state.kind !== 'fresh' && <p role="status">{state.reason}</p>}
    36	    {listing && <>
    37	      <p>Last checked <time dateTime={listing.observedAt}>{new Date(listing.observedAt).toLocaleString()}</time>{state.kind !== 'fresh' ? ' · Refresh required' : ''}</p>
    38	      {listing.permissions.length === 0 && <p>No active work-item permissions were found.</p>}
    39	      {listing.permissions.map(permission => <div key={permission.permissionId}>
    40	        <h3>{permission.actionLabel} · {permission.scope === 'agent' ? 'All conversations for this member' : 'This conversation'}</h3>
    41	        <p>{permission.detail}</p>
    42	        {unresolved.has(permission.permissionId) && <p>The earlier revoke acknowledgement is unknown. Revoke again sends a new command. Its result leaves the earlier acknowledgement unknown.</p>}
    43	        <button type="button" disabled={!fresh} onClick={() => permission.scope === 'agent' ? setConfirming(permission) : void revoke(permission)}>
    44	          {unresolved.has(permission.permissionId) ? 'Revoke again' : permission.scope === 'agent' ? 'Revoke for this member in all conversations' : 'Revoke for this conversation'}
    45	        </button>
    46	      </div>)}
    47	      {listing.permissions.length > 0 && <p>These permissions cover future owner-initiated work items, including different notes. Changing the model or profile keeps them. Revocation applies to later proposals. Already-approved work may finish. Any remaining member permission still applies across conversations.</p>}
    48	    </>}
    49	    {confirming && fresh && listing?.permissions.some(row => row.permissionId === confirming.permissionId && row.scope === 'agent') &&
    50	      <div role="group" aria-label="Confirm all-conversations revocation">
    51	        <p>Revoke this member’s work-item permission in all conversations? Already-approved work may finish.</p>
    52	        <button type="button" onClick={() => void revoke(confirming)}>Confirm revoke in all conversations</button>
    53	        <button type="button" onClick={() => setConfirming(null)}>Keep permission</button>
    54	      </div>}
    55	    {error && <p role="alert">{error}</p>}
    56	    <button type="button" disabled={!enabled || state.kind === 'loading'} onClick={refresh}>Refresh permissions</button>
    57	  </section>;
    58	}
```

### apps/desktop/src/application/CustomizationModules.tsx
```tsx
     1	import { Suspense, useEffect, useRef, useState } from 'react';
     2	import { useConversation } from '@openpane/client/react';
     3	import type { ConversationModule, ConversationModuleProps, ModuleAction } from '@openpane/sdk/react';
     4	import type { SubmitResult } from '@openpane/contracts';
     5	import { Button } from '@openpane/ui-primitives/desktop';
     6	import { refusalMessage } from './application-controller.js';
     7	import type { ConversationActions, OpenConversation } from './application-controller.js';
     8	import { conversationResponding } from './responding.js';
     9	import { CustomizationBoundary, customizationMessage as message, type NamespaceActivation } from './DesktopCustomizations.js';
    10	
    11	function actionOutcome(result: SubmitResult): string {
    12	  if (result.kind === 'rejected') return `Submission rejected. ${refusalMessage(result.reason)}`;
    13	  const state = result.receipt.state;
    14	  switch (state.kind) {
    15	    case 'pending': return 'Submission pending. Follow its progress in the conversation.';
    16	    case 'accepted': return 'Submitted. Follow the response in the conversation.';
    17	    case 'completed': return 'Command completed. Follow the response in the conversation.';
    18	    case 'rejected': return `Submission rejected. ${state.reason}`;
    19	    case 'not-dispatched': return `Not dispatched. ${state.reason}`;
    20	    case 'uncertain': return `Submission uncertain. ${state.reason} Use the conversation recovery controls before trying again.`;
    21	    case 'abandoned': return 'Stopped waiting. Whether this command ran is unknown.';
    22	    default: { const exhaustive: never = state; return exhaustive; }
    23	  }
    24	}
    25	
    26	function ConversationModuleAction({ action, context }: { readonly action: ModuleAction; readonly context: ConversationModuleProps }) {
    27	  const owner = useRef({ mounted: true, pending: false });
    28	  const [state, setState] = useState<{ readonly kind: 'idle' | 'pending' } | { readonly kind: 'settled'; readonly message: string }>({ kind: 'idle' });
    29	  useEffect(() => {
    30	    const current = owner.current;
    31	    current.mounted = true;
    32	    return () => { current.mounted = false; };
    33	  }, []);
    34	  async function run() {
    35	    const current = owner.current;
    36	    if (current.pending) return;
    37	    current.pending = true;
    38	    setState({ kind: 'pending' });
    39	    try {
    40	      const result = await action.run(context);
    41	      if (current.mounted) setState({ kind: 'settled', message: actionOutcome(result) });
    42	    } catch (error) {
    43	      if (current.mounted) setState({ kind: 'settled', message: `Action failed. ${message(error)} Check conversation recovery before trying again.` });
    44	    } finally {
    45	      current.pending = false;
    46	    }
    47	  }
    48	  return <div>
    49	    <Button disabled={state.kind === 'pending'} aria-busy={state.kind === 'pending'} onClick={() => void run()}>{action.label}</Button>
    50	    <p role="status" aria-label={`${action.label} status`}>{state.kind === 'pending' ? 'Submitting…' : state.kind === 'settled' ? state.message : ''}</p>
    51	  </div>;
    52	}
    53	
    54	function ConversationModuleView({ module, context }: { readonly module: ConversationModule; readonly context: ConversationModuleProps }) {
    55	  const View = module.component;
    56	  return <section aria-label={module.label}>
    57	    <View {...context} />
    58	    {module.actions?.map(action => <ConversationModuleAction key={action.id} action={action} context={context} />)}
    59	    {module.children?.map(child => <ConversationModuleView key={child.id} module={child} context={context} />)}
    60	  </section>;
    61	}
    62	
    63	function ConversationModules({ modules, active, actions, enabled, agent }: {
    64	  readonly modules: readonly ConversationModule[]; readonly active: OpenConversation; readonly actions: ConversationActions;
    65	  readonly enabled: boolean; readonly agent: string;
    66	}) {
    67	  const view = useConversation(active.store);
    68	  const context: ConversationModuleProps = { conversation: active.scope, activity: view.document, commands: actions.commands, permissions: actions.permissions };
    69	  const available = enabled && active.agent.availability.kind === 'ready' && active.agent.commands.includes('send') && view.connection.kind === 'connected' && !conversationResponding(agent, view.document.domain);
    70	  return <fieldset disabled={!available} className="customization-modules">
    71	    <legend>Custom tools</legend>
    72	    {!available && <p>Available when this conversation is connected and ready.</p>}
    73	    {modules.map(module => <ConversationModuleView key={module.id} module={module} context={context} />)}
    74	  </fieldset>;
    75	}
    76	
    77	export function CustomizationModules({ owner, active, actions, enabled, agent }: {
    78	  readonly owner: NamespaceActivation; readonly active: OpenConversation | null;
    79	  readonly actions: ConversationActions | null; readonly enabled: boolean; readonly agent: string;
    80	}) {
    81	  return <aside className="customization-panel" aria-label={`Customization ${owner.namespace}`}
    82	    data-customization-namespace={owner.namespace} data-customization-state={owner.kind}>
    83	    {owner.kind === 'loading' && <p role="status">Loading custom tools…</p>}
    84	    {owner.kind === 'failed' && <p role="alert">Custom tools could not load. {owner.message} Use Restore default view to continue without them.</p>}
    85	    {owner.kind === 'ready' && active && actions && <Suspense fallback={<p role="status">Loading custom tools…</p>}>
    86	      <CustomizationBoundary key={`${owner.lifetime}/${active.viewId}/${active.scope.hostId}/${active.scope.conversationId}`} fail={owner.fail} fallback={null}>
    87	        <ConversationModules modules={owner.presentation.modules} active={active} actions={actions} enabled={enabled} agent={agent} />
    88	      </CustomizationBoundary>
    89	    </Suspense>}
    90	  </aside>;
    91	}
```

### apps/desktop/src/application/CustomizationContent.tsx
```tsx
     1	import { Suspense, type ReactNode } from 'react';
     2	import type { ConversationContentLayoutProps } from '@openpane/sdk/react';
     3	import { CustomizationBoundary, type ContentLayoutSelection } from './DesktopCustomizations.js';
     4	
     5	export function CustomizationContent({ selection, conversationKey, transcript, nativeTranscript, modules, before = null }: ConversationContentLayoutProps & {
     6	  readonly selection: ContentLayoutSelection;
     7	  readonly conversationKey: string;
     8	  readonly nativeTranscript: ReactNode;
     9	  /** Shown first inside the same scroll area, outside any claimed layout. */
    10	  readonly before?: ReactNode;
    11	}) {
    12	  const fallback = <>{transcript}{modules}</>;
    13	  let content = fallback;
    14	  if (selection.kind === 'conflict') {
    15	    content = <><p role="alert">Content layout conflict. {selection.namespaces.join(', ')} claim the layout. The default arrangement remains active.</p>{fallback}</>;
    16	  } else if (selection.kind === 'claimed') {
    17	    const Layout = selection.owner.presentation.contentLayout;
    18	    content = <Suspense fallback={<><p role="status">Content layout is loading. Module actions will return when it is ready.</p>{nativeTranscript}</>}>
    19	      <CustomizationBoundary key={`${selection.owner.lifetime}/${conversationKey}`} fail={selection.owner.fail} fallback={nativeTranscript}>
    20	        <Layout transcript={transcript} modules={modules} />
    21	      </CustomizationBoundary>
    22	    </Suspense>;
    23	  }
    24	  return <div className="conversation-content">{before}{content}</div>;
    25	}
```

### apps/desktop/src/application/ComposerAgentControls.tsx (lines 36-100)
```tsx
    36	export function ComposerAgentControls({ agents, agent, hasConversation, enabled, onStartConversation, onSetupPi }: {
    37	  readonly agents: readonly AgentDescriptor[];
    38	  readonly agent: AgentDescriptor | null;
    39	  readonly hasConversation: boolean;
    40	  readonly enabled: boolean;
    41	  readonly onStartConversation: (agentId: string) => void;
    42	  readonly onSetupPi?: () => void;
    43	}) {
    44	  const [picker, setPicker] = useState<Picker>({ kind: 'closed' });
    45	  const root = useRef<HTMLDivElement>(null);
    46	  const dialog = useRef<HTMLDivElement>(null);
    47	  const trigger = useRef<HTMLButtonElement | null>(null);
    48	  const id = useId();
    49	  const currentHarness = harness(agent);
    50	  const currentModel = model(agent);
    51	  const selectedHarness = picker.kind === 'model' ? picker.harness : currentHarness;
    52	  const nativeCodexModels = agents.some(entry => 'runtime' in entry && entry.runtime.engine === 'codex' && entry.model);
    53	  const listedModels = agents.filter(entry => !('runtime' in entry) ||
    54	    (entry.runtime.engine !== 'codex' || entry.model) && (entry.runtime.engine !== 'codex-sdk' || !nativeCodexModels));
    55	  const modelChoices = agent && currentHarness !== 'codex' && !agents.some(entry => entry.id === agent.id) ? [agent, ...listedModels] : listedModels;
    56	  const selectedModelId = agent && 'runtime' in agent ? agent.model?.id : undefined;
    57	  const selectedChoiceId = agent && 'runtime' in agent && agent.runtime.engine === 'codex-sdk' && nativeCodexModels && selectedModelId !== undefined
    58	    ? listedModels.find(entry => 'runtime' in entry && entry.runtime.engine === 'codex' && entry.model?.id === selectedModelId)?.id ?? agent.id
    59	    : agent?.id;
    60	  const open = enabled && picker.kind !== 'closed';
    61	  const groups: readonly Harness[] = ['pi', 'claude', 'codex', ...(['recorded', 'provider', 'other'] satisfies Harness[]).filter(kind => agents.some(entry => harness(entry) === kind) || Boolean(agent && currentHarness === kind))];
    62	  function close(restoreFocus = false): void {
    63	    setPicker({ kind: 'closed' });
    64	    if (restoreFocus) trigger.current?.focus();
    65	  }
    66	  useEffect(() => {
    67	    if (!open) return;
    68	    dialog.current?.focus();
    69	    const outside = (event: PointerEvent) => {
    70	      if (event.target instanceof Node && !root.current?.contains(event.target)) setPicker({ kind: 'closed' });
    71	    };
    72	    const escape = (event: KeyboardEvent) => {
    73	      if (event.key !== 'Escape') return;
    74	      event.preventDefault();
    75	      setPicker({ kind: 'closed' });
    76	      trigger.current?.focus();
    77	    };
    78	    document.addEventListener('pointerdown', outside);
    79	    document.addEventListener('keydown', escape);
    80	    return () => {
    81	      document.removeEventListener('pointerdown', outside);
    82	      document.removeEventListener('keydown', escape);
    83	    };
    84	  }, [open, picker.kind]);
    85	  useEffect(() => { if (!enabled) setPicker({ kind: 'closed' }); }, [enabled]);
    86	  return <div className="composer-agent-controls" ref={root} role="group" aria-label="Chat settings" onBlur={event => {
    87	    if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) close();
    88	  }}>
    89	    <button type="button" className="composer-setting" aria-label={`Harness, ${agent ? harnessLabels[currentHarness] : 'Select harness'}`} aria-expanded={open && picker.kind === 'harness'} aria-controls={id} aria-haspopup="dialog" disabled={!enabled} onClick={event => {
    90	      trigger.current = event.currentTarget;
    91	      setPicker(previous => previous.kind === 'harness' ? { kind: 'closed' } : { kind: 'harness' });
    92	    }}>{agent ? harnessLabels[currentHarness] : 'Harness'}<Chevron /></button>
    93	    <button type="button" className="composer-setting" aria-label={`Model, ${currentModel}`} aria-expanded={open && picker.kind === 'model'} aria-controls={id} aria-haspopup="dialog" disabled={!enabled || !agent} onClick={event => {
    94	      trigger.current = event.currentTarget;
    95	      setPicker(previous => previous.kind === 'model' ? { kind: 'closed' } : { kind: 'model', harness: currentHarness });
    96	    }}>{currentModel}<Chevron /></button>
    97	    <button type="button" className="composer-setting composer-effort" aria-label="Effort, Default. Managed by the host." title="Effort is managed by the host. This host does not offer effort settings." disabled>Default<Chevron /></button>
    98	    {open && <div id={id} ref={dialog} className="composer-picker" role="dialog" aria-label={picker.kind === 'harness' ? 'Choose harness' : 'Choose model'} tabIndex={-1}>
    99	      <div className="composer-picker-heading"><strong>{picker.kind === 'harness' ? 'Harness' : 'Select model'}</strong><button type="button" aria-label="Close chat settings" onClick={() => close(true)}>×</button></div>
   100	      {picker.kind === 'harness' && <p>{hasConversation ? 'Choosing a different harness starts a new chat. Your draft stays here.' : 'Choose a harness to start a new chat.'}</p>}
```

### apps/desktop/src/application/agent-presentation.ts
```ts
     1	import { CLAUDE_SDK_CHAT_LABELS, CLAUDE_SDK_RUNTIMES, CODEX_SDK_CHAT_LABEL, PI_CHAT_LABEL } from '@openpane/contracts/compatibility';
     2	import type { AgentDescriptor } from '@openpane/contracts/service';
     3	import type { NativeRuntimeIdentity } from '@openpane/contracts/compatibility';
     4	
     5	const savedConversations = 'The local host manages your saved conversations and approvals.';
     6	export const AGENT_PRESENTATION = {
     7	  codex: {
     8	    assistant: 'Codex', placeholder: 'Write to Codex…', footer: 'Local Codex · Approvals required for changes',
     9	    live: true, hostLabel: 'Codex', buildLabel: 'Local Codex host', settings: savedConversations,
    10	  },
    11	  'codex-sdk': {
    12	    assistant: 'Codex', placeholder: 'Write to Codex…', footer: `${CODEX_SDK_CHAT_LABEL} · Read-only · No interactive approvals`,
    13	    live: true, hostLabel: CODEX_SDK_CHAT_LABEL, buildLabel: CODEX_SDK_CHAT_LABEL,
    14	    settings: 'The local host saves your conversations. Codex uses your ChatGPT subscription. Interactive approvals are unavailable in this mode.',
    15	  },
    16	  'claude-sdk-opus': {
    17	    assistant: 'Claude', placeholder: 'Write to Claude…', footer: `${CLAUDE_SDK_CHAT_LABELS.opus} · Chat only · No tools`,
    18	    live: true, hostLabel: CLAUDE_SDK_CHAT_LABELS.opus, buildLabel: CLAUDE_SDK_CHAT_LABELS.opus,
    19	    settings: 'The local host saves your conversations. Claude Opus uses the API key configured on your host and provides text chat without tools.',
    20	  },
    21	  'claude-sdk-sonnet': {
    22	    assistant: 'Claude', placeholder: 'Write to Claude…', footer: `${CLAUDE_SDK_CHAT_LABELS.sonnet} · Chat only · No tools`,
    23	    live: true, hostLabel: CLAUDE_SDK_CHAT_LABELS.sonnet, buildLabel: CLAUDE_SDK_CHAT_LABELS.sonnet,
    24	    settings: 'The local host saves your conversations. Claude Sonnet uses the API key configured on your host and provides text chat without tools.',
    25	  },
    26	  pi: {
    27	    assistant: 'Pi', placeholder: 'Write to Pi…', footer: `${PI_CHAT_LABEL} · Chat only · No tools`,
    28	    live: true, hostLabel: PI_CHAT_LABEL, buildLabel: PI_CHAT_LABEL,
    29	    settings: 'The local host saves your conversations. Pi provides text chat without tools.',
    30	  },
    31	  recorded: {
    32	    assistant: 'Recorded assistant', placeholder: 'Write to the recorded assistant…', footer: 'Recorded playback · No live model',
    33	    live: false, hostLabel: 'Browser development · Recorded playback', buildLabel: 'Browser development · Recorded host', settings: savedConversations,
    34	  },
    35	  provider: {
    36	    assistant: 'Provider', placeholder: 'Write to your provider…', footer: 'Provider conversation · Saved by your host',
    37	    live: true, hostLabel: 'Provider', buildLabel: 'Provider',
    38	    settings: 'Your host saves this provider conversation and its responses.',
    39	  },
    40	  local: {
    41	    assistant: 'Assistant', placeholder: 'Write a message…', footer: 'Local agent',
    42	    live: false, hostLabel: 'Local agent', buildLabel: 'Local host', settings: savedConversations,
    43	  },
    44	};
    45	export type Agent = keyof typeof AGENT_PRESENTATION;
    46	
    47	export function agentPresentation(runtime: NativeRuntimeIdentity | Extract<AgentDescriptor, { kind: 'provider' }> | null) {
    48	  if (runtime && 'kind' in runtime) return { agent: 'provider' as const, presentation: {
    49	    ...AGENT_PRESENTATION.provider, assistant: runtime.label, hostLabel: runtime.label,
    50	    buildLabel: runtime.label,
    51	    ...(!runtime.commands.includes('send') ? { placeholder: 'Messaging is not available for this provider',
    52	      footer: 'Provider conversation · Messaging is not available for this provider',
    53	      settings: 'Your host saves this provider conversation. This provider does not offer messaging.' } : {}),
    54	  } };
    55	  let agent: Agent;
    56	  switch (runtime?.engine) {
    57	    case 'codex': agent = 'codex'; break;
    58	    case 'codex-sdk': agent = 'codex-sdk'; break;
    59	    case 'claude-sdk':
    60	      agent = runtime.format === CLAUDE_SDK_RUNTIMES.opus.format ? 'claude-sdk-opus'
    61	        : runtime.format === CLAUDE_SDK_RUNTIMES.sonnet.format ? 'claude-sdk-sonnet' : 'local';
    62	      break;
    63	    case 'pi': agent = 'pi'; break;
    64	    case 'openpane-recorded': agent = 'recorded'; break;
    65	    default: agent = 'local';
    66	  }
    67	  const presentation = AGENT_PRESENTATION[agent];
    68	  return { agent, presentation: runtime?.engine === 'codex'
    69	    ? { ...presentation, hostLabel: `Codex · ${runtime.version}` } : presentation };
    70	}
```

### apps/desktop/src/shell/BrowserApplication.tsx (lines 50-77, 134-137, 174-178)
```tsx
    50	  const displayedAgent = app.active?.agent ?? selected;
    51	  const runtime = displayedAgent ? ('runtime' in displayedAgent ? displayedAgent.runtime : displayedAgent) : metadata?.compatibility.nativeRuntime ?? null;
    52	  const { agent, presentation } = agentPresentation(runtime);
    53	  const activeActions = app.active ? controller.conversationActions(app.active) : null;
    54	  const modules = custom.namespaces.map(owner => <CustomizationModules key={owner.namespace} owner={owner}
    55	    active={app.active} actions={activeActions} enabled={enabled} agent={agent} />);
    56	  const customizationsOn = children === undefined && customizationEnabled;
    57	  const rows = extensionRows({ customizations: customization, activations: custom.namespaces, enabled: customizationsOn, metadata });
    58	  const workspaceRow = openableRow(rows.find(row => row.namespace === selectedExtension));
    59	  const workspaceOpen = selectedView === 'extensions' && workspaceRow !== null;
    60	  // One element, placed in one slot: the Chats view, or the open workspace of the active conversation's namespace.
    61	  const slots = conversationSlots({ row: workspaceOpen ? workspaceRow : null, active: app.active, metadata, custom, modules, agents: choices });
    62	  const activeConversation = app.active && activeActions
    63	    ? <ConversationView
    64	        key={`${app.active.viewId}/${app.active.scope.hostId}/${app.active.scope.conversationId}`}
    65	        transcript={slots.transcript} activity={custom.activity} contentLayout={slots.contentLayout} modules={slots.modules} permissionState={app.permissionState} observation={app.observation} continuation={app.continuation} actions={activeActions} active={app.active} enabled={enabled} storageFailure={app.storageFailure} agent={agent}
    66	        composerControls={canSwitch => <ComposerAgentControls agents={slots.composerAgents} agent={app.active?.agent ?? null} hasConversation enabled={canSwitch && app.saved.pendingCreation === null} onStartConversation={id => void controller.create(id)} onSetupPi={setupPi} />}
    67	      />
    68	    : null;
    69	  const workspaceConversation = slots.workspace ? activeConversation : null;
    70	  const conversation = !slots.workspace && activeConversation
    71	    ? activeConversation
    72	    : <section className="conversation-panel empty-workspace">
    73	        <p className="eyebrow">YOUR LOCAL WORKSPACE</p>
    74	        <h1>A conversation that stays with you.</h1>
    75	        <p>{app.host.kind === 'ready' && !selected ? 'No agents are available to start a conversation.' : 'Connect to your local host, then start a conversation. Your chats and drafts stay here when you come back.'}</p>
    76	        <div className="composer empty-composer"><p>Choose your chat settings.</p><ComposerAgentControls agents={choices} agent={selected ?? null} hasConversation={false} enabled={enabled && app.saved.pendingCreation === null} onStartConversation={id => void controller.create(id)} onSetupPi={setupPi} /></div>
    77	      </section>;
   134	  const views = <div className="chat-view" inert={suspended}>
   135	      {conversation}
   136	      {!app.active && modules}
   137	    </div>;
   174	  return <DesktopShell navigation={rail} activeView={selectedView} protectedContent={controls} defaultView={views} settingsView={settings}
   175	    extensionsView={extensionsView} workspaceOpen={workspaceOpen} restoreMode={children === undefined ? 'managed' : 'remount'}
   176	    onRestore={() => { setCustomizationEnabled(false); setSelectedView('chats'); }}
   177	    status={app.active ? <ConversationStatus active={app.active} /> : 'No conversation open'}
   178	    buildLabel={presentation.buildLabel}>{children}</DesktopShell>;
```

### apps/desktop/src/shell/Shell.tsx (lines 76-101)
```tsx
    76	  return <ThemeScope className="desktop-shell" data-workspace-view={activeView} data-workspace-open={showExtensions && workspaceOpen ? 'true' : undefined}>
    77	    <header className="shell-header">
    78	      <div className="brand"><span className="brand-mark" aria-hidden="true">a</span><strong>OpenPane</strong><span className="platform-label">Desktop</span></div>
    79	      <details className="recovery-menu"><summary>View options</summary><nav aria-label="Recovery controls">
    80	        <Button tone="secondary" onClick={() => { onRestore?.(); setView((current) => ({ kind: 'default', revision: current.kind === 'default' ? current.revision + 1 : 1 })); }}>Restore default view</Button>
    81	        <Button tone="secondary" onClick={() => window.location.reload()}>Reload app</Button>
    82	      </nav></details>
    83	    </header>
    84	    {navigation}
    85	    {protectedContent}
    86	    <main id="main-content">
    87	      <div className="shell-view" hidden={showSettings || showExtensions}>
    88	        <ContentBoundary key={boundaryKey} revision={revision}>
    89	          {view.kind === 'initial' ? children ?? defaultView ?? <DefaultView /> : defaultView ?? <DefaultView />}
    90	        </ContentBoundary>
    91	      </div>
    92	      {settingsView !== undefined && <div className="shell-view" hidden={!showSettings}>
    93	        <ContentBoundary key={`settings-${boundaryKey}`} revision={revision}>{settingsView}</ContentBoundary>
    94	      </div>}
    95	      {extensionsView !== undefined && <div className="shell-view" hidden={!showExtensions}>
    96	        <ContentBoundary key={`extensions-${boundaryKey}`} revision={revision}>{extensionsView}</ContentBoundary>
    97	      </div>}
    98	    </main>
    99	    <footer className="shell-footer"><span className="footer-status">{status ?? 'Disconnected'}</span><span>{buildLabel ?? 'Local app · No host connection'}</span></footer>
   100	  </ThemeScope>;
   101	}
```

### apps/desktop/src/application/ExtensionsView.tsx (lines 10-31, 94-114)
```tsx
    10	export type ExtensionRowState = 'Ready' | 'Not configured' | 'Unavailable' | 'No view' | 'Failed' | 'Disabled' | 'Loading';
    11	export interface ExtensionRow {
    12	  readonly namespace: string;
    13	  readonly label: string;
    14	  readonly state: ExtensionRowState;
    15	  readonly detail: string | null;
    16	  readonly owner: Extract<NamespaceActivation, { readonly kind: 'ready' }> | null;
    17	  readonly workspace: WorkspaceContribution | null;
    18	}
    19	/** A row whose workspace can open: its namespace is ready and contributes a workspace. */
    20	export type OpenableRow = ExtensionRow & { readonly owner: NonNullable<ExtensionRow['owner']>; readonly workspace: WorkspaceContribution };
    21	const CLOSED_STATES: ReadonlySet<ExtensionRowState> = new Set(['Disabled', 'Failed', 'Loading']);
    22	export function openableRow(row: ExtensionRow | undefined): OpenableRow | null {
    23	  return row?.owner && row.workspace && !CLOSED_STATES.has(row.state) ? { ...row, owner: row.owner, workspace: row.workspace } : null;
    24	}
    25	type ProviderAgent = Extract<AgentDescriptor, { readonly kind: 'provider' }>;
    26	const SERVER_FAILURE = 'The server extension failed to load. Check the extension configuration, then restart the host.';
    27	const UNAVAILABLE = 'The provider service is offline or unreachable. OpenPane checks again automatically.';
    28	
    29	export function namespaceAgents(metadata: ServiceMetadata | null, namespace: string): readonly ProviderAgent[] {
    30	  return (metadata?.agents ?? []).filter((agent): agent is ProviderAgent => 'kind' in agent && agent.namespace === namespace);
    31	}
    94	export function ExtensionsList({ rows, onOpen, enabled }: {
    95	  readonly rows: readonly ExtensionRow[]; readonly onOpen: (namespace: string) => void; readonly enabled: boolean;
    96	}) {
    97	  return <section className="extensions-panel" aria-label="Extensions">
    98	    <h1>Extensions</h1>
    99	    {rows.length === 0 ? <p className="empty-state">No extensions are installed in this build or configured on this host.</p>
   100	      : <ul className="extension-list">
   101	        {rows.map(row => {
   102	          const selectable = openableRow(row) !== null;
   103	          return <li key={row.namespace} className="extension-row" data-extension={row.namespace}>
   104	            <div className="extension-row-text">
   105	              <strong>{row.label}</strong>
   106	              <span className="extension-state" data-state={row.state}>{row.state}</span>
   107	              {row.detail && <p>{row.detail}</p>}
   108	            </div>
   109	            {selectable && <button type="button" disabled={!enabled} aria-label={`Open ${row.label}`} onClick={() => onOpen(row.namespace)}>Open</button>}
   110	          </li>;
   111	        })}
   112	      </ul>}
   113	  </section>;
   114	}
```

### apps/desktop/src/application/application.css (lines 1-21, 84-144, 160-187, 210-258, 269-282)
```css
     1	.application-controls { padding: 1.5rem 2rem; background: var(--aui-color-surface); border-bottom: 1px solid var(--aui-color-border); }
     2	.artifact-identity { margin: .75rem 0; color: var(--aui-color-muted); font-size: .7rem; overflow-wrap: anywhere; }
     3	.application-controls button, .conversation-panel button { border: 1px solid var(--aui-color-border); border-radius: .5rem; padding: .6rem .9rem; background: var(--aui-color-surface); color: inherit; font: inherit; cursor: pointer; }
     4	.application-controls button:hover:not(:disabled), .conversation-panel button:hover:not(:disabled) { border-color: var(--aui-color-accent); }
     5	.application-controls button:disabled, .conversation-panel button:disabled { opacity: .45; cursor: default; }
     6	.application-controls button:focus-visible, .conversation-panel button:focus-visible, .application-controls input:focus-visible, .composer textarea:focus-visible { outline: 2px solid var(--aui-color-accent); outline-offset: 3px; }
     7	.action-row { display: flex; flex-wrap: wrap; gap: .6rem; margin-top: 1rem; }
     8	.application-alert, .creation-recovery { padding: 1rem; margin: 1rem 0; border: 1px solid var(--aui-color-border); border-left: 3px solid var(--aui-color-accent); border-radius: .5rem; overflow-wrap: anywhere; }
     9	.application-alert p:last-child { margin-bottom: 0; }
    10	.conversation-catalog { display: flex; gap: .5rem; overflow-x: auto; margin-top: 1rem; padding-bottom: .25rem; }
    11	.eyebrow { font-size: .7rem; letter-spacing: .12em; color: var(--aui-color-accent); }
    12	.scope-label { color: var(--aui-color-muted); font-size: .75rem; overflow-wrap: anywhere; }
    13	.progress-label { display: block; font-size: .75rem; margin-top: .8rem; color: var(--aui-color-muted); }
    14	.empty-state, .empty-workspace > p:last-child { color: var(--aui-color-muted); line-height: 1.6; }
    15	.composer-footer { display: flex; align-items: center; justify-content: space-between; gap: .5rem; }
    16	.decision-card, .permissions-panel, .outbox { padding: 1.25rem; margin-top: 1.5rem; border: 1px solid var(--aui-color-border); border-radius: .8rem; }
    17	.decision-card h2, .permissions-panel h2, .outbox h2 { margin-top: 0; font-size: 1rem; }
    18	.decision-card p, .permissions-panel p { white-space: pre-wrap; overflow-wrap: anywhere; }
    19	.outbox > p { color: var(--aui-color-muted); font-size: .85rem; }
    20	.outbox article + article { border-top: 1px solid var(--aui-color-border); padding-top: 1rem; margin-top: 1rem; }
    21	.outbox code { font-size: .7rem; overflow-wrap: anywhere; }
    84	.desktop-shell:has(.application-controls) #main-content { align-content: start;
    85	  padding: 0 32px;
    86	  grid-column: 2; grid-row: 2; display: flex; min-width: 0; min-height: 0; overflow: hidden;
    87	}
    88	.conversation-panel {
    89	  width: min(100%, 820px); margin: 0 auto; height: 100%; min-height: 0;
    90	  display: flex; flex-direction: column; overflow-y: auto;
    91	}
    92	.conversation-panel > header { flex: none; padding: 18px 0 12px; border-bottom: 1px solid var(--aui-color-border); }
    93	.conversation-panel > header .eyebrow, .conversation-panel > header .scope-label { display: none; }
    94	.conversation-panel h1 { margin: 0; font-size: 15px; font-weight: 600; }
    95	.transcript { display: flex; flex-direction: column; gap: 28px; margin: 0; flex: 1; min-height: 80px; overflow-y: auto; padding: 32px 4px; }
    96	.message { min-width: 0; border: 0; border-radius: 0; padding: 0; font-size: 14px; line-height: 1.75; }
    97	.message-user p { white-space: pre-wrap; overflow-wrap: anywhere; margin: 6px 0 0; }
    98	.message-user { margin-left: 2rem; align-self: flex-end; max-width: 85%; margin: 0; padding: 12px 18px; border-radius: 20px; background: var(--aui-color-raised); }
    99	.message-assistant { margin-right: 2rem; margin: 0 20px 0 0; }
   100	.message > strong { font-size: 11px; color: var(--aui-color-muted); font-weight: 500; }
   101	.assistant-reply { min-width: 0; overflow-wrap: anywhere; }
   102	.assistant-reply p, .assistant-reply ul, .assistant-reply ol, .assistant-reply blockquote { margin: .65rem 0; }
   103	.assistant-reply > :last-child { margin-bottom: 0; }
   104	.assistant-reply :is(h1, h2, h3, h4, h5, h6) { margin: 1rem 0 .5rem; line-height: 1.3; font-weight: 600; }
   105	.assistant-reply h1 { font-size: 1.4rem; }
   106	.assistant-reply h2 { font-size: 1.2rem; }
   107	.assistant-reply :is(h3, h4, h5, h6) { font-size: 1rem; }
   108	.assistant-reply ul, .assistant-reply ol { padding-left: 1.5rem; }
   109	.assistant-reply blockquote { margin-left: 0; padding-left: 1rem; border-left: 3px solid var(--aui-color-border); }
   110	.assistant-reply code { font-family: ui-monospace, monospace; font-size: .85em; }
   111	.assistant-reply :not(pre) > code { padding: .1em .3em; border-radius: .25rem; background: var(--aui-color-raised); }
   112	.assistant-reply pre { max-width: 100%; box-sizing: border-box; overflow-x: auto; padding: .8rem; margin: 0; white-space: pre; overflow-wrap: normal; background: var(--aui-color-surface); }
   113	.reply-code-block { min-width: 0; margin: .8rem 0; border: 1px solid var(--aui-color-border); border-radius: .5rem; overflow: hidden; }
   114	.reply-code-actions { display: flex; align-items: center; flex-wrap: wrap; gap: .5rem; padding: .5rem; font-size: .75rem; }
   115	.conversation-panel .reply-code-actions button { padding: .3rem .5rem; font-size: inherit; }
   116	.reply-code-actions span, .reply-destination { color: var(--aui-color-muted); }
   117	.composer { display: grid; gap: 8px; margin-top: 1.5rem; flex: none; margin: 12px 0 16px; padding: 12px 14px 10px; border-radius: 22px; background: var(--aui-color-raised); }
   118	.composer label { font-size: .85rem; font-weight: 600; position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip-path: inset(50%); }
   119	.composer textarea { box-sizing: border-box; width: 100%; resize: vertical; padding: 4px 2px; border: 0; border-radius: 8px; background: transparent; color: inherit; font: inherit; min-height: 54px; max-height: 160px; font-size: 14px; line-height: 1.5; }
   120	.composer textarea:focus-visible { outline: none; }
   121	.composer:focus-within { box-shadow: 0 0 0 2px var(--aui-color-accent); }
   122	.composer-footer span { font-size: 10px; color: var(--aui-color-muted); }
   123	.composer-attachments { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 12px; }
   124	.composer-attachments p { margin: 0; flex-basis: 100%; }
   125	.composer-image { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 4px 4px 4px 10px; border: 1px solid var(--aui-color-border); border-radius: 12px; overflow-wrap: anywhere; }
   126	.composer-image [role="status"] { color: var(--aui-color-muted); }
   127	.conversation-panel .composer-attachments button { padding: 4px 10px; font-size: 12px; }
   128	.image-attachment { margin: 8px 0 0; }
   129	.image-attachment img { display: block; max-width: min(240px, 100%); max-height: 240px; border-radius: 8px; }
   130	.image-attachment figcaption, .image-preview-status { font-size: 12px; color: var(--aui-color-muted); overflow-wrap: anywhere; }
   131	.sent-images { display: flex; flex-wrap: wrap; gap: 12px; padding: 12px 0; border-top: 1px solid var(--aui-color-border); }
   132	.sent-images h2 { flex-basis: 100%; margin: 0; font-size: .85rem; }
   133	.composer-footer button { background: var(--aui-color-accent); color: var(--aui-color-on-accent); border: 0; border-radius: 20px; padding: 6px 14px; font-size: 12px; }
   134	.decision-card, .permissions-panel { flex: none; max-height: 30vh; overflow-y: auto; padding: 14px; margin-top: 12px; background: var(--aui-color-surface); font-size: 12px; }
   135	.outbox { flex: none; max-height: 22vh; overflow-y: auto; }
   136	.continuation-history { flex: none; display: flex; flex-direction: column; align-items: flex-start; gap: 12px; padding-top: 16px; }
   137	.continuation-history .earlier-segment { flex: none; align-self: stretch; overflow-y: visible; padding: 0 4px; }
   138	.continuation-boundary { align-self: stretch; margin: 0; padding: 10px 0; border-top: 1px solid var(--aui-color-border); border-bottom: 1px solid var(--aui-color-border); color: var(--aui-color-muted); font-size: 12px; line-height: 1.5; }
   139	.continuation-choices p { margin: 8px 0 0; }
   140	.visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
   141	.empty-workspace { padding: 24px; max-width: 38rem; justify-content: center; }
   142	.empty-workspace .eyebrow { font-size: 11px; }
   143	.empty-workspace h1 { font-size: 28px; }
   144	.desktop-shell:has(.application-controls) .shell-footer { grid-column: 2; grid-row: 3; padding: 4px 24px; border: 0; font-size: 10px; }
   160	.desktop-shell:has(.view-rail) {
   161	  grid-template-columns: 56px 232px minmax(0, 1fr);
   162	  grid-template-rows: minmax(0, 1fr) 30px;
   163	}
   164	.desktop-shell:has(.view-rail) .shell-header {
   165	  position: absolute; z-index: 4; top: 16px; right: 24px;
   166	  padding: 0; border: 0; background: transparent;
   167	}
   168	.desktop-shell:has(.view-rail) .shell-header .brand { display: none; }
   169	.desktop-shell[data-workspace-view="chats"] .shell-header { display: none; }
   170	.view-rail {
   171	  grid-column: 1; grid-row: 1 / -1; display: flex; flex-direction: column;
   172	  align-items: center; gap: 12px; padding: 18px 6px 16px;
   173	  background: var(--aui-color-surface); border-right: 1px solid var(--aui-color-border);
   174	}
   175	.view-rail button {
   176	  width: 40px; height: 40px; flex: none; padding: 9px;
   177	  border: 0; border-radius: 10px; background: transparent; color: var(--aui-color-muted); cursor: pointer;
   178	}
   179	.view-rail button[aria-pressed="true"], .view-rail button:hover { background: var(--aui-color-raised); color: var(--aui-color-text); }
   180	.view-rail button:focus-visible { outline: 2px solid var(--aui-color-accent); outline-offset: 2px; }
   181	.view-rail svg { width: 22px; height: 22px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
   182	.view-rail .settings-view-button { margin-top: auto; }
   183	.desktop-shell:has(.view-rail) .application-controls { grid-column: 2; grid-row: 1 / -1; padding-top: 18px; }
   184	.sidebar-title { font-size: 16px; margin: 0 10px 18px; font-weight: 600; }
   185	.desktop-shell:has(.view-rail) #main-content { grid-column: 3; grid-row: 1; }
   186	.desktop-shell:has(.view-rail) .shell-footer { grid-column: 3; grid-row: 2; }
   187	.chat-view { display: flex; width: 100%; height: 100%; min-height: 0; }
   210	.chat-view { flex-direction: column; }
   211	.chat-view > .conversation-panel { flex: 1; }
   212	.customization-panel { flex: none; max-height: 35%; overflow: auto; padding: 8px 0; width: 100%; box-sizing: border-box; overflow-wrap: anywhere; }
   213	.customization-panel h2 { font-size: 16px; margin-top: 0; }
   214	.customization-modules { border: 1px solid var(--aui-color-border); border-radius: 12px; padding: 1rem; margin: 0; min-width: 0; }
   215	
   216	.chat-search { margin: 0 4px 16px; min-width: 0; }
   217	.chat-search label, .search-status { display: block; font-size: 12px; color: var(--aui-color-muted); }
   218	.chat-search input { box-sizing: border-box; width: 100%; min-width: 0; padding: 9px 8px; margin-top: 6px; border: 1px solid var(--aui-color-border); border-radius: 8px; background: var(--aui-color-canvas); color: inherit; font: inherit; }
   219	.chat-search > button { font-size: 12px; }
   220	.chat-search [role="listbox"] { display: flex; flex-direction: column; gap: 4px; }
   221	.chat-search [role="listbox"][hidden] { display: none; }
   222	.chat-search [role="option"] { width: 100%; overflow-wrap: anywhere; }
   223	.chat-search [role="option"][aria-selected="true"] { background: var(--aui-color-raised); outline: 1px solid var(--aui-color-accent); outline-offset: -1px; }
   224	.chat-search [role="option"] span, .chat-search [role="option"] small { display: block; white-space: normal; }
   225	.chat-search [role="option"] small { margin-top: 4px; color: var(--aui-color-muted); font-size: 11px; }
   226	
   227	.agent-choice { display: grid; gap: .4rem; min-width: 0; font-size: .8rem; }
   228	.agent-choice select { width: 100%; min-width: 0; max-width: 100%; padding: .5rem; border: 1px solid var(--aui-color-border); border-radius: .5rem; background: var(--aui-color-surface); color: inherit; font: inherit; }
   229	.agent-choice select:focus-visible { outline: 2px solid var(--aui-color-accent); outline-offset: 3px; }
   230	.agent-label { margin: 0; color: var(--aui-color-muted); font-size: .8rem; }
   231	
   232	.composer-footer { flex-wrap: wrap; align-items: flex-end; }
   233	.composer-agent-controls { position: relative; display: flex; align-items: center; flex-wrap: wrap; gap: 2px; min-width: 0; flex: 1; }
   234	.conversation-panel .composer-setting { display: inline-flex; align-items: center; gap: 5px; padding: 6px 7px; min-width: 0; max-width: 100%; border: 0; border-radius: 7px; background: transparent; color: var(--aui-color-text); font-size: 12px; line-height: 1.3; text-align: left; }
   235	.conversation-panel .composer-setting:hover:not(:disabled), .conversation-panel .composer-setting[aria-expanded="true"] { background: var(--aui-color-surface); }
   236	.composer-setting svg { width: 12px; height: 12px; flex: none; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
   237	.conversation-panel .composer-effort { color: var(--aui-color-muted); opacity: .65; }
   238	.composer-send-actions { display: flex; gap: 6px; margin-left: auto; }
   239	.composer-disclosure { flex-basis: 100%; margin: 0; color: var(--aui-color-muted); font-size: 10px; line-height: 1.4; }
   240	.composer-picker { position: absolute; z-index: 6; bottom: calc(100% + 10px); left: 0; width: min(320px, 100%); min-width: 0; box-sizing: border-box; max-height: min(420px, 55dvh); overflow: auto; padding: 12px; border: 1px solid var(--aui-color-border); border-radius: 16px; background: var(--aui-color-surface); box-shadow: 0 12px 40px #0003; color: var(--aui-color-text); }
   241	.composer-picker:focus { outline: none; }
   242	.composer-picker-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 13px; }
   243	.conversation-panel .composer-picker-heading button { padding: 0 5px; background: transparent; color: var(--aui-color-muted); font-size: 20px; border: 0; }
   244	.composer-picker > p { margin: 5px 0 12px; color: var(--aui-color-muted); font-size: 11px; line-height: 1.5; }
   245	.composer-picker-options { display: grid; gap: 4px; }
   246	.conversation-panel .composer-picker-option { position: relative; display: grid; gap: 3px; width: 100%; padding: 8px 24px 8px 10px; background: transparent; color: inherit; border: 0; border-radius: 9px; font-size: 13px; line-height: 1.4; text-align: left; overflow-wrap: anywhere; }
   247	.conversation-panel .composer-picker-option:hover:not(:disabled) { background: var(--aui-color-raised); }
   248	.conversation-panel .composer-picker-option[aria-current="true"] { background: var(--aui-color-raised); opacity: 1; }
   249	.composer-footer .composer-picker-option > span { color: var(--aui-color-text); font-size: 13px; }
   250	.composer-picker-option small { font-size: 10px; line-height: 1.4; color: var(--aui-color-muted); }
   251	.composer-picker-option .picker-check { position: absolute; right: 9px; top: 10px; }
   252	.conversation-panel .composer-setting:focus-visible, .conversation-panel .composer-picker button:focus-visible { outline: 2px solid var(--aui-color-accent); outline-offset: 2px; }
   253	.empty-composer { margin-top: 24px; }
   254	.empty-composer > p { margin: 0 0 12px; color: var(--aui-color-muted); font-size: 13px; }
   255	@media (max-width: 760px) {
   256	  .composer-footer > .composer-agent-controls { flex-basis: 100%; }
   257	  .conversation-panel .composer-setting { padding-inline: 4px; font-size: 11px; }
   258	}
   269	.conversation-content { flex: 1 1 0; min-height: 80px; min-width: 0; overflow: auto; container-type: inline-size; }
   270	.conversation-content .transcript { flex: none; overflow-y: visible; }
   271	.conversation-content .customization-panel { max-height: none; overflow: visible; }
   272	
   273	/* Extensions view. A workspace owns the area right of the rail; host alerts move into its status strip. */
   274	.extensions-view { display: flex; width: 100%; height: 100%; min-height: 0; }
   275	.extensions-panel { width: min(100%, 720px); margin: 0 auto; padding: 32px 0; overflow-y: auto; }
   276	.extensions-panel h1 { margin: 0 0 24px; font-size: 24px; }
   277	.extension-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
   278	.extension-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 14px 16px; border: 1px solid var(--aui-color-border); border-radius: 10px; background: var(--aui-color-surface); }
   279	.extension-row-text { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; min-width: 0; }
   280	.extension-row-text p { flex-basis: 100%; margin: 4px 0 0; color: var(--aui-color-muted); font-size: 12px; overflow-wrap: anywhere; }
   281	.extension-state { font-size: 12px; color: var(--aui-color-muted); }
   282	.extension-row button, .extension-back { padding: 6px 14px; border: 1px solid var(--aui-color-border); border-radius: 8px; background: var(--aui-color-raised); color: inherit; font: inherit; cursor: pointer; }
```

### extensions/crew/src/desktop/index.tsx line 11 (coworkers identical shape)
```tsx
    return { modules: [], workspace: { label: 'Crew', component: CrewWorkspace, transcript: CrewTranscript }, dispose() {} };
```

### tests/application/composer-image.browser.test.mjs (lines 60-140)
```js
    60	    const url = new URL(route.request().url()), asset = url.origin === 'https://image.test' ? assets[url.pathname] : undefined;
    61	    if (asset) await route.fulfill({ contentType: asset[0], body: asset[1], headers: { 'content-security-policy': csp } });
    62	    else { requests.push(route.request().url()); await route.abort(); }
    63	  });
    64	  await page.goto('https://image.test/');
    65	  await page.waitForFunction(() => typeof globalThis.deliver === 'function');
    66	  await page.evaluate(bytes => { globalThis.previewBytes = new Uint8Array(bytes); }, [...png]);
    67	  await page.evaluate(() => globalThis.deliver({ kind: 'snapshot', snapshot: { scope: { hostId: 'host', conversationId: 'image' }, projectionVersion: 4, cursor: 0,
    68	    document: { domain: { messages: [], currentRun: null }, receipts: {}, decisions: {} } } }));
    69	  const send = page.getByRole('button', { name: 'Send', exact: true });
    70	  assert.equal(await send.isDisabled(), true);
    71	  await page.getByLabel('Image file').setInputFiles({ name: 'chart.png', mimeType: 'image/png', buffer: png });
    72	  const card = page.getByLabel('Attached image');
    73	  await card.getByRole('status').filter({ hasText: 'Ready' }).waitFor();
    74	  assert.match(await card.textContent(), /chart\.png · 70 B/);
    75	  assert.equal(await page.evaluate(() => globalThis.uploadedBytes), png.length);
    76	  await send.click();
    77	  await card.waitFor({ state: 'detached' });
    78	  const submitted = await page.evaluate(() => globalThis.submitted);
    79	  assert.deepEqual(submitted.map(command => command.body), [{ kind: 'send', text: '', imageId: '00000000-0000-4000-8000-aaaaaaaaaaaa' }]);
    80	  assert.equal(await page.evaluate(() => globalThis.savedImages()), 0);
    81	  await page.evaluate(() => globalThis.deliver({ kind: 'events', events: [{ scope: { hostId: 'host', conversationId: 'image' }, sequence: 1, event: { kind: 'domain', event: {
    82	    kind: 'message-updated', messageId: 'sent', revision: 1, role: 'user', text: '', complete: true,
    83	    image: { imageId: '00000000-0000-4000-8000-aaaaaaaaaaaa', name: 'chart.png', mediaType: 'image/png', byteLength: 70, width: 1, height: 1 } } } }] }));
    84	  const preview = page.locator('.message-user').getByRole('img', { name: 'chart.png' });
    85	  await preview.waitFor();
    86	  await page.waitForFunction(() => document.querySelector('.message-user img')?.naturalWidth === 1);
    87	  assert.match(await preview.getAttribute('src'), /^blob:/);
    88	  assert.deepEqual(await page.evaluate(() => globalThis.reads), ['00000000-0000-4000-8000-aaaaaaaaaaaa']);
    89	  assert.deepEqual(requests, []);
    90	  assert.deepEqual(errors, []);
    91	  assert.deepEqual(violations, []);
    92	});
    93	
    94	test('a preview that the page cannot decode reports itself unavailable', async t => {
    95	  const browser = await chromium.launch();
    96	  t.after(() => browser.close());
    97	  const page = await browser.newPage();
    98	  const assets = { '/': ['text/html', '<!doctype html><main id="conversation"></main><script src="/app.js"></script>'], '/app.js': ['text/javascript', bundle.outputFiles[0].text] };
    99	  await page.route('**/*', async route => {
   100	    const asset = assets[new URL(route.request().url()).pathname];
   101	    await (asset ? route.fulfill({ contentType: asset[0], body: asset[1], headers: { 'content-security-policy': HOST_CSP } }) : route.abort());
   102	  });
   103	  await page.goto('https://image.test/');
   104	  await page.waitForFunction(() => typeof globalThis.deliver === 'function');
   105	  await page.evaluate(() => { globalThis.previewBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]); });
   106	  const scope = { hostId: 'host', conversationId: 'image' };
   107	  await page.evaluate(scope => globalThis.deliver({ kind: 'snapshot', snapshot: { scope, projectionVersion: 4, cursor: 0, document: { domain: { messages: [{
   108	    messageId: 'sent', revision: 1, role: 'user', text: '', complete: true,
   109	    image: { imageId: '00000000-0000-4000-8000-aaaaaaaaaaaa', name: 'broken.png', mediaType: 'image/png', byteLength: 7, width: 1, height: 1 } }], currentRun: null }, receipts: {}, decisions: {} } } }), scope);
   110	  await page.locator('.message-user').getByText('Preview unavailable').waitFor();
   111	  assert.equal(await page.locator('.message-user img').count(), 0);
   112	});
   113	
   114	test('model-less capable picker follows operation capability and retains Retry and preview after support loss', async t => {
   115	  const browser = await chromium.launch();
   116	  t.after(() => browser.close());
   117	  const page = await browser.newPage();
   118	  const assets = { '/': ['text/html', '<!doctype html><main id="conversation"></main><script src="/app.js"></script>'], '/app.js': ['text/javascript', bundle.outputFiles[0].text] };
   119	  await page.route('**/*', async route => {
   120	    const asset = assets[new URL(route.request().url()).pathname];
   121	    await (asset ? route.fulfill({ contentType: asset[0], body: asset[1], headers: { 'content-security-policy': HOST_CSP } }) : route.abort());
   122	  });
   123	  await page.goto('https://image.test/');
   124	  await page.waitForFunction(() => typeof globalThis.deliver === 'function');
   125	  await page.evaluate(() => {
   126	    globalThis.failUpload = true;
   127	    globalThis.deliver({ kind: 'snapshot', snapshot: { scope: { hostId: 'host', conversationId: 'image' }, projectionVersion: 4, cursor: 0,
   128	      document: { domain: { messages: [], currentRun: null }, receipts: {}, decisions: {} } } });
   129	  });
   130	  await page.getByRole('button', { name: 'Add image', exact: true }).waitFor();
   131	  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Keep caption');
   132	  await page.getByLabel('Image file').setInputFiles({ name: 'chart.png', mimeType: 'image/png', buffer: png });
   133	  const retry = page.getByRole('button', { name: 'Retry', exact: true });
   134	  await retry.waitFor();
   135	  await page.evaluate(() => { globalThis.failUpload = false; globalThis.refuseNewImages(); });
   136	  await page.getByText('This model cannot read images. Remove the image to send.', { exact: true }).waitFor();
   137	  assert.equal(await page.getByLabel('Image file').count(), 0);
   138	  assert.equal(await page.getByRole('button', { name: 'Replace image', exact: true }).count(), 0);
   139	  assert.equal(await retry.isEnabled(), true);
   140	  await retry.click();
```

### extensions/crew/tests/provider.test.mjs (lines 915-950)
```js
   915	test('browser keeps permissions after run end and confirms member revocation across conversations', { timeout: 20_000 }, async t => {
   916	  const remote = await service(t, { standingGrants: standingCapability }), f = await fixture(t, [remote.extension()]), scope = await f.create();
   917	  await f.client.conversation(scope).submit(send(scope));
   918	  const [requestId, receipt] = [...remote.receipts][0];
   919	  receipt.status = 'completed'; receipt.result = { text: 'Finished' }; remote.emit(receipt.conversationId);
   920	  await until(() => JSON.parse(saved(f).conversation.document).domain.currentRun?.kind === 'ended');
   921	  const narrow = activeGrant(receipt.conversationId), broad = activeGrant(null);
   922	  remote.grants.push(narrow, broad, activeGrant(randomUUID()));
   923	  const browser = await chromium.launch(); t.after(() => browser.close());
   924	  const context = await browser.newContext();
   925	  const page = await context.newPage(); page.setDefaultTimeout(5000); await page.goto(`${f.running.origin}/browser.html`);
   926	  await page.getByRole('button', { name: `A real provider reply · Open conversation ${scope.conversationId}`, exact: true }).click();
   927	  const permissions = page.getByRole('region', { name: 'Permissions', exact: true });
   928	  const revokeMember = permissions.getByRole('button', { name: 'Revoke for this member in all conversations', exact: true });
   929	  await revokeMember.waitFor();
   930	  assert.equal(await permissions.locator('h3').count(), 2);
   931	  await revokeMember.click();
   932	  assert.equal(remote.calls.filter(call => call.path.endsWith('/revoke')).length, 0);
   933	  await permissions.getByRole('button', { name: 'Keep permission', exact: true }).click();
   934	  await permissions.getByRole('button', { name: 'Revoke for this conversation', exact: true }).click();
   935	  await until(() => narrow.status === 'revoked');
   936	  await revokeMember.waitFor();
   937	  await permissions.getByRole('button', { name: 'Revoke for this conversation', exact: true }).waitFor({ state: 'detached' });
   938	  assert.equal(await permissions.getByRole('button', { name: 'Revoke for this conversation', exact: true }).count(), 0);
   939	  remote.setGrantHandler(() => ({ apiVersion: '1', memberId, active: [broad, broad], inactive: [] }));
   940	  await permissions.getByRole('button', { name: 'Refresh permissions', exact: true }).click();
   941	  await page.waitForFunction(() => document.querySelector('[aria-label="Permissions"]').textContent.includes('Provider permissions unavailable'));
   942	  assert.equal(await revokeMember.isDisabled(), true);
   943	  remote.setGrantHandler(undefined);
   944	  await permissions.getByRole('button', { name: 'Refresh permissions', exact: true }).click();
   945	  await revokeMember.click();
   946	  await permissions.getByRole('button', { name: 'Confirm revoke in all conversations', exact: true }).click();
   947	  await until(() => broad.status === 'revoked');
   948	  await permissions.getByText('No active work-item permissions were found.', { exact: true }).waitFor();
   949	  assert.equal(remote.calls.filter(call => call.path.endsWith('/revoke')).length, 2);
   950	  assert.equal(remote.calls.filter(call => call.method === 'POST' && call.path.endsWith('/requests')).length, 1);
```

## Evidence gaps
- No screenshot exists of a Crew conversation with a non-empty permissions listing; layout of revocation UI under any redesign is unverified.
- No bundled customization currently contributes non-empty modules; module actions are only exercised by test fixtures (tests/application/module-actions.browser.test.mjs).
- Whether the Tauri webview delivers HTML5 file drag events to the page depends on Tauri's dragDropEnabled window setting (apps/desktop/src-tauri/tauri.conf.json); see excerpt below.

### apps/desktop/src-tauri/src/main.rs (lines 130-150) and tauri.conf.json window
```rust
   130	            });
   131	            app.manage(provider_setup::SetupState(setup.map(|configuration| {
   132	                std::sync::Arc::new(std::sync::Mutex::new(configuration))
   133	            })));
   134	            let browser_url = host_url.clone();
   135	            let setup_app = app.handle().clone();
   136	            let window =
   137	                tauri::WebviewWindowBuilder::from_config(app, &app.config().app.windows[0])?
   138	                    .on_navigation(move |url| {
   139	                        if setup_url.as_ref() == Some(url) {
   140	                            let app = setup_app.clone();
   141	                            let _ = setup_app.run_on_main_thread(move || {
   142	                                let _ = open_provider_setup(&app);
   143	                            });
   144	                            return false;
   145	                        }
   146	                        bundled(url) || browser_url.as_ref() == Some(url)
   147	                    })
   148	                    .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
   149	                    .build()?;
   150	            let background = |theme| match theme {
```
```json
    "windows": [{ "create": false, "title": "OpenPane", "titleBarStyle": "Transparent", "width": 1120, "height": 780, "minWidth": 360, "minHeight": 480 }],
```
Fact: no call to disable_drag_drop_handler and no dragDropEnabled key exist. In Tauri 2 the native drag-drop handler is enabled by default; on macOS it consumes OS file drops and emits tauri://drag-drop events with file paths, so HTML5 'drop' events in the webview do not receive File objects unless the handler is disabled (WebviewWindowBuilder::disable_drag_drop_handler or window config "dragDropEnabled": false). The browser build (vite --mode browser) receives normal HTML5 drops.
