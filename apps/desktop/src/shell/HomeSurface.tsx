import type { ReactNode } from 'react';
import { type HomeComposition, type HomePaneKind } from '@openpane/contracts';
import './home.css';
import { homeLayout } from './home-layout.js';

export type MainDestination = 'home' | 'chats' | 'extensions' | 'settings';
const labels: Readonly<Record<HomePaneKind, string>> = { agents: 'Agents', conversations: 'Conversations', conversation: 'Conversation', extensions: 'Extensions', status: 'Status' };

export function HomeSurface({ composition, destination, panes }: {
  readonly composition: HomeComposition;
  readonly destination: MainDestination;
  readonly panes: Readonly<Record<HomePaneKind, ReactNode>>;
}) {
  const { order, visible, columns, placement, balance, gridTemplateRows } = homeLayout(composition, destination);
  return <section className="home-surface" data-openpane-part="home" data-home-destination={destination} data-home-columns={columns ? 'two' : 'one'} data-home-balance={balance} aria-label={destination === 'home' ? 'Home' : 'Chats'}>
    <h1 className="home-heading" tabIndex={-1} hidden={destination !== 'home'}>Home</h1>
    <div className="pane-host" style={{ gridTemplateRows: gridTemplateRows }}>
      {order.map(kind => <section key={kind} className="home-pane" role="group" data-openpane-part="pane" data-home-pane={kind}
        hidden={!visible.includes(kind)} aria-labelledby={`home-pane-${kind}`} style={columns ? placement(kind) : undefined}>
        <h2 id={`home-pane-${kind}`} data-openpane-essential="pane-heading" data-openpane-part="pane-heading" className="home-pane-heading">{labels[kind]}</h2>
        <div className="home-pane-body">{panes[kind]}</div>
      </section>)}
    </div>
  </section>;
}
