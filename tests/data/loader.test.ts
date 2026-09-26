import { describe, expect, it, vi } from 'vitest';
import { normalizeConfig } from '../../src/config';
import { LiveBuffer } from '../../src/data/live';
import { loadSeriesData } from '../../src/data/loader';
import type {
  CardConfig,
  HassEntityState,
  HassMessage,
  HistoryResponse,
  HistoryState,
  HomeAssistant,
  StatisticsResponse,
  StatisticValue,
} from '../../src/types';

const M = 60_000;
const H = 60 * M;
const D = 24 * H;
const NOW = new Date('2026-09-26T12:00:00Z');
const NOW_MS = NOW.getTime();
const ms = (iso: string): number => Date.parse(iso);
const sec = (t: number): number => t / 1000;

interface Backend {
  history?: Record<string, HistoryState[]>;
  statistics?: Record<string, StatisticValue[]>;
  metadata?: unknown[];
  fail?: string;
}

function makeHass(states: HassEntityState[], backend: Backend = {}) {
  const calls: HassMessage[] = [];
  const callWS = vi.fn(async (msg: HassMessage) => {
    calls.push(msg);
    if (backend.fail && msg.type === backend.fail) throw new Error(`${msg.type} failed`);
    switch (msg.type) {
      case 'history/history_during_period': {
        const ids = msg.entity_ids as string[];
        const res: HistoryResponse = {};
        for (const id of ids) if (backend.history?.[id]) res[id] = backend.history[id];
        return res;
      }
      case 'recorder/statistics_during_period': {
        const ids = msg.statistic_ids as string[];
        const res: StatisticsResponse = {};
        for (const id of ids) if (backend.statistics?.[id]) res[id] = backend.statistics[id];
        return res;
      }
      case 'recorder/get_statistics_metadata':
        return backend.metadata ?? [];
      default:
        throw new Error(`unexpected ${msg.type}`);
    }
  });
  const hass = {
    states: Object.fromEntries(states.map((s) => [s.entity_id, s])),
    callWS,
    connection: { subscribeMessage: vi.fn() },
    locale: { language: 'en', time_zone: 'server', number_format: 'language' },
    config: { time_zone: 'Europe/Berlin' },
    themes: { darkMode: false },
  } as unknown as HomeAssistant;
  const ofType = (type: string) => calls.filter((c) => c.type === type);
  return { hass, calls, ofType };
}

function st(entity_id: string, state: string, attributes: Record<string, unknown> = {}, changed = NOW_MS - M): HassEntityState {
  return { entity_id, state, attributes, last_changed: new Date(changed).toISOString(), last_updated: new Date(changed).toISOString() };
}

const cfgOf = (c: Partial<CardConfig>) => normalizeConfig({ type: 'custom:echart-graph-card', ...c } as CardConfig);

const TEMP = st('sensor.temp', '21.5', { friendly_name: 'Living room', unit_of_measurement: '°C', state_class: 'measurement' });
const ENERGY = st('sensor.energy', '1234', { friendly_name: 'Energy', unit_of_measurement: 'kWh', state_class: 'total_increasing' });
const DOOR = st('binary_sensor.door', 'off', { friendly_name: 'Door' });
const CLIMATE = st('climate.living', 'heat', { friendly_name: 'Thermostat', current_temperature: 20.5, unit_of_measurement: 'x' });

describe('loadSeriesData (history)', () => {
  it('loads state series in one batched call and fills SeriesData', async () => {
    const start = NOW_MS - D;
    const { hass, ofType } = makeHass([TEMP, DOOR], {
      history: {
        'sensor.temp': [
          { s: '20', lu: sec(start), lc: sec(start - 5 * H) },
          { s: '21.5', lu: sec(NOW_MS - M) },
        ],
        'binary_sensor.door': [
          { s: 'off', lu: sec(start) },
          { s: 'on', lu: sec(NOW_MS - 2 * H) },
          { s: 'off', lu: sec(NOW_MS - H) },
        ],
      },
    });
    const cfg = cfgOf({ series: ['sensor.temp', 'binary_sensor.door', 'sensor.temp'] });
    const data = await loadSeriesData(hass, cfg, NOW);

    const hist = ofType('history/history_during_period');
    expect(hist).toHaveLength(1);
    expect(hist[0]).toMatchObject({
      entity_ids: ['sensor.temp', 'binary_sensor.door'],
      start_time: new Date(start).toISOString(),
      end_time: NOW.toISOString(),
      minimal_response: true,
      no_attributes: true,
    });
    expect(ofType('recorder/statistics_during_period')).toHaveLength(0);

    expect(data).toHaveLength(3);
    expect(data[0]).toMatchObject({ name: 'Living room', unit: '°C', isBinary: false, latest: 21.5, source: 'history' });
    expect(data[0].points).toEqual([
      [start, 20],
      [NOW_MS - M, 21.5],
    ]);
    expect(data[0].error).toBeUndefined();
    expect(data[1]).toMatchObject({ name: 'Door', unit: undefined, isBinary: true, latest: 0 });
    expect(data[1].points.map((p) => p[1])).toEqual([0, 1, 0]);
    // same entity twice -> independent arrays (LiveBuffer mutates them)
    expect(data[2].points).toEqual(data[0].points);
    expect(data[2].points).not.toBe(data[0].points);
  });

  it('fetches attribute series in a separate call per attribute', async () => {
    const { hass, ofType } = makeHass([TEMP, CLIMATE], {
      history: {
        'sensor.temp': [{ s: '21', lu: sec(NOW_MS - D) }],
        'climate.living': [
          { s: 'heat', a: { current_temperature: 20 }, lu: sec(NOW_MS - D) },
          { s: 'heat', a: { current_temperature: 20.5 }, lu: sec(NOW_MS - H) },
        ],
      },
    });
    const cfg = cfgOf({ series: ['sensor.temp', { entity: 'climate.living', attribute: 'current_temperature' }] });
    const data = await loadSeriesData(hass, cfg, NOW);
    const hist = ofType('history/history_during_period');
    expect(hist).toHaveLength(2);
    expect(hist.find((c) => c.no_attributes === false)).toMatchObject({ entity_ids: ['climate.living'], minimal_response: false });
    expect(data[1].points.map((p) => p[1])).toEqual([20, 20.5]);
    // attribute series: state unit does not apply, not binary, latest from the attribute
    expect(data[1]).toMatchObject({ name: 'Thermostat', unit: undefined, isBinary: false, latest: 20.5 });
  });

  it('applies transform before group_by and exposes rawTail for grouped history series', async () => {
    const windowStart = NOW_MS - D;
    const alignedStart = Math.floor(windowStart / H) * H - 0; // 12:00Z is already hour-aligned
    const power = st('sensor.power', '2000', { unit_of_measurement: 'W' }, NOW_MS - 10 * M);
    const { hass, ofType } = makeHass([power], {
      history: {
        'sensor.power': [
          { s: '1000', lu: sec(alignedStart) },
          { s: '3000', lu: sec(NOW_MS - 90 * M) },
          { s: '2000', lu: sec(NOW_MS - 10 * M) },
        ],
      },
    });
    const cfg = cfgOf({
      series: [{ entity: 'sensor.power', unit: 'kW', transform: { multiply: 0.001 }, group_by: { func: 'avg', duration: '1h' } }],
    });
    const [d] = await loadSeriesData(hass, cfg, NOW);
    expect(ofType('history/history_during_period')[0].start_time).toBe(new Date(alignedStart).toISOString());
    expect(d.unit).toBe('kW');
    expect(d.latest).toBe(2);
    // last bucket (11:00Z): 3 kW held for 50 min, then 2 kW for 10 min
    const last = d.points[d.points.length - 1];
    expect(last[0]).toBe(NOW_MS - H);
    expect(last[1]).toBeCloseTo((3 * 50 + 2 * 10) / 60, 9);
    expect(d.rawTail).toEqual([
      [NOW_MS - 90 * M, 3],
      [NOW_MS - 10 * M, 2],
    ]);
  });

  it('fetches from local midnight for day buckets (DST-aware)', async () => {
    const { hass, ofType } = makeHass([ENERGY], {
      history: {
        'sensor.energy': [
          { s: '100', lu: sec(ms('2026-09-24T22:00:00Z')) },
          { s: '104', lu: sec(ms('2026-09-25T12:00:00Z')) },
          { s: '110', lu: sec(ms('2026-09-26T06:00:00Z')) },
        ],
      },
    });
    const cfg = cfgOf({ series: [{ entity: 'sensor.energy', group_by: { func: 'delta', duration: '1d' } }] });
    const [d] = await loadSeriesData(hass, cfg, NOW);
    // window starts 2026-09-25T12:00Z = 14:00 CEST -> fetch from local midnight 2026-09-24T22:00Z
    expect(ofType('history/history_during_period')[0].start_time).toBe('2026-09-24T22:00:00.000Z');
    expect(d.points).toEqual([
      [ms('2026-09-24T22:00:00Z'), 4],
      [ms('2026-09-25T22:00:00Z'), 6],
    ]);
  });

  it('re-stamps the initial state of raw series to the window start when fetching earlier', async () => {
    const { hass } = makeHass([TEMP, ENERGY], {
      history: {
        'sensor.temp': [
          { s: '20', lu: sec(NOW_MS - D - 30 * M) },
          { s: '21', lu: sec(NOW_MS - D + 10 * M) },
        ],
        'sensor.energy': [{ s: '1', lu: sec(NOW_MS - D - 30 * M) }],
      },
    });
    const cfg = cfgOf({ series: ['sensor.temp', { entity: 'sensor.energy', group_by: { func: 'max', duration: '1h' } }] });
    const [temp] = await loadSeriesData(hass, cfg, NOW);
    expect(temp.points).toEqual([
      [NOW_MS - D, 20],
      [NOW_MS - D + 10 * M, 21],
    ]);
  });

  it('reports unknown entities without failing the load', async () => {
    const { hass } = makeHass([TEMP], { history: { 'sensor.temp': [{ s: '1', lu: sec(NOW_MS - D) }] } });
    const data = await loadSeriesData(hass, cfgOf({ series: ['sensor.nope', 'sensor.temp'] }), NOW);
    expect(data[0]).toMatchObject({ name: 'sensor.nope', points: [], error: 'Entity not found: sensor.nope', latest: undefined });
    expect(data[1].error).toBeUndefined();
  });

  it('keeps entities with empty history error-free', async () => {
    const { hass } = makeHass([TEMP], { history: {} });
    const [d] = await loadSeriesData(hass, cfgOf({ series: ['sensor.temp'] }), NOW);
    expect(d.points).toEqual([]);
    expect(d.error).toBeUndefined();
    expect(d.latest).toBe(21.5);
  });

  it('handles an always-unavailable entity', async () => {
    const dead = st('sensor.dead', 'unavailable', { unit_of_measurement: 'W' });
    const { hass } = makeHass([dead], { history: { 'sensor.dead': [{ s: 'unavailable', lu: sec(NOW_MS - 3 * D) }] } });
    const [d] = await loadSeriesData(hass, cfgOf({ series: ['sensor.dead'] }), NOW);
    expect(d.points).toEqual([[NOW_MS - D, null]]);
    expect(d.latest).toBeNull();
  });

  it('rejects when a WebSocket call fails', async () => {
    const { hass } = makeHass([TEMP], { fail: 'history/history_during_period' });
    await expect(loadSeriesData(hass, cfgOf({ series: ['sensor.temp'] }), NOW)).rejects.toThrow('failed');
  });

  it('produces data LiveBuffer can extend', async () => {
    const { hass } = makeHass([TEMP], { history: { 'sensor.temp': [{ s: '21.5', lu: sec(NOW_MS - M) }] } });
    const data = await loadSeriesData(hass, cfgOf({ series: ['sensor.temp'] }), NOW);
    const buf = new LiveBuffer();
    buf.reset(data, hass);
    const next = { ...hass, states: { 'sensor.temp': st('sensor.temp', '22', TEMP.attributes, NOW_MS + M) } } as HomeAssistant;
    expect(buf.append(next)).toBe(true);
    expect(data[0].points[data[0].points.length - 1]).toEqual([NOW_MS + M, 22]);
  });
});

describe('loadSeriesData (statistics)', () => {
  const row = (t: number, v: Partial<StatisticValue>): StatisticValue => ({ start: t, end: t + H, ...v });

  it('uses statistics above 72h and history for entities without a state_class', async () => {
    const windowStart = NOW_MS - 7 * D;
    const { hass, ofType } = makeHass([TEMP, DOOR], {
      statistics: { 'sensor.temp': [row(windowStart - H, { mean: 19 }), row(windowStart, { mean: 20 }), row(NOW_MS - H, { mean: 21 })] },
      history: { 'binary_sensor.door': [{ s: 'on', lu: sec(windowStart) }] },
    });
    const cfg = cfgOf({ span: '7d', series: ['sensor.temp', 'binary_sensor.door'] });
    expect(cfg.dataSource).toBe('statistics');
    const data = await loadSeriesData(hass, cfg, NOW);

    const stats = ofType('recorder/statistics_during_period');
    expect(stats).toHaveLength(1);
    expect(stats[0]).toMatchObject({ statistic_ids: ['sensor.temp'], period: 'hour', start_time: new Date(windowStart - H).toISOString() });
    expect(ofType('history/history_during_period')[0]).toMatchObject({ entity_ids: ['binary_sensor.door'] });
    expect(ofType('recorder/get_statistics_metadata')).toHaveLength(0); // all entities known

    // the row covering the window start is kept, older rows dropped, no re-stamping
    expect(data[0]).toMatchObject({ source: 'statistics', unit: '°C', name: 'Living room' });
    expect(data[0].points).toEqual([
      [windowStart, 20],
      [NOW_MS - H, 21],
    ]);
    expect(data[0].rawTail).toBeUndefined();
    expect(data[1]).toMatchObject({ source: 'history', isBinary: true });
  });

  it('falls back to history (batched) when an auto series has no statistics', async () => {
    const noStats = st('sensor.new', '5', { state_class: 'measurement', unit_of_measurement: 'W' });
    const noStats2 = st('sensor.new2', '6', { state_class: 'measurement' });
    const { hass, ofType } = makeHass([TEMP, noStats, noStats2], {
      statistics: { 'sensor.temp': [row(NOW_MS - H, { mean: 21 })], 'sensor.new2': [row(NOW_MS - H, { mean: null })] },
      history: { 'sensor.new': [{ s: '5', lu: sec(NOW_MS - 2 * D) }], 'sensor.new2': [{ s: '6', lu: sec(NOW_MS - 2 * D) }] },
    });
    const data = await loadSeriesData(hass, cfgOf({ span: '7d', series: ['sensor.temp', 'sensor.new', 'sensor.new2'] }), NOW);
    const hist = ofType('history/history_during_period');
    expect(hist).toHaveLength(1);
    expect(hist[0].entity_ids).toEqual(['sensor.new', 'sensor.new2']);
    expect(data.map((d) => d.source)).toEqual(['statistics', 'history', 'history']);
    expect(data[1].points).toEqual([[NOW_MS - 2 * D, 5]]);
  });

  it('does not fall back when statistics are forced and explains empty results', async () => {
    const { hass, ofType } = makeHass([TEMP], { statistics: {} });
    const cfg = cfgOf({ data_source: 'statistics', series: ['sensor.temp'] });
    const [d] = await loadSeriesData(hass, cfg, NOW);
    expect(ofType('history/history_during_period')).toHaveLength(0);
    expect(ofType('recorder/statistics_during_period')[0].period).toBe('5minute');
    expect(d.source).toBe('statistics');
    expect(d.error).toMatch(/No long-term statistics for sensor\.temp/);
  });

  it('uses history for attribute series even when statistics are forced', async () => {
    const { hass, ofType } = makeHass([CLIMATE], {
      history: { 'climate.living': [{ s: 'heat', a: { current_temperature: 20 }, lu: sec(NOW_MS - D) }] },
    });
    const cfg = cfgOf({ data_source: 'statistics', series: [{ entity: 'climate.living', attribute: 'current_temperature' }] });
    const [d] = await loadSeriesData(hass, cfg, NOW);
    expect(ofType('recorder/statistics_during_period')).toHaveLength(0);
    expect(d.source).toBe('history');
  });

  it('resolves name/unit of external statistics from metadata', async () => {
    const { hass, ofType } = makeHass([], {
      statistics: { 'tibber:consumption': [row(NOW_MS - 2 * H, { sum: 3 }), row(NOW_MS - H, { sum: 4 })] },
      metadata: [{ statistic_id: 'tibber:consumption', statistics_unit_of_measurement: 'kWh', name: 'Tibber consumption' }],
    });
    const [d] = await loadSeriesData(hass, cfgOf({ span: '7d', series: ['tibber:consumption'] }), NOW);
    expect(ofType('recorder/get_statistics_metadata')[0].statistic_ids).toEqual(['tibber:consumption']);
    expect(d).toMatchObject({ name: 'Tibber consumption', unit: 'kWh', source: 'statistics', latest: undefined });
    expect(d.error).toBeUndefined();
    expect(d.points.map((p) => p[1])).toEqual([3, 4]);
  });

  it('ignores metadata failures', async () => {
    const { hass } = makeHass([], {
      statistics: { 'tibber:consumption': [row(NOW_MS - H, { state: 1 })] },
      fail: 'recorder/get_statistics_metadata',
    });
    const [d] = await loadSeriesData(hass, cfgOf({ span: '7d', series: ['tibber:consumption'] }), NOW);
    expect(d).toMatchObject({ name: 'tibber:consumption', unit: undefined });
  });

  it('aligns day-period statistics to local midnight and groups statistics rows', async () => {
    const { hass, ofType } = makeHass([ENERGY], {
      statistics: {
        'sensor.energy': [
          row(ms('2026-09-18T22:00:00Z'), { change: 1 }),
          row(ms('2026-09-19T22:00:00Z'), { change: 2 }),
          row(ms('2026-09-20T22:00:00Z'), { change: 3 }),
        ],
      },
    });
    const cfg = cfgOf({
      span: '7d',
      statistics_period: 'day',
      series: [{ entity: 'sensor.energy', statistic: 'change', group_by: { func: 'sum', duration: '7d' } }],
    });
    const [d] = await loadSeriesData(hass, cfg, NOW);
    // window start 2026-09-19T12:00Z (14:00 CEST) - 1 day -> local midnight 2026-09-17T22:00Z;
    // the 7d group_by bucket containing the window start begins Monday 2026-09-14 00:00 CEST.
    expect(ofType('recorder/statistics_during_period')[0].start_time).toBe('2026-09-13T22:00:00.000Z');
    expect(d.points).toEqual([
      [ms('2026-09-13T22:00:00Z'), 3],
      [ms('2026-09-20T22:00:00Z'), 3],
    ]);
  });
});
