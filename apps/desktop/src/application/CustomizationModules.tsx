import { customizationMessage as message } from './customization-message.js';
import { BuiltinColors } from './BuiltinColors.js';
import { Suspense, useSyncExternalStore } from 'react';
import { useConversation } from '@openpane/client/react';
import type { ConversationModule, ConversationModuleProps, ModuleAction } from '@openpane/sdk/react';
import type { FrontendToolGeneration } from '@openpane/sdk/tools';
import type { SubmitResult } from '@openpane/contracts';
import { Button } from '@openpane/ui-primitives/desktop';
import { refusalMessage } from './application-controller.js';
import type { ConversationActions, OpenConversation } from './application-controller.js';
import { conversationResponding } from './responding.js';
import { CustomizationBoundary, type NamespaceActivation } from './DesktopCustomizations.js';

function actionOutcome(result: SubmitResult): string {
  if (result.kind === 'rejected') return `Submission rejected. ${refusalMessage(result.reason)}`;
  const state = result.receipt.state;
  switch (state.kind) {
    case 'pending': return 'Submission pending. Follow its progress in the conversation.';
    case 'accepted': return 'Submitted. Follow the response in the conversation.';
    case 'completed': return 'Command completed. Follow the response in the conversation.';
    case 'rejected': return `Submission rejected. ${state.reason}`;
    case 'not-dispatched': return `Not dispatched. ${state.reason}`;
    case 'uncertain': return `Submission uncertain. ${state.reason} Use the conversation recovery controls before trying again.`;
    case 'abandoned': return 'Stopped waiting. Whether this command ran is unknown.';
    default: { const exhaustive: never = state; return exhaustive; }
  }
}

type ActionSnapshot = { readonly kind: 'idle' | 'pending' } | { readonly kind: 'settled'; readonly message: string };
function createActionOwner() {
  let snapshot: ActionSnapshot = { kind: 'idle' };
  const listeners = new Set<() => void>();
  const publish = (value: ActionSnapshot) => { snapshot = value; listeners.forEach(notify => notify()); };
  return {
    getSnapshot: () => snapshot,
    subscribe(notify: () => void) { listeners.add(notify); return () => { listeners.delete(notify); }; },
    async run(action: ModuleAction, context: ConversationModuleProps) {
      if (snapshot.kind === 'pending') return;
      publish({ kind: 'pending' });
      let settled: string;
      try { settled = actionOutcome(await action.run(context)); }
      catch (error) { settled = `Action failed. ${message(error)} Check conversation recovery before trying again.`; }
      publish({ kind: 'settled', message: settled });
    },
  };
}
type ActionOwner = ReturnType<typeof createActionOwner>;
// Generation and conversation-store identity own actions independently of their presentation's mount position.
const actionOwners = new WeakMap<FrontendToolGeneration, WeakMap<OpenConversation['store'], Map<string, ActionOwner>>>();
function conversationActions(generation: FrontendToolGeneration, store: OpenConversation['store']): Map<string, ActionOwner> {
  let conversations = actionOwners.get(generation);
  if (!conversations) { conversations = new WeakMap(); actionOwners.set(generation, conversations); }
  let actions = conversations.get(store);
  if (!actions) { actions = new Map(); conversations.set(store, actions); }
  return actions;
}
function actionOwner(actions: Map<string, ActionOwner>, path: readonly string[]): ActionOwner {
  const key = JSON.stringify(path);
  let owner = actions.get(key);
  if (!owner) { owner = createActionOwner(); actions.set(key, owner); }
  return owner;
}

function ConversationModuleAction({ action, context, owner }: {
  readonly action: ModuleAction; readonly context: ConversationModuleProps; readonly owner: ActionOwner;
}) {
  const state = useSyncExternalStore(owner.subscribe, owner.getSnapshot, owner.getSnapshot);
  return <div>
    <Button disabled={state.kind === 'pending'} aria-busy={state.kind === 'pending'} onClick={() => void owner.run(action, context)}>{action.label}</Button>
    <p role="status" aria-label={`${action.label} status`}>{state.kind === 'pending' ? 'Submitting…' : state.kind === 'settled' ? state.message : ''}</p>
  </div>;
}

function ConversationModuleView({ module, context, actions, path }: {
  readonly module: ConversationModule; readonly context: ConversationModuleProps;
  readonly actions: Map<string, ActionOwner>; readonly path: readonly string[];
}) {
  const View = module.component;
  return <section aria-label={module.label}>
    <View {...context} />
    {module.actions?.map(action => <ConversationModuleAction key={action.id} action={action} context={context} owner={actionOwner(actions, [...path, action.id])} />)}
    {module.children?.map(child => <ConversationModuleView key={child.id} module={child} context={context} actions={actions} path={[...path, child.id]} />)}
  </section>;
}

function ConversationModules({ owner, active, actions, enabled, agent }: {
  readonly owner: Extract<NamespaceActivation, { readonly kind: 'ready' }>; readonly active: OpenConversation; readonly actions: ConversationActions;
  readonly enabled: boolean; readonly agent: string;
}) {
  const view = useConversation(active.store);
  const modules = owner.presentation.modules;
  const actionStates = conversationActions(owner.generation, active.store);
  if (modules.length === 0) return null;
  const context: ConversationModuleProps = { conversation: active.scope, activity: view.document, commands: actions.commands, permissions: actions.permissions };
  const available = enabled && active.agent.availability.kind === 'ready' && active.agent.commands.includes('send') && view.connection.kind === 'connected' && !conversationResponding(agent, view.document.domain);
  return <fieldset disabled={!available} className="customization-modules">
    <legend>Custom tools</legend>
    {!available && <p>Available when this conversation is connected and ready.</p>}
    {modules.map(module => <ConversationModuleView key={module.id} module={module} context={context} actions={actionStates} path={[module.id]} />)}
  </fieldset>;
}

/**
 * Where a namespace's tools render. `status` is the conversation column: only loading and failure notices.
 * `tools` is the Extensions view: only runnable modules. `all` is a claimed content layout: both.
 */
export type ModuleSurface = 'status' | 'tools' | 'all';

export function CustomizationModules({ owner, active, actions, enabled, agent, surface }: {
  readonly owner: NamespaceActivation; readonly active: OpenConversation | null;
  readonly actions: ConversationActions | null; readonly enabled: boolean; readonly agent: string;
  readonly surface: ModuleSurface;
}) {
  const notice = owner.kind === 'loading' || owner.kind === 'failed';
  const tools = owner.kind === 'ready' && owner.presentation.modules.length > 0;
  const label = `Customization ${owner.namespace}`;
  if (surface === 'tools') { if (!tools) return null; }
  else if (surface === 'status' ? !notice : !notice && !tools) {
    // Nothing to show, but the activation state stays readable (the customization qualifier checks it): no box, no landmark.
    return <aside hidden aria-label={label} data-customization-namespace={owner.namespace} data-customization-state={owner.kind} />;
  }
  return <aside className="customization-panel" aria-label={`Customization ${owner.namespace}`}
    data-customization-namespace={owner.namespace} data-customization-state={owner.kind}>
    {owner.kind === 'loading' && <BuiltinColors><p role="status">Loading custom tools…</p></BuiltinColors>}
    {owner.kind === 'failed' && <BuiltinColors><p role="alert">Custom tools could not load. {owner.message} Use Restore default view to continue without them.</p></BuiltinColors>}
    {owner.kind === 'ready' && active && actions && <Suspense fallback={<BuiltinColors><p role="status">Loading custom tools…</p></BuiltinColors>}>
      <CustomizationBoundary key={`${owner.lifetime}/${active.viewId}/${active.scope.hostId}/${active.scope.conversationId}`} fail={owner.fail} fallback={null}>
        <ConversationModules owner={owner} active={active} actions={actions} enabled={enabled} agent={agent} />
      </CustomizationBoundary>
    </Suspense>}
  </aside>;
}
