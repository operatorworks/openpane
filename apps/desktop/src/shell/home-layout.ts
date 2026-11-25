import { HOME_PANE_KINDS, homePaneOrder, type HomeComposition, type HomePaneKind } from '@openpane/contracts';
import type { CSSProperties } from 'react';
import type { MainDestination } from './HomeSurface.js';

export function homeLayout(composition: HomeComposition, destination: MainDestination) {
  const declared = homePaneOrder(composition);
  const order = [...declared, ...HOME_PANE_KINDS.filter(kind => !declared.includes(kind))];
  const visible = destination === 'home' ? declared : order.filter(kind => kind === 'conversations' || kind === 'conversation');
  const primary = destination === 'home' && composition.kind === 'columns' ? composition.primary : visible;
  const secondary = destination === 'home' && composition.kind === 'columns' ? composition.secondary : [];
  const columns = destination === 'home' ? composition.kind === 'columns' : true;
  const rows = Math.max(primary.length, secondary.length);
  const placement = (kind: HomePaneKind): CSSProperties => {
    if (!columns) return {};
    if (destination !== 'home') return { gridColumn: visible.indexOf(kind) + 1, gridRow: 1 };
    const column = primary.includes(kind) ? primary : secondary;
    const index = column.indexOf(kind);
    return { gridColumn: primary.includes(kind) ? 1 : 2, gridRow: `${index + 1} / span ${index === column.length - 1 ? rows - index : 1}` };
  };
  const balance = destination === 'home' && composition.kind === 'columns' ? composition.balance
    : visible[0] === 'conversation' ? 'primary-wide' : 'secondary-wide';
  return {
    order,
    surface: { 'data-home-destination': destination, 'data-home-columns': columns ? 'two' : 'one', 'data-home-balance': balance, 'aria-label': destination === 'home' ? 'Home' : 'Chats' },
    heading: { hidden: destination !== 'home' },
    hostStyle: { gridTemplateRows: `repeat(${columns ? destination === 'home' ? rows : 1 : visible.length}, minmax(0, 1fr))` },
    pane: (kind: HomePaneKind) => {
      const style = placement(kind);
      return { hidden: !visible.includes(kind), style: { gridColumn: String(style.gridColumn ?? ''), gridRow: String(style.gridRow ?? '') } };
    },
  };
}
