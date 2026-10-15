import { describe, expect, it, vi } from 'vitest';
import { normalizeConfig } from '../../src/config';
import { attributeSeriesPoints, listPoints } from '../../src/data/list';
import { LiveBuffer } from '../../src/data/live';
import { loadSeriesData } from '../../src/data/loader';
import type { CardConfig, HassEntityState, HomeAssistant, NormalizedSeries, SeriesConfig } from '../../src/types';

const M = 60_000;
const H = 60 * M;
const NOW = Date.parse('2026-10-15T10:10:00Z'); // 12:10 in Berlin
const MIDNIGHT = Date.parse('2026-10-14T22:00:00Z'); // 00:00 in Berlin
const iso = (t: number): string => new Date(t).toISOString();

function seriesOf(s: Omit<SeriesConfig, 'entity'> & { entity?: string }, card: Partial<CardConfig> = {}): NormalizedSeries {
  const cfg = normalizeConfig({ type: 'custom:echart-graph-card', ...card, series: [{ entity: 'sensor.forecast', ...s }] } as CardConfig);
  return cfg.series[0];
}

function st(attributes: Record<string, unknown>, updated = NOW - M, entity_id = 'sensor.forecast'): HassEntityState {
  return { entity_id, state: '9.8', attributes, last_changed: iso(updated), last_updated: iso(updated) };
}

function hassWith(states: HassEntityState[]): HomeAssistant {
  return {
    states: Object.fromEntries(states.map((s) => [s.entity_id, s])),
    callWS: vi.fn(async () => ({})),
    connection: { subscribeMessage: vi.fn() },
    locale: { language: 'en', time_zone: 'server', number_format: 'language' },
    config: { time_zone: 'Europe/Berlin' },
    themes: { darkMode: false },
  } as unknown as HomeAssistant;
}

/** A Solcast-like detailedForecast: 48 half hours from local midnight, kW. */
function solcast(f: (i: number) => number): Array<Record<string, unknown>> {
  return Array.from({ length: 48 }, (_, i) => ({
    period_start: iso(MIDNIGHT + i * 30 * M),
    pv_estimate: f(i),
    pv_estimate10: f(i) * 0.6,
    pv_estimate90: f(i) * 1.2,
  }));
}

describe('listPoints', () => {
  const s = seriesOf({ attribute: 'detailedForecast', value_key: 'pv_estimate' });

  it('reads one point per item, timestamps from the first known time key', () => {
    const { points, error } = listPoints(st({ detailedForecast: solcast((i) => i / 10) }), s);
    expect(error).toBeUndefined();
    expect(points).toHaveLength(48);
    expect(points[0]).toEqual([MIDNIGHT, 0]);
    expect(points[3]).toEqual([MIDNIGHT + 90 * M, 0.3]);
  });

  it('accepts epoch seconds / ms and numeric strings, sorts and de-duplicates (later item wins)', () => {
    const t = MIDNIGHT / 1000;
    const list = [
      { start: t + 3600, price: '0.31' },
      { start: MIDNIGHT, price: 0.3 },
      { start: String(t + 3600), price: 0.32 },
      { start: 'not a time', price: 9 },
      { start: t + 7200, price: 'unavailable' },
    ];
    const { points } = listPoints(st({ prices: list }), seriesOf({ attribute: 'prices', value_key: 'price' }));
    expect(points).toEqual([
      [MIDNIGHT, 0.3],
      [MIDNIGHT + H, 0.32],
      [MIDNIGHT + 2 * H, null],
    ]);
  });

  it('uses an explicit time_key', () => {
    const list = [{ at: iso(MIDNIGHT), start: 'ignored', v: 1 }];
    const { points } = listPoints(st({ l: list }), seriesOf({ attribute: 'l', value_key: 'v', time_key: 'at' }));
    expect(points).toEqual([[MIDNIGHT, 1]]);
  });

  it('explains why there are no points', () => {
    expect(listPoints(undefined, s).error).toBe('Entity not found: sensor.forecast');
    expect(listPoints(st({}), s).error).toMatch(/no list attribute "detailedForecast"$/);
    expect(listPoints(st({ detailedForecast: 'x' }), s).error).toMatch(/\(it is not a list\)/);
    expect(listPoints(st({ detailedForecast: [{ when: 1, pv_estimate: 1 }] }), s).error).toMatch(/no time key found.*time_key/);
    expect(listPoints(st({ detailedForecast: [{ period_start: iso(NOW), other: 1 }] }), s).error).toMatch(/have no "pv_estimate"/);
    expect(listPoints(st({ detailedForecast: [] }), s)).toEqual({ points: [] });
  });
});

describe('attributeSeriesPoints', () => {
  it('applies transform and group_by (30-min kW -> hourly kWh) and finds the bucket covering now', () => {
    const s = seriesOf({ attribute: 'detailedForecast', value_key: 'pv_estimate', group_by: { func: 'avg', duration: '1h' }, transform: { multiply: 2 } });
    const hass = hassWith([st({ detailedForecast: solcast((i) => (i % 2 ? 1 : 0.5)) })]);
    const r = attributeSeriesPoints(s, hass, MIDNIGHT, NOW, 'Europe/Berlin');
    expect(r.points).toHaveLength(24);
    expect(r.points[0]).toEqual([MIDNIGHT, 1.5]); // (0.5 + 1) / 2 * 2
    expect(r.latest).toBe(1.5);
    expect(r.error).toBeUndefined();
  });

  it('latest is undefined for a missing entity and null before the first item', () => {
    const s = seriesOf({ attribute: 'detailedForecast', value_key: 'pv_estimate' });
    expect(attributeSeriesPoints(s, hassWith([]), MIDNIGHT, NOW, undefined).latest).toBeUndefined();
    const late = [{ period_start: iso(NOW + H), pv_estimate: 1 }];
    expect(attributeSeriesPoints(s, hassWith([st({ detailedForecast: late })]), MIDNIGHT, NOW, undefined).latest).toBeNull();
  });
});

describe('loadSeriesData (list attribute series)', () => {
  const cfg = normalizeConfig({
    type: 'custom:echart-graph-card',
    span: { start: 'day' },
    series: [
      { entity: 'sensor.forecast', attribute: 'detailedForecast', value_key: 'pv_estimate10', unit: 'kWh', name: 'P10' },
      { entity: 'sensor.forecast', attribute: 'detailedForecast', value_key: 'pv_estimate90', unit: 'kWh' },
      { entity: 'sensor.forecast', attribute: 'missing', value_key: 'x' },
    ],
  });

  it('reads them from hass.states without any WebSocket call for them', async () => {
    const hass = hassWith([st({ friendly_name: 'Forecast today', detailedForecast: solcast(() => 1) })]);
    const data = await loadSeriesData(hass, cfg, new Date(NOW));
    const calls = (hass.callWS as ReturnType<typeof vi.fn>).mock.calls.map((c) => (c[0] as { type: string; entity_ids?: string[] }));
    expect(calls.filter((c) => c.type === 'history/history_during_period' && (c.entity_ids ?? []).length > 0)).toHaveLength(0);
    expect(data.map((d) => d.source)).toEqual(['attribute', 'attribute', 'attribute']);
    expect(data[0]).toMatchObject({ name: 'P10', unit: 'kWh', isBinary: false, latest: 0.6 });
    expect(data[0].points).toHaveLength(48);
    expect(data[1]).toMatchObject({ name: 'Forecast today', latest: 1.2 });
    expect(data[0].points).not.toBe(data[1].points);
    expect(data[2].error).toMatch(/no list attribute "missing"/);
  });
});

describe('LiveBuffer (list attribute series)', () => {
  it('re-reads the list on every change of the entity, with a new points array', async () => {
    const cfg = normalizeConfig({
      type: 'custom:echart-graph-card',
      series: [{ entity: 'sensor.forecast', attribute: 'detailedForecast', value_key: 'pv_estimate' }],
    });
    const hass1 = hassWith([st({ detailedForecast: solcast(() => 1) })]);
    const data = await loadSeriesData(hass1, cfg, new Date(NOW));
    const buf = new LiveBuffer();
    buf.reset(data, hass1);
    const before = data[0].points;

    expect(buf.append(hass1)).toBe(false);
    const hass2 = hassWith([st({ detailedForecast: solcast(() => 2) }, NOW)]);
    expect(buf.append(hass2)).toBe(true);
    expect(data[0].points).not.toBe(before);
    expect(data[0].points.every((p) => p[1] === 2)).toBe(true);

    const hass3 = hassWith([st({}, NOW + M)]);
    expect(buf.append(hass3)).toBe(true);
    expect(data[0].points).toEqual([]);
    expect(data[0].error).toMatch(/no list attribute/);
  });
});
