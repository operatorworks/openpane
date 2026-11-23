import type { AgentDescriptor } from '@openpane/contracts/service';
import type { ReactNode } from 'react';

export function AgentsPane({ agents, enabled, onCreate }: {
  readonly agents: readonly Pick<AgentDescriptor, 'id' | 'label' | 'availability'>[];
  readonly enabled: boolean;
  readonly onCreate: (id: string) => void;
}) {
  return <div className="home-agents">
    {agents.length === 0 && <p data-openpane-part="status">No agents are available on this host.</p>}
    {agents.map((agent, index) => <div key={agent.id} className="home-agent-row">
      <button type="button" data-openpane-essential="agent" data-openpane-part="button" data-openpane-role="agent-row" disabled={!enabled || agent.availability.kind !== 'ready'}
        aria-describedby={`home-agent-status-${index}`} onClick={() => onCreate(agent.id)}>{agent.label}</button>
      <span id={`home-agent-status-${index}`} data-openpane-part="status">{agent.availability.kind === 'ready' ? 'Available' : agent.availability.reason}</span>
    </div>)}
  </div>;
}

export function StatusPane({ host, conversation, build }: { readonly host: ReactNode; readonly conversation: string; readonly build: string }) {
  return <div className="home-status" data-openpane-part="status">{host}<p>{conversation}</p><p>{build}</p></div>;
}
