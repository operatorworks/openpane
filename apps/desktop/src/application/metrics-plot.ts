import type { MetricsCardV1 } from '@openpane/contracts';

type Series = MetricsCardV1['series'][number];
export interface MetricsPanel { readonly unit: string | null; readonly series: readonly { readonly data: Series; readonly index: number; readonly paths: readonly string[] }[]; readonly minimum: number; readonly maximum: number; readonly fromMs: number; readonly toMs: number }
/** Normalize before subtracting so even opposite finite extremes produce finite SVG coordinates. */
export function metricsPanels(card: MetricsCardV1): readonly MetricsPanel[] {
  const groups = new Map<string | null, { data: Series; index: number }[]>();
  card.series.forEach((data, index) => { const group = groups.get(data.unit) ?? []; group.push({ data, index }); groups.set(data.unit, group); });
  return [...groups].map(([unit, series]) => {
    let minimum = Infinity, maximum = -Infinity, fromMs = card.fromMs, toMs = card.toMs;
    for (const { data } of series) for (const [time, value] of data.points) {
      fromMs = Math.min(fromMs, time); toMs = Math.max(toMs, time);
      if (value !== null) { minimum = Math.min(minimum, value); maximum = Math.max(maximum, value); }
    }
    if (!Number.isFinite(minimum)) { minimum = 0; maximum = 0; }
    const scale = Math.max(Math.abs(minimum), Math.abs(maximum)) || 1;
    const low = minimum / scale, high = maximum / scale;
    return { unit, minimum, maximum, fromMs, toMs, series: series.map(({ data, index }) => {
      const paths: string[] = []; let path = '';
      for (const [time, value] of data.points) {
        if (value === null) { if (path) paths.push(path.includes(' L') ? path : `${path} L${path.slice(1)}`); path = ''; continue; }
        const x = 52 + (toMs === fromMs ? 0.5 : (time - fromMs) / (toMs - fromMs)) * 528;
        const y = 154 - (high === low ? 0.5 : (value / scale - low) / (high - low)) * 130;
        path += `${path ? ' L' : 'M'}${x.toFixed(3)},${y.toFixed(3)}`;
      }
      if (path) paths.push(path.includes(' L') ? path : `${path} L${path.slice(1)}`);
      return { data, index, paths };
    }) };
  });
}
