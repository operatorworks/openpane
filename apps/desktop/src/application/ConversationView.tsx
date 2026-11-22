import { canRetryObservation } from '@openpane/contracts';
import type { ConversationClosure, ObservationStopReason } from '@openpane/contracts';
import { useEffect, useLayoutEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { useConversation } from '@openpane/client/react';
import type { ConversationActions, ConversationContinuation, OpenConversation, ConversationObservation, PermissionState } from './application-controller.js';
import { ContinuationChoices, ContinuationHistory } from './ContinuationNotice.js';
import { ConversationPermissions, permissionsShown } from './ConversationPermissions.js';
import { CommandRecovery } from './CommandRecovery.js';
import { recoveryModel } from './recovery.js';
import { AGENT_PRESENTATION, conversationPresentation } from './agent-presentation.js';
import { conversationResponding } from './responding.js';
import { FileActivity } from './FileActivity.js';
import { CommandActivity } from './CommandActivity.js';
import { AssistantReply } from './AssistantReply.js';
import { CustomizationActivity, CustomizationTranscript, type ActivitySelection, type ContentLayoutSelection, type TranscriptSelection } from './DesktopCustomizations.js';
import { CustomizationContent } from './CustomizationContent.js';
import { ImageAttachmentCard, imageSize } from './ImageAttachmentCard.js';
import { dragVerdict, intakeFile, type DropVerdict } from './image-intake.js';

const OBSERVATION_NOTICE: Record<ObservationStopReason, string> = {
  'unsupported': 'This provider does not support live updates.',
  'snapshot-unavailable': 'The provider could not refresh this conversation.',
  'invalid-projection': 'The provider’s saved state or updates could not be validated.',
  'recovery-failed': 'The provider could not resume updates.',
  'retry-exhausted': 'Updates stopped after repeated gaps without progress.',
  'provider-disconnected': 'The provider stopped delivering updates.',
  'original-provider-unavailable': 'Restore this conversation’s original provider configuration to resume updates.',
  'original-credentials-unavailable': 'Restore this conversation’s original provider credentials to resume updates.',
  'original-binding-unavailable': 'This conversation’s original provider binding is unavailable. Restore its original configuration.',
  'cleanup-failed': 'The previous observer could not close safely. Restart the host before resuming updates.',
};
const CLOSURE_NOTICE: Record<ConversationClosure, string> = {
  cancelled: 'it was stopped',
  failed: 'the provider reported a failure',
  exhausted: 'it reached its turn limit',
};

type DraftEditor =
  | { readonly kind: 'saved' | 'saving'; readonly text: string }
  | { readonly kind: 'failed'; readonly text: string; readonly message: string };

export function ConversationStatus({ active }: { readonly active: OpenConversation }) {
  const view = useConversation(active.store);
  return <span role="status">Conversation {view.connection.kind}{'reason' in view.connection ? ` · ${view.connection.reason}` : ''}</span>;
}

export function ConversationView({ actions, active, enabled, storageFailure, observation = null, continuation = null, permissionState, agent = 'recorded', composerControls, transcript = { kind: 'default' }, activity = { kind: 'default' }, contentLayout = { kind: 'default' }, modules = null, customizationNotices = false }: {
  readonly actions: ConversationActions; readonly active: OpenConversation; readonly enabled: boolean; readonly storageFailure: string; readonly agent?: keyof typeof AGENT_PRESENTATION;
  readonly permissionState?: PermissionState;
  readonly observation?: ConversationObservation | null;
  readonly continuation?: ConversationContinuation | null;
  readonly transcript?: TranscriptSelection;
  readonly activity?: ActivitySelection;
  readonly contentLayout?: ContentLayoutSelection;
  readonly modules?: ReactNode;
  /** A customization is loading or failed, so its notice renders in the column. */
  readonly customizationNotices?: boolean;
  readonly composerControls?: (canSwitch: boolean) => ReactNode;
}) {
  const presentation = conversationPresentation(active.agent, agent);
  const view = useConversation(active.store);
  const [editor, setEditor] = useState<DraftEditor>({ kind: 'saved', text: view.draft });
  const editVersion = useRef(0);
  const stopGuard = useRef<{ readonly store: OpenConversation['store']; readonly runId: string } | null>(null);
  const approvalGuards = useRef(new Map<OpenConversation['store'], Set<string>>());
  const [approving, setApproving] = useState<ReadonlySet<string>>(new Set());
  const [stopPending, setStopPending] = useState<typeof stopGuard.current>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const intaking = useRef<OpenConversation['store'] | null>(null);
  const removals = useRef(0);
  const dragDepth = useRef(0);
  const [drop, setDrop] = useState<DropVerdict | null>(null);
  useEffect(() => {
    // dragend fires on the drag source, not on the panel; a cancelled drag must not leave the outline behind.
    const reset = () => { dragDepth.current = 0; setDrop(null); };
    document.addEventListener('dragend', reset);
    document.addEventListener('drop', reset);
    return () => { document.removeEventListener('dragend', reset); document.removeEventListener('drop', reset); };
  }, []);
  const composer = useRef<HTMLTextAreaElement>(null);
  // The textarea grows with its text; CSS max-height caps it, then it scrolls. A hidden view has no layout, so skip it.
  function fitComposer(): void {
    const field = composer.current;
    if (!field) return;
    field.style.height = 'auto';
    if (field.scrollHeight > 0) field.style.height = `${field.scrollHeight}px`;
    else field.style.height = '';
  }
  useEffect(() => {
    const field = composer.current;
    if (!field || typeof ResizeObserver === 'undefined') return;
    let width = field.clientWidth;
    const observer = new ResizeObserver(() => {
      if (field.clientWidth === width) return;
      width = field.clientWidth;
      fitComposer();
    });
    observer.observe(field);
    return () => observer.disconnect();
  }, []);
  const arrived = continuation?.arrived ?? null;
  useEffect(() => {
    // The click that led here removed its own control; focus the user moved elsewhere is left alone.
    if (arrived && (document.activeElement === null || document.activeElement === document.body)) composer.current?.focus();
  }, [arrived]);
  const [imageError, setImageError] = useState<{ readonly store: OpenConversation['store']; readonly message: string } | null>(null);
  useEffect(() => {
    setEditor(previous => previous.kind === 'saved' && previous.text !== view.draft ? { kind: 'saved', text: view.draft } : previous);
  }, [view.draft]);
  useLayoutEffect(fitComposer, [editor.text]);
  async function edit(value: string): Promise<void> {
    const version = ++editVersion.current;
    setEditor({ kind: 'saving', text: value });
    try {
      await active.store.setDraft(value);
      if (version === editVersion.current) setEditor({ kind: 'saved', text: active.store.getSnapshot().draft });
    } catch (error) {
      if (version === editVersion.current) setEditor({ kind: 'failed', text: value,
        message: error instanceof Error ? error.message : 'Your draft could not be saved.' });
    }
  }
  const observationStatus = observation?.status;
  const paused = observationStatus?.kind === 'stopped';
  const concluded = observationStatus?.kind === 'concluded';
  const available = active.agent.availability.kind === 'ready';
  const connected = enabled && available && view.connection.kind === 'connected';
  const live = presentation.live;
  const run = live ? view.document.domain.currentRun : null;
  const responding = conversationResponding(agent, view.document.domain);
  const retainedCancel = run && view.outbox.some(entry => entry.command.body.kind === 'cancel' && entry.command.body.runId === run.runId);
  const stopping = run?.kind === 'stopping' || Boolean(retainedCancel) ||
    (stopPending?.store === active.store && stopPending.runId === run?.runId);
  function stop(): void {
    if (!connected || !active.agent.commands.includes('cancel') || run?.kind !== 'running' || stopping ||
      (stopGuard.current?.store === active.store && stopGuard.current.runId === run.runId)) return;
    const target = { store: active.store, runId: run.runId };
    stopGuard.current = target;
    setStopPending(target);
    void actions.submit(() => target.store.cancel(target.runId)).finally(() => {
      if (stopGuard.current === target) {
        stopGuard.current = null;
        setStopPending(null);
      }
    });
  }
  function approve(pendingId: string, choiceId: string): void {
    const store = active.store, decision = store.getSnapshot().document.decisions[pendingId];
    const guards = approvalGuards.current.get(store) ?? new Set<string>();
    if (!connected || !active.agent.commands.includes('approve') || !decision || decision.reserved || guards.has(pendingId)) return;
    guards.add(pendingId);
    approvalGuards.current.set(store, guards);
    setApproving(new Set(guards));
    void actions.submit(() => store.approve(pendingId, choiceId)).finally(() => {
      guards.delete(pendingId);
      setApproving(new Set(guards));
    });
  }
  const image = view.image;
  const acceptsImages = active.agent.imageInput.kind === 'supported' && active.agent.commands.includes('send');
  const canSend = connected && !concluded && active.agent.commands.includes('send') && !responding && editor.kind === 'saved' &&
    (image ? image.status === 'ready' && acceptsImages : Boolean(editor.text.trim()));
  const sentImages = view.document.domain.messages.flatMap(message => message.image ? [{ messageId: message.messageId, image: message.image }] : []);
  function imageAction(operation: () => Promise<void>): void {
    const store = active.store;
    setImageError(null);
    void operation().catch((error: unknown) => setImageError({ store, message: error instanceof Error ? error.message : 'The image could not be changed.' }));
  }
  // Why a new image cannot be attached right now; the same conditions disable "+".
  const blocked = !acceptsImages ? (active.agent.imageInput.kind === 'unsupported' ? active.agent.imageInput.reason : 'This agent cannot receive images.')
    : storageFailure ? 'Images can’t be attached while drafts can’t be saved.'
    : !enabled ? 'Connect to your host to attach an image.'
    : image?.status === 'uploading' ? 'Wait for the current upload to finish.' : null;
  /** The one path for picked and dropped files: eligibility, then intake, then the store. */
  function attach(files: readonly File[]): void {
    const store = active.store;
    setImageError(null);
    const refuse = (message: string) => setImageError({ store, message });
    if (blocked) return refuse(blocked);
    if (intaking.current === store) return refuse('Wait for the current image to finish.');
    const result = intakeFile(files);
    if (result.kind === 'reject') return refuse(result.reason);
    const generation = removals.current;
    // The guard covers only the local file read; once the store has the bytes, its own upload state takes over.
    intaking.current = store;
    const release = () => { if (intaking.current === store) intaking.current = null; };
    void (async () => {
      try {
        const bytes = new Uint8Array(await result.file.arrayBuffer());
        release();
        // Remove while reading wins: a late read must not bring the image back.
        if (generation === removals.current) await store.selectImage({ name: result.file.name, bytes });
      } catch (error) {
        refuse(error instanceof Error ? error.message : 'The image could not be changed.');
      } finally {
        release();
      }
    })();
  }
  function dragging(event: DragEvent): DropVerdict | null {
    const verdict = dragVerdict([...event.dataTransfer.types], event.dataTransfer.items, blocked);
    if (verdict === 'ignore') return null;
    // Always copy, so the drop event fires and a refusal can explain itself; the outline shows the verdict.
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    return verdict;
  }
  function hover(verdict: DropVerdict): void {
    setDrop(previous => previous && previous.kind === verdict.kind && (previous.kind === 'accept' || (verdict.kind === 'reject' && previous.reason === verdict.reason)) ? previous : verdict);
  }
  const dropHandlers = {
    onDragEnter(event: DragEvent) { const verdict = dragging(event); if (verdict) { dragDepth.current++; hover(verdict); } },
    onDragOver(event: DragEvent) { const verdict = dragging(event); if (verdict) hover(verdict); },
    onDragLeave(event: DragEvent) {
      if (!event.dataTransfer.types.includes('Files')) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      // A child removed mid-drag never sends its leave; leaving for a node outside the panel ends the hover regardless.
      const into = event.relatedTarget;
      if (dragDepth.current === 0 || (into instanceof Node && !event.currentTarget.contains(into))) { dragDepth.current = 0; setDrop(null); }
    },
    onDrop(event: DragEvent) {
      if (!event.dataTransfer.types.includes('Files')) return;
      event.preventDefault();
      const files = [...event.dataTransfer.files];
      dragDepth.current = 0;
      setDrop(null);
      attach(files);
    },
  };
  const recovery = recoveryModel(view);
  const showPermissions = permissionState !== undefined && permissionsShown(permissionState);
  // Centre the composer only when nothing else can render in the column; when unsure, keep the normal layout.
  const empty = view.document.domain.messages.length === 0 && !view.document.domain.activities?.length && !continuation?.boundary &&
    Object.keys(view.document.decisions).length === 0 &&
    (!observationStatus || observationStatus.kind === 'not-applicable' || observationStatus.kind === 'observing') &&
    active.agent.availability.kind === 'ready' &&
    transcript.kind === 'default' && activity.kind === 'default' && contentLayout.kind === 'default' &&
    recovery.retained.length === 0 && recovery.uncertain.length === 0 && recovery.pending.length === 0 &&
    !customizationNotices && !showPermissions;

  const conversationKey = `${active.viewId}/${active.scope.hostId}/${active.scope.conversationId}`;
  const context = { conversation: active.scope, activity: view.document, commands: actions.commands, permissions: actions.permissions };
  const nativeMessages = <>
      {view.document.domain.messages.length === 0 && !view.document.domain.activities?.length && !continuation?.boundary && <p className="conversation-greeting">A conversation that stays with you.</p>}
      {view.document.domain.messages.map(message => <article className={`message message-${message.role}`} key={message.messageId}>
        <strong>{message.role === 'user' ? 'You' : presentation.assistant}</strong>
        {message.role === 'assistant' ? <AssistantReply text={message.text} /> : message.text && <p>{message.text}</p>}
        {message.image && <ImageAttachmentCard attachment={message.image} read={actions.readImage} />}
        {!message.complete && <span className="progress-label">{concluded ? 'Did not finish' : paused ? 'Updates paused' : agent === 'recorded' ? 'Recorded response in progress…' : 'Responding…'}</span>}
      </article>)}
    </>;
  const nativeActivity = <>
      <CommandActivity transcript={view.document.domain} connected={view.connection.kind === 'connected'} paused={paused} />
      <FileActivity transcript={view.document.domain} connected={view.connection.kind === 'connected'} paused={paused} />
    </>;
  const nativeTranscript = <div className="transcript" aria-label="Messages" aria-live="polite">{nativeMessages}{nativeActivity}</div>;
  const selectiveTranscript = <div className="transcript" aria-label="Messages" aria-live="polite">{nativeMessages}
    <CustomizationActivity selection={activity} conversationKey={conversationKey} fallback={nativeActivity}
      context={{ ...context, updates: paused ? 'paused' : view.connection.kind === 'connected' ? 'connected' : 'reconnecting' }} />
  </div>;

  return <section className="conversation-panel" aria-label="Conversation" data-empty={empty ? 'true' : undefined} {...dropHandlers}>
    <header className="visually-hidden"><p className="eyebrow">{agent === 'recorded' ? 'RECORDED CONVERSATION' : 'CONVERSATION'}</p><h1>Your conversation</h1><p className="agent-label">{active.agent.label}</p><p className="scope-label">{active.scope.conversationId}</p></header>
    {active.agent.availability.kind === 'unavailable' && <p role="status">{active.agent.availability.reason} Saved history remains available.</p>}
    {observationStatus?.kind === 'unknown' && <p role="status">Observation status unavailable. Reconnect to check for updates.</p>}
    {observationStatus?.kind === 'recovering' && <p role="status">Resuming provider updates…</p>}
    {observationStatus?.kind === 'stopped' && <div role="status" className="observation-notice">
      <p>Updates paused. {OBSERVATION_NOTICE[observationStatus.reason]} Saved messages and your draft remain available.{run && run.kind !== 'ended' ? ' The provider may still be running.' : ''}</p>
      {canRetryObservation(observationStatus) && <>
        <p>Checking for updates does not restart this request or resend commands.</p>
        <button type="button" disabled={!enabled || observation?.retrying}
          onClick={() => void actions.retryObservation()}>{observation?.retrying ? 'Checking for updates…' : 'Check for updates'}</button>
      </>}
    </div>}
    {observationStatus?.kind === 'concluded' && <div role="status" className="observation-notice">
      <p>This conversation ended: {CLOSURE_NOTICE[observationStatus.cause]}. Earlier messages and your draft stay available.</p>
      {continuation && <ContinuationChoices continuation={continuation} actions={actions} enabled={enabled && available} />}
    </div>}
    <CustomizationContent before={continuation && <ContinuationHistory continuation={continuation} actions={actions} enabled={enabled} assistant={presentation.assistant} />}
      selection={contentLayout} conversationKey={conversationKey} modules={modules} nativeTranscript={nativeTranscript}
      transcript={<CustomizationTranscript selection={transcript} conversationKey={conversationKey}
        context={context}
        fallback={transcript.kind === 'claimed' ? nativeTranscript : selectiveTranscript}
        appendix={sentImages.length > 0 && <section className="sent-images" aria-label="Sent images">
          <h2>Sent images</h2>{sentImages.map(sent => <ImageAttachmentCard key={sent.messageId} attachment={sent.image} read={actions.readImage} />)}
        </section>} />} />
    {Object.values(view.document.decisions).map(decision => <section className="decision-card" key={decision.pendingId} aria-label="Approval required">
      <h2>Approval required</h2><p>{decision.prompt}</p><div className="action-row">
        {decision.choices.map(choice => <button key={choice} disabled={!connected || !active.agent.commands.includes('approve') || decision.reserved || approving.has(decision.pendingId)} onClick={() => approve(decision.pendingId, choice)}>{decision.choiceLabels?.[choice] ?? (agent === 'codex' && choice === 'accept' ? 'Allow' : agent === 'codex' && choice === 'decline' ? 'Deny' : choice)}</button>)}
      </div>
    </section>)}
    {permissionState && showPermissions && <ConversationPermissions retained={recovery.retained} state={permissionState} actions={actions} enabled={connected} />}
    <form className="composer" data-drop={drop?.kind} onSubmit={event => { event.preventDefault(); if (canSend) void actions.submit(() => active.store.send()); }}>
      {drop && <p className="composer-drop-hint" aria-hidden="true">{drop.kind === 'reject' ? drop.reason : image ? `Drop to replace ${image.name}` : 'Drop to attach image'}</p>}
      {image && <div className="composer-image" aria-label="Attached image">
        <span>{image.name} · {imageSize(image.byteLength)}</span>
        <span role="status">{image.status === 'uploading' ? 'Uploading…' : image.status === 'ready' ? 'Ready' : image.status === 'interrupted' ? 'Upload interrupted' : image.reason}</span>
        {(image.status === 'failed' || image.status === 'interrupted') && <button type="button" disabled={!enabled}
          onClick={() => imageAction(() => active.store.retryImage())}>Retry</button>}
        <button type="button" className="composer-image-remove" aria-label="Remove" title="Remove image" disabled={Boolean(storageFailure)}
          onClick={() => { removals.current++; intaking.current = null; imageAction(() => active.store.removeImage()); }}><svg viewBox="0 0 12 12" aria-hidden="true"><path d="m3 3 6 6M9 3 3 9" /></svg></button>
      </div>}
      {image && !acceptsImages && <p className="composer-note">{active.agent.imageInput.kind === 'unsupported' ? active.agent.imageInput.reason : 'This agent cannot receive images.'} Remove the image to send.</p>}
      {imageError?.store === active.store && <p className="composer-note" role="alert">{imageError.message}</p>}
      <label htmlFor="message">Message</label>
      <textarea ref={composer} id="message" value={editor.text} onChange={event => void edit(event.target.value)} readOnly={Boolean(storageFailure)} placeholder={presentation.placeholder} rows={1} />
      {editor.kind === 'failed' && <p role={storageFailure ? 'note' : 'alert'}>Draft not saved. {storageFailure ? 'Copy your text before reloading.' : editor.message}</p>}
      <div className="composer-footer">
        {acceptsImages && <>
          <input ref={imageInput} type="file" accept="image/png,image/jpeg" aria-label="Image file" hidden onChange={event => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) attach([file]);
          }} />
          <button type="button" className="composer-setting composer-add" aria-label={image ? 'Replace image' : 'Add image'} title={blocked ?? 'Add image, or drop a PNG or JPEG'}
            disabled={Boolean(blocked)} onClick={() => imageInput.current?.click()}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10" /></svg></button>
        </>}
        {composerControls?.(enabled && editor.kind === 'saved' && !responding)}<div className="composer-send-actions">
        {run && run.kind !== 'ended' && !concluded && <button type="button" className="composer-setting" disabled={!connected || !active.agent.commands.includes('cancel') || stopping} onClick={stop}>{stopping ? 'Stopping…' : 'Stop'}</button>}
        <button className="composer-send" aria-label="Send" title="Send" disabled={!canSend}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" /></svg></button></div>
      </div>
    </form>
    <CommandRecovery view={view} actions={actions} enabled={enabled} canRetry={available} retry={id => active.store.retry(id)} />
  </section>;
}
