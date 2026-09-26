import { describe, expect, it, vi } from 'vitest';
import { normalizeConfig } from '../../src/config';
import { fetchStatistics, fetchStatisticsMetadata, resolveStatisticType, statisticCandidates } from '../../src/data/statistics';
import type { HassEntityState, HassMessage, HomeAssistant, SeriesConfig, StatisticsResponse } from '../../src/types';

const ms = (iso: string): number => Date.parse(iso);

function mockHass(
  response: unknown | ((msg: HassMessage) => unknown),
  states: Record<string, HassEntityState> = {},
): HomeAssistant & { callWS: ReturnType<typeof vi.fn> } {
  const callWS = vi.fn(async (msg: HassMessage) => (typeof response === 'function' ? (response as (m: HassMessage) => unknown)(msg) : response));
  return {
    states,
    callWS,
    connection: { subscribeMessage: vi.fn() },
    locale: { language: 'en', time_zone: 'server', number_format: 'language' },
    config: { time_zone: 'Europe/Berlin' },
    themes: { darkMode: false },
  } as unknown as HomeAssistant & { callWS: ReturnType<typeof vi.fn> };
}

function st(entity_id: string, s: string, attributes: Record<string, unknown> = {}): HassEntityState {
  return { entity_id, state: s, attributes, last_changed: '2026-09-26T10:00:00Z', last_updated: '2026-09-26T10:00:00Z' };
}

const seriesOf = (...s: Array<SeriesConfig | string>) => normalizeConfig({ type: 'custom:echart-graph-card', series: s }).series;

const STATES = {
  'sensor.temp': st('sensor.temp', '21', { state_class: 'measurement', unit_of_measurement: '°C' }),
  'sensor.energy': st('sensor.energy', '1234', { state_class: 'total_increasing', unit_of_measurement: 'kWh' }),
  'sensor.gas': st('sensor.gas', '50', { state_class: 'total' }),
};

describe('resolveStatisticType', () => {
  const hass = mockHass({}, STATES);
  it('returns explicit types unchanged', () => {
    expect(resolveStatisticType(seriesOf({ entity: 'sensor.energy', statistic: 'change' })[0], hass)).toBe('change');
    expect(resolveStatisticType(seriesOf({ entity: 'sensor.temp', statistic: 'max' })[0], hass)).toBe('max');
  });

  it('auto: state for total / total_increasing, mean otherwise', () => {
    const [temp, energy, gas, ext] = seriesOf('sensor.temp', 'sensor.energy', 'sensor.gas', 'tibber:consumption');
    expect(resolveStatisticType(temp, hass)).toBe('mean');
    expect(resolveStatisticType(energy, hass)).toBe('state');
    expect(resolveStatisticType(gas, hass)).toBe('state');
    expect(resolveStatisticType(ext, hass)).toBe('mean');
  });

  it('auto series get fallback columns, explicit ones do not', () => {
    const [temp, energy, explicit] = seriesOf('sensor.temp', 'sensor.energy', { entity: 'sensor.temp', statistic: 'min' });
    expect(statisticCandidates(temp, hass)).toEqual(['mean', 'state', 'sum']);
    expect(statisticCandidates(energy, hass)).toEqual(['state', 'sum', 'mean']);
    expect(statisticCandidates(explicit, hass)).toEqual(['min']);
  });
});

describe('fetchStatistics', () => {
  const start = new Date('2026-09-19T00:00:00Z');
  const end = new Date('2026-09-26T00:00:00Z');

  it('issues one call with deduped ids and the union of needed types', async () => {
    const hass = mockHass({}, STATES);
    const series = seriesOf('sensor.temp', 'sensor.energy', { entity: 'sensor.temp', statistic: 'max' });
    const out = await fetchStatistics(hass, series, start, end, 'hour');
    expect(hass.callWS).toHaveBeenCalledTimes(1);
    const msg = hass.callWS.mock.calls[0][0];
    expect(msg).toMatchObject({
      type: 'recorder/statistics_during_period',
      start_time: '2026-09-19T00:00:00.000Z',
      end_time: '2026-09-26T00:00:00.000Z',
      statistic_ids: ['sensor.temp', 'sensor.energy'],
      period: 'hour',
    });
    expect([...msg.types].sort()).toEqual(['max', 'mean', 'state', 'sum']);
    expect(out).toEqual({ '0:sensor.temp': [], '1:sensor.energy': [], '2:sensor.temp': [] });
  });

  it('maps rows to points at row.start (ms or ISO), keyed by series key', async () => {
    const res: StatisticsResponse = {
      'sensor.temp': [
        { start: ms('2026-09-25T10:00:00Z'), end: ms('2026-09-25T11:00:00Z'), mean: 20.1, min: 19, max: 21 },
        { start: '2026-09-25T11:00:00Z', end: '2026-09-25T12:00:00Z', mean: 20.4, min: 19.5, max: 22 },
        { start: ms('2026-09-25T12:00:00Z'), end: ms('2026-09-25T13:00:00Z'), mean: null, min: null, max: null },
      ],
    };
    const series = seriesOf('sensor.temp', { entity: 'sensor.temp', statistic: 'max' });
    const out = await fetchStatistics(mockHass(res, STATES), series, start, end, 'hour');
    expect(out['0:sensor.temp']).toEqual([
      [ms('2026-09-25T10:00:00Z'), 20.1],
      [ms('2026-09-25T11:00:00Z'), 20.4],
      [ms('2026-09-25T12:00:00Z'), null],
    ]);
    expect(out['1:sensor.temp'].map((p) => p[1])).toEqual([21, 22, null]);
  });

  it('accepts epoch-seconds start values and sorts rows', async () => {
    const res: StatisticsResponse = {
      'sensor.temp': [
        { start: ms('2026-09-25T11:00:00Z') / 1000, end: 0, mean: 2 },
        { start: ms('2026-09-25T10:00:00Z') / 1000, end: 0, mean: 1 },
        { start: 'garbage', end: 0, mean: 3 },
      ],
    };
    const out = await fetchStatistics(mockHass(res, STATES), seriesOf('sensor.temp'), start, end, 'hour');
    expect(out['0:sensor.temp']).toEqual([
      [ms('2026-09-25T10:00:00Z'), 1],
      [ms('2026-09-25T11:00:00Z'), 2],
    ]);
  });

  it('uses state for total_increasing meters and change when configured', async () => {
    const res: StatisticsResponse = {
      'sensor.energy': [
        { start: ms('2026-09-25T10:00:00Z'), end: 0, state: 100, sum: 10, change: 1.5 },
        { start: ms('2026-09-25T11:00:00Z'), end: 0, state: 102, sum: 12, change: 2 },
      ],
    };
    const series = seriesOf('sensor.energy', { entity: 'sensor.energy', statistic: 'change' });
    const out = await fetchStatistics(mockHass(res, STATES), series, start, end, 'hour');
    expect(out['0:sensor.energy'].map((p) => p[1])).toEqual([100, 102]);
    expect(out['1:sensor.energy'].map((p) => p[1])).toEqual([1.5, 2]);
  });

  it('auto falls back to a column with values (external statistics without mean/state)', async () => {
    const res: StatisticsResponse = {
      'tibber:consumption': [
        { start: ms('2026-09-25T10:00:00Z'), end: 0, mean: null, state: null, sum: 5 },
        { start: ms('2026-09-25T11:00:00Z'), end: 0, mean: null, state: null, sum: 7 },
      ],
      'tibber:price': [{ start: ms('2026-09-25T10:00:00Z'), end: 0, state: 0.31 }],
    };
    const out = await fetchStatistics(mockHass(res, STATES), seriesOf('tibber:consumption', 'tibber:price'), start, end, 'hour');
    expect(out['0:tibber:consumption'].map((p) => p[1])).toEqual([5, 7]);
    expect(out['1:tibber:price'].map((p) => p[1])).toEqual([0.31]);
  });

  it('does not fall back for explicit statistic types', async () => {
    const res: StatisticsResponse = { 'sensor.temp': [{ start: ms('2026-09-25T10:00:00Z'), end: 0, mean: 20 }] };
    const out = await fetchStatistics(mockHass(res, STATES), seriesOf({ entity: 'sensor.temp', statistic: 'sum' }), start, end, 'hour');
    expect(out['0:sensor.temp']).toEqual([[ms('2026-09-25T10:00:00Z'), null]]);
  });

  it('handles empty series lists, null responses and rejections', async () => {
    const hass = mockHass(null, STATES);
    expect(await fetchStatistics(hass, [], start, end, 'hour')).toEqual({});
    expect(hass.callWS).not.toHaveBeenCalled();
    expect(await fetchStatistics(hass, seriesOf('sensor.temp'), start, end, 'day')).toEqual({ '0:sensor.temp': [] });
    const failing = mockHass(() => {
      throw new Error('recorder offline');
    });
    await expect(fetchStatistics(failing, seriesOf('sensor.temp'), start, end, 'hour')).rejects.toThrow('recorder offline');
  });
});

describe('fetchStatisticsMetadata', () => {
  it('maps metadata by statistic id', async () => {
    const hass = mockHass([{ statistic_id: 'tibber:consumption', statistics_unit_of_measurement: 'kWh', name: 'Consumption' }]);
    const out = await fetchStatisticsMetadata(hass, ['tibber:consumption', 'tibber:consumption']);
    expect(hass.callWS.mock.calls[0][0]).toEqual({ type: 'recorder/get_statistics_metadata', statistic_ids: ['tibber:consumption'] });
    expect(out['tibber:consumption'].statistics_unit_of_measurement).toBe('kWh');
  });

  it('never rejects and skips the call for no ids', async () => {
    const failing = mockHass(() => {
      throw new Error('nope');
    });
    expect(await fetchStatisticsMetadata(failing, ['x:y'])).toEqual({});
    const hass = mockHass([]);
    expect(await fetchStatisticsMetadata(hass, [])).toEqual({});
    expect(hass.callWS).not.toHaveBeenCalled();
  });
});
