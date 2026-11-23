import { useLayoutEffect, useRef, useState } from 'react';
import type { ConversationScope } from '@openpane/contracts';
import { useDisplayView } from './display-state.js';
import { MetricsCard } from './MetricsCard.js';

export function useDisplayCards(scope: ConversationScope) {
  const { view, refresh } = useDisplayView(scope);
  const root = useRef<HTMLDivElement>(null), bottom = useRef(true), previous = useRef<Set<string> | null>(null);
  const [newCount, setNewCount] = useState(0), [announcement, setAnnouncement] = useState('');
  const publications = view.kind === 'none' ? null : view.publications;
  useLayoutEffect(() => {
    previous.current = null; setNewCount(0); setAnnouncement('');
    const scroll = root.current?.closest('.conversation-content');
    if (!(scroll instanceof HTMLElement)) return;
    const track = () => { bottom.current = scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop <= 48; if (bottom.current) setNewCount(0); };
    track(); scroll.addEventListener('scroll', track, { passive: true });
    return () => scroll.removeEventListener('scroll', track);
  }, [scope.hostId, scope.conversationId]);
  useLayoutEffect(() => {
    if (!publications || view.kind === 'loading') return;
    const known = previous.current, current = new Set(publications.map(publication => publication.publicationId));
    previous.current = current;
    if (!known) return;
    const added = [...current].filter(id => !known.has(id)).length;
    if (!added) return;
    if (bottom.current) {
      const scroll = root.current?.closest('.conversation-content');
      if (scroll instanceof HTMLElement) scroll.scrollTop = scroll.scrollHeight;
      setAnnouncement(`${added === 1 ? 'New card' : `${added} new cards`} added.`);
    } else setNewCount(count => count + added);
  }, [publications, view.kind]);
  const showNew = () => { const scroll = root.current?.closest('.conversation-content'); if (scroll instanceof HTMLElement) scroll.scrollTop = scroll.scrollHeight; setNewCount(0); };
  return { view, refresh, root, newCount, announcement, showNew };
}
type Cards = ReturnType<typeof useDisplayCards>;
export function DisplayCards({ cards }: { readonly cards: Cards }) {
  return <div ref={cards.root} className="display-cards" aria-label="Saved display cards">
    {cards.view.kind === 'unavailable' && <div role="status"><p>{cards.view.reason} Saved cards remain visible.</p><button type="button" onClick={cards.refresh}>Refresh cards</button></div>}
    {cards.view.kind !== 'none' && cards.view.publications.map(publication => <MetricsCard key={publication.publicationId} publication={publication} />)}
  </div>;
}
export function NewCardNotice({ cards }: { readonly cards: Cards }) {
  return <><span className="visually-hidden" role="status">{cards.announcement}</span>{cards.newCount > 0 && <div className="card-notice"><button type="button" onClick={cards.showNew}>{cards.newCount === 1 ? 'New card' : `${cards.newCount} new cards`} ↓</button></div>}</>;
}
