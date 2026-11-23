import { createElement, useState } from 'react';
import { EXTENSION_SDK_VERSION } from '@openpane/sdk';
import type { ConversationModuleProps, UiExtensionEntry, WorkspaceViewProps } from '@openpane/sdk/react';
import { Surface, Text } from '@openpane/ui-primitives/desktop';
import { reviewPrompt } from '../shared/prompts.js';
import './review.css';

function decisions({ activity }: ConversationModuleProps) {
  return activity.domain.messages.filter(message => message.role === 'assistant').flatMap(message =>
    message.text.split('\n').filter(line => /\?|\b(?:todo|decision|unresolved)\b/iu.test(line)));
}
function ReviewTranscript(props: ConversationModuleProps) {
  const unresolved = decisions(props);
  return <section aria-label="Review transcript">
    <Surface className="review-decisions"><Text as="h2">Unresolved decisions</Text>
      {unresolved.length ? <ul>{unresolved.map((line, index) => <li key={index}>{line}</li>)}</ul>
        : <Text>No unresolved decisions identified. Ask the agent to review the plan.</Text>}
    </Surface>
    {props.activity.domain.messages.length === 0 ? <Text>This review has no messages yet.</Text>
      : props.activity.domain.messages.map(message => <article key={message.messageId}>
        <Text as="h3">{message.role === 'user' ? 'You' : 'Agent'}</Text><p className="review-message">{message.text}</p>
      </article>)}
  </section>;
}
function ReviewWorkspace(props: WorkspaceViewProps) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  async function perform(action: () => ReturnType<WorkspaceViewProps['open']> | Promise<void>) {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await action();
      if (result?.kind === 'refused') setError(result.reason);
      else if (result?.kind === 'detached') setNotice('Review opened in its own window.');
    } catch { setError('Could not open this review. Retry, or check the host status above.'); } finally { setBusy(false); }
  }
  return <section aria-label="Plan review workspace" className="review-workspace">
    <header><Text as="h1">Plan review workspace</Text><p>Review decisions with your agent. Send, approvals, Stop and recovery stay in the host conversation.</p></header>
    {error && <p role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {props.conversations.loading && <p role="status">Loading reviews…</p>}
    <nav aria-label="Review conversations">
      {props.agents.map(agent => <button key={agent.id} disabled={busy || agent.availability.kind !== 'ready'}
        onClick={() => void perform(() => props.create(agent.id))}>Start review with {agent.label}</button>)}
      {props.conversations.entries.map(entry => <button key={entry.scope.conversationId} disabled={busy}
        onClick={() => void perform(() => props.open(entry.scope))}>{entry.preview ?? `Review ${entry.scope.conversationId.slice(-8)}`}</button>)}
      {props.conversations.hasMore && <button disabled={busy || props.conversations.loading} onClick={() => props.conversations.more()}>More reviews</button>}
      <button disabled={busy} onClick={() => void perform(() => props.refresh())}>Refresh reviews</button>
    </nav>
    <div className="review-conversation">{props.conversation ?? <p>Select a review, or start one with an available agent. This workspace needs a provider configured under its own namespace.</p>}</div>
  </section>;
}
function ReviewPlan(props: ConversationModuleProps) {
  const unresolved = decisions(props);
  return createElement(Surface, { className: 'review-plan' },
    createElement(Text, { as: 'h2' }, 'Plan review'),
    createElement(Text, null, 'Ask the current agent to review the plan and suggest a next step.'),
    createElement(Text, null, `${unresolved.length} possible unresolved decisions in this conversation.`));
}
function ReviewGuidance() {
  return createElement(Surface, null,
    createElement(Text, { as: 'h3' }, 'Review guidance'),
    createElement(Text, null, 'Follow the reply in this conversation. Your composer draft stays untouched.'));
}
export default {
  kind: 'desktop', sdkVersion: EXTENSION_SDK_VERSION,
  activate() {
    return {
      workspace: { label: 'Plan review workspace', component: ReviewWorkspace, transcript: ReviewTranscript },
      modules: [{ id: 'plan-review', label: 'Plan review', component: ReviewPlan,
        actions: [{ id: 'review', label: 'Review the plan', run: ({ commands }: ConversationModuleProps) => commands.send(reviewPrompt) }],
        children: [{ id: 'guidance', label: 'Review guidance', component: ReviewGuidance }] }],
      dispose() {},
    };
  },
} satisfies UiExtensionEntry<'desktop'>;
