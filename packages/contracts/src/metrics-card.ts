import { record, boundedText, count, utf8Bytes } from './decode.js';

export const METRICS_CARD_LIMITS = { bytes: 65_536, series: 8, points: 400, label: 200, query: 4096 } as const;
export const METRICS_EVENT_NAME = 'openpane.datadog.metrics.v1';
export interface MetricsCardV1 {
  readonly schemaVersion: 1;
  readonly title: string;
  readonly query: string;
  readonly fromMs: number;
  readonly toMs: number;
  readonly fetchedAtMs: number;
  readonly series: readonly {
    readonly label: string;
    readonly unit: string | null;
    readonly points: readonly (readonly [number, number | null])[];
  }[];
}
export function parseMetricsCard(value: unknown): MetricsCardV1 {
  const input = record(value, ['schemaVersion', 'title', 'query', 'fromMs', 'toMs', 'fetchedAtMs', 'series']);
  if (input.schemaVersion !== 1) throw new Error('Unsupported metrics schema version');
  const fromMs = count(input.fromMs), toMs = count(input.toMs);
  if (fromMs > toMs) throw new Error('Invalid metrics time range');
  if (!Array.isArray(input.series) || input.series.length > METRICS_CARD_LIMITS.series) throw new Error('Invalid metrics series');
  const card: MetricsCardV1 = {
    schemaVersion: 1, title: boundedText(input.title, 200), query: boundedText(input.query, METRICS_CARD_LIMITS.query),
    fromMs, toMs, fetchedAtMs: count(input.fetchedAtMs),
    series: input.series.map((value: unknown) => {
      const series = record(value, ['label', 'unit', 'points']);
      if (!Array.isArray(series.points) || series.points.length > METRICS_CARD_LIMITS.points) throw new Error('Invalid metrics points');
      let previous = -1;
      const points = series.points.map((value: unknown): readonly [number, number | null] => {
        if (!Array.isArray(value) || value.length !== 2) throw new Error('Invalid metrics point');
        const time = count(value[0]);
        if (time <= previous) throw new Error('Metrics timestamps must be strictly increasing epoch milliseconds');
        previous = time;
        const point: unknown = value[1];
        if (point !== null && (typeof point !== 'number' || !Number.isFinite(point))) throw new Error('Invalid metrics value');
        return [time, point];
      });
      return { label: boundedText(series.label, 200), unit: series.unit === null ? null : boundedText(series.unit, 200), points };
    }),
  };
  if (utf8Bytes(JSON.stringify(card)) > METRICS_CARD_LIMITS.bytes) throw new Error('Metrics card exceeds byte limit');
  return card;
}
const timestamp = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER } as const;
export const metricsCardSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', additionalProperties: false,
  required: ['schemaVersion', 'title', 'query', 'fromMs', 'toMs', 'fetchedAtMs', 'series'],
  properties: {
    schemaVersion: { const: 1 }, title: { type: 'string', minLength: 1, maxLength: 200 },
    query: { type: 'string', minLength: 1, maxLength: 4096 }, fromMs: timestamp, toMs: timestamp, fetchedAtMs: timestamp,
    series: { type: 'array', maxItems: 8, items: { type: 'object', additionalProperties: false,
      required: ['label', 'unit', 'points'], properties: {
        label: { type: 'string', minLength: 1, maxLength: 200 }, unit: { anyOf: [{ type: 'null' }, { type: 'string', minLength: 1, maxLength: 200 }] },
        points: { type: 'array', maxItems: 400, items: { type: 'array', minItems: 2, maxItems: 2,
          items: [timestamp, { type: ['number', 'null'] }], additionalItems: false } },
      } } },
  },
  $comment: 'Additionally enforce UTF-8 bytes <= 65536, fromMs <= toMs, finite values and strictly increasing timestamps. Times are epoch milliseconds; no implicit conversion.',
} as const;
