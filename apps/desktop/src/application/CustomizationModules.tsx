import { customizationMessage as message } from './customization-message.js';
import { BuiltinColors } from './BuiltinColors.js';
import { Suspense, useEffect, useRef, useState } from 'react';
import { useConversation } from '@openpane/client/react';
import type { ConversationModule, ConversationModuleProps, ModuleAction } from '@openpane/sdk/react';
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

function ConversationModuleAction({ action, context }: { readonly action: ModuleAction; readonly context: ConversationModuleProps }) {
  const owner = useRef({ mounted: true, pending: false });
  const [state, setState] = useState<{ readonly kind: 'idle' | 'pending' } | { readonly kind: 'settled'; readonly message: string }>({ kind: 'idle' });
  useEffect(() => {
    const current = owner.current;
    current.mounted = true;
    return () => { current.mounted = false; };
  }, []);
  async function run() {
    const current = owner.current;
    if (current.pending) return;
    current.pending = true;
    setState({ kind: 'pending' });
    try {
      const result = await action.run(context);
      if (current.mounted) setState({ kind: 'settled', message: actionOutcome(result) });
    } catch (error) {
      if (current.mounted) setState({ kind: 'settled', message: `Action failed. ${message(error)} Check conversation recovery before trying again.` });
    } finally {
      current.pending = false;
    }
  }
  return <div>
    <Button disabled={state.kind === 'pending'} aria-busy={state.kind === 'pending'} onClick={() => void run()}>{action.label}</Button>
    <p role="status" aria-label={`${action.label} status`}>{state.kind === 'pending' ? 'Submitting…' : state.kind === 'settled' ? state.message : ''}</p>
  </div>;
}

function ConversationModuleView({ module, context }: { readonly module: ConversationModule; readonly context: ConversationModuleProps }) {
  const View = module.component;
  return <section aria-label={module.label}>
    <View {...context} />
    {module.actions?.map(action => <ConversationModuleAction key={action.id} action={action} context={context} />)}
    {module.children?.map(child => <ConversationModuleView key={child.id} module={child} context={context} />)}
  </section>;
}

function ConversationModules({ modules, active, actions, enabled, agent }: {
  readonly modules: readonly ConversationModule[]; readonly active: OpenConversation; readonly actions: ConversationActions;
  readonly enabled: boolean; readonly agent: string;
}) {
  const view = useConversation(active.store);
  if (modules.length === 0) return null;
  const context: ConversationModuleProps = { conversation: active.scope, activity: view.document, commands: actions.commands, permissions: actions.permissions };
  const available = enabled && active.agent.availability.kind === 'ready' && active.agent.commands.includes('send') && view.connection.kind === 'connected' && !conversationResponding(agent, view.document.domain);
  return <fieldset disabled={!available} className="customization-modules">
    <legend>Custom tools</legend>
    {!available && <p>Available when this conversation is connected and ready.</p>}
    {modules.map(module => <ConversationModuleView key={module.id} module={module} context={context} />)}
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
        <ConversationModules modules={owner.presentation.modules} active={active} actions={actions} enabled={enabled} agent={agent} />
      </CustomizationBoundary>
    </Suspense>}
  </aside>;
}
