import { memo, useId, useMemo, useState } from 'react';
import type { DisplayPublication } from '@openpane/contracts';
import { metricsPanels } from './metrics-plot.js';

const dateTime = (milliseconds: number) => Number.isFinite(new Date(milliseconds).getTime()) ? new Date(milliseconds).toISOString() : undefined;
const time = (milliseconds: number) => dateTime(milliseconds) === undefined ? `${milliseconds} epoch ms` : new Date(milliseconds).toLocaleString();
const number = (value: number) => value.toLocaleString(undefined, { maximumSignificantDigits: 6 });
export const MetricsCard = memo(function MetricsCard({ publication }: { readonly publication: DisplayPublication }) {
  const card = publication.event.value, titleId = useId();
  const panels = useMemo(() => metricsPanels(card), [card]);
  const [valuesOpen, setValuesOpen] = useState(false);
  const points = card.series.reduce((total, series) => total + series.points.filter(point => point[1] !== null).length, 0);
  return <article className="metrics-card" data-openpane-part="card" data-publication-id={publication.publicationId} data-publication-digest={publication.digest} aria-labelledby={titleId}>
    <header className="metrics-card-title" data-openpane-part="card-title"><h2 id={titleId}>{card.title}</h2><span>OpenPane display data</span></header>
    <div className="metrics-card-toolbar" data-openpane-part="card-toolbar"><span>Datadog snapshot</span><time dateTime={dateTime(card.fetchedAtMs)}>Fetched {time(card.fetchedAtMs)}</time></div>
    <p className="metrics-card-summary" data-openpane-part="card-summary">{card.series.length} series · {points} values · {time(card.fromMs)} – {time(card.toMs)}. Gaps show missing values.</p>
    {!points && <p data-openpane-part="card-empty">The query succeeded with no values in this range.</p>}
    {panels.map((panel, panelIndex) => <section className="metrics-plot-frame" data-openpane-part="plot-frame" aria-label={`Plot: ${panel.unit ?? 'unit unspecified'}`} key={panelIndex}>
      <h3>{panel.unit ?? 'Unit unspecified'}</h3>
      <svg className="metrics-plot" data-openpane-part="plot" viewBox="0 0 600 190" role="img" aria-label={`${panel.unit ?? 'Unit unspecified'}: ${number(panel.minimum)} to ${number(panel.maximum)}. Read exact values in the table.`}>
        <g className="metrics-grid" data-openpane-part="plot-grid">{[24, 89, 154].map(y => <line key={y} x1="52" x2="580" y1={y} y2={y} />)}</g>
        <g className="metrics-axis" data-openpane-part="plot-axis"><path d="M52,24 V154 H580" /><text x="48" y="28" textAnchor="end">{number(panel.maximum)}</text><text x="48" y="154" textAnchor="end">{number(panel.minimum)}</text><text x="52" y="179">{new Date(panel.fromMs).toLocaleTimeString()}</text><text x="580" y="179" textAnchor="end">{new Date(panel.toMs).toLocaleTimeString()}</text></g>
        {panel.series.flatMap(series => series.paths.map((path, index) => <path className={`metrics-trace metrics-trace-${series.index + 1}`} data-openpane-part="plot-trace" key={`${series.index}:${index}`} d={path} />))}
      </svg>
      <ul className="metrics-legend" data-openpane-part="plot-legend">{panel.series.map(series => <li key={series.index}><span className={`metrics-legend-key metrics-trace-${series.index + 1}`} />{series.data.label}</li>)}</ul>
    </section>)}
    <details className="metrics-query" data-openpane-part="query-details"><summary>Query details</summary><code>{card.query}</code><p>Requested range: {time(card.fromMs)} – {time(card.toMs)}. Aligned returned buckets retain their original timestamps and values.</p><p>Saved display snapshot · {publication.publicationId}</p></details>
    <details className="metrics-values" onToggle={event => setValuesOpen(event.currentTarget.open)}><summary>Read values table</summary>{valuesOpen && <div className="metrics-table-scroll" tabIndex={0} role="region" aria-label="Metrics values"><table data-openpane-part="data-table"><caption>{card.title} — original values</caption><thead><tr><th scope="col">Series</th><th scope="col">Time</th><th scope="col">Value</th><th scope="col">Unit</th></tr></thead><tbody>{card.series.flatMap((series, index) => series.points.map(([timestamp, value]) => <tr key={`${index}:${timestamp}`}><th scope="row">{series.label}</th><td><time dateTime={dateTime(timestamp)}>{time(timestamp)}</time></td><td>{value === null ? 'Missing' : String(value)}</td><td>{series.unit ?? 'Unspecified'}</td></tr>))}</tbody></table></div>}</details>
  </article>;
});
