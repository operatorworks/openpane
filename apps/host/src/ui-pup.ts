import { METRICS_CARD_LIMITS, parseMetricsCard } from '@openpane/contracts';
import type { MetricsCardV1 } from '@openpane/contracts';
import { boundedText, count, record } from '@openpane/contracts/decode';

export interface PupRange { readonly fromSeconds: number; readonly toSeconds: number }
export function resolvePupRange(from: string, to: string, nowMs: number): PupRange {
  const now = Math.floor(nowMs / 1000);
  const resolve = (input: string): number => {
    if (input === 'now') return now;
    if (/^\d+$/.test(input)) return count(Number(input));
    const relative = /^(\d+)([mhd])$/.exec(input);
    if (!relative) throw new Error('Use now, whole epoch seconds, or a relative range such as 1h');
    const amount = Number(relative[1]), unit = relative[2];
    return count(now - amount * (unit === 'm' ? 60 : unit === 'h' ? 3600 : 86400));
  };
  const fromSeconds = resolve(from), toSeconds = resolve(to);
  if (fromSeconds >= toSeconds || toSeconds > Math.floor(Number.MAX_SAFE_INTEGER / 1000)) throw new Error('Invalid metrics query range');
  return { fromSeconds, toSeconds };
}

/** Qualified pup 1.23.6 and 2.0.1 both return raw Datadog v1 time series. */
export function normalizePup(input: unknown, query: string, title: string, range: PupRange, fetchedAtMs: number): MetricsCardV1 {
  const response = record(input);
  if (response.status !== 'ok' || response.resp_version !== 1 || response.res_type !== 'time_series' || !Array.isArray(response.series)) {
    throw new Error('Unsupported pup response schema: expected raw Datadog v1 time_series success');
  }
  if (response.series.length > METRICS_CARD_LIMITS.series) throw new Error('Metrics response exceeds the series limit');
  const fromMs = range.fromSeconds * 1000, toMs = range.toSeconds * 1000;
  if (response.query !== query || count(response.from_date) !== fromMs || count(response.to_date) !== toMs) throw new Error('Pup response does not match the reserved query and range');
  return parseMetricsCard({ schemaVersion: 1, title, query, fromMs: range.fromSeconds * 1000, toMs: range.toSeconds * 1000, fetchedAtMs,
    series: response.series.map((value: unknown) => {
      const series = record(value);
      const start = count(series.start), end = count(series.end);
      if (start > end || !count(series.interval) || !Array.isArray(series.pointlist) || series.pointlist.length !== count(series.length) || series.pointlist.length > METRICS_CARD_LIMITS.points) throw new Error('Invalid pup v1 series metadata');
      const bucketMs = count(series.interval) * 1000;
      if (start < fromMs - bucketMs || end > toMs + bucketMs || start > toMs || end < fromMs) throw new Error('Pup series is outside the reserved range');
      for (const point of series.pointlist) {
        if (!Array.isArray(point) || point.length !== 2 || count(point[0]) < start || count(point[0]) > end) throw new Error('Pup v1 point timestamp disagrees with its epoch-millisecond series bounds');
      }
      if (!Array.isArray(series.unit) || series.unit.length !== 2) throw new Error('Unsupported pup v1 unit metadata');
      const unitLabel = (value: unknown): string | null => {
        if (value === null) return null;
        const unit = record(value);
        if (typeof unit.family !== 'string' || !Number.isSafeInteger(unit.id) || typeof unit.name !== 'string' || typeof unit.plural !== 'string' || typeof unit.scale_factor !== 'number' || !Number.isFinite(unit.scale_factor) || unit.scale_factor <= 0 || typeof unit.short_name !== 'string') throw new Error('Unsupported pup v1 unit metadata');
        return boundedText(unit.short_name.length ? unit.short_name : unit.name, 200);
      };
      const numerator = unitLabel(series.unit[0]), denominator = unitLabel(series.unit[1]);
      const unit = denominator === null ? numerator : numerator === null ? `per ${denominator}` : `${numerator}/${denominator}`;
      return { label: boundedText(series.display_name, 200), unit, points: series.pointlist };
    }),
  });
}
