import { useLayoutEffect, useRef, useState } from 'react';
import type { ConversationScope } from '@openpane/contracts';
import { useDisplayView } from './display-state.js';
import { MetricsCard } from './MetricsCard.js';

export function useDisplayCards(scope: ConversationScope) {
  const { view, refresh } = useDisplayView(scope);
  const root = useRef<HTMLDivElement>(null), bottom = useRef(true), previous = useRef<Set<string> | null>(null);
  const unseen = useRef(new Set<string>()), announced = useRef(0);
  const [newCount, setNewCount] = useState(0), [announcement, setAnnouncement] = useState('');
  const publications = view.kind === 'none' ? null : view.publications;
  useLayoutEffect(() => {
    previous.current = null; unseen.current.clear(); announced.current = 0; setNewCount(0); setAnnouncement('');
    const cards = root.current, scroll = cards?.closest('.conversation-content');
    if (!(scroll instanceof HTMLElement)) return;
    const track = () => { if (!scroll.getClientRects().length || !scroll.clientHeight) return; bottom.current = scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop <= 48; if (bottom.current) { unseen.current.clear(); setNewCount(0); } };
    track(); scroll.addEventListener('scroll', track, { passive: true });
    const resize = new ResizeObserver(track); resize.observe(scroll);
    if (cards) { resize.observe(cards); cards.addEventListener('toggle', track, true); }
    return () => { scroll.removeEventListener('scroll', track); cards?.removeEventListener('toggle', track, true); resize.disconnect(); };
  }, [scope.hostId, scope.conversationId]);
  useLayoutEffect(() => {
    if (!publications || view.kind === 'loading') return;
    const known = previous.current, current = new Set(publications.map(publication => publication.publicationId));
    previous.current = current;
    if (!known) {
      if (bottom.current) { const scroll = root.current?.closest('.conversation-content'); if (scroll instanceof HTMLElement) scroll.scrollTop = scroll.scrollHeight; }
      return;
    }
    unseen.current = new Set([...unseen.current].filter(id => current.has(id)));
    const additions = [...current].filter(id => !known.has(id)), added = additions.length;
    if (!added) { setNewCount(unseen.current.size); return; }
    const visibleScroll = root.current?.closest('.conversation-content');
    if (bottom.current && visibleScroll instanceof HTMLElement && visibleScroll.getClientRects().length && visibleScroll.clientHeight) {
      const scroll = visibleScroll;
      if (scroll instanceof HTMLElement) scroll.scrollTop = scroll.scrollHeight;
      announced.current += added;
      setAnnouncement(`${added === 1 ? 'New card' : `${added} new cards`} added. ${announced.current} received in this chat.`);
    } else { for (const id of additions) unseen.current.add(id); setNewCount(unseen.current.size); }
  }, [publications, view.kind]);
  const showNew = () => { const scroll = root.current?.closest('.conversation-content'); if (scroll instanceof HTMLElement) scroll.scrollTop = scroll.scrollHeight; unseen.current.clear(); setNewCount(0); };
  return { view, refresh, root, newCount, announcement, showNew };
}
type Cards = ReturnType<typeof useDisplayCards>;
export function DisplayCards({ cards }: { readonly cards: Cards }) {
  return <div ref={cards.root} className="display-cards" aria-label="Saved display cards">
    {cards.view.kind === 'unavailable' && <div data-openpane-part="status" role="status"><p>{cards.view.reason}{cards.view.publications.length > 0 ? ' Saved cards remain visible.' : ''}</p><button data-openpane-part="button" type="button" onClick={cards.refresh}>Refresh cards</button></div>}
    {cards.view.kind !== 'none' && cards.view.publications.map(publication => <MetricsCard key={publication.publicationId} publication={publication} />)}
  </div>;
}
export function NewCardNotice({ cards }: { readonly cards: Cards }) {
  return <><span data-openpane-part="status" className="visually-hidden" role="status">{cards.announcement}</span>{cards.newCount > 0 && <div className="card-notice"><button data-openpane-part="button" type="button" onClick={cards.showNew}>{cards.newCount === 1 ? 'New card' : `${cards.newCount} new cards`} ↓</button></div>}</>;
}
