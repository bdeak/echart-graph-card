import { describe, expect, it, vi } from 'vitest';
import {
  binaryStatePair,
  entityStateToNumber,
  fetchHistory,
  historyRowsToPoints,
  isBinaryEntity,
  isExternalStatistic,
  isValidEntityId,
  seriesValue,
  stateToNumber,
} from '../../src/data/history';
import type { HassEntityState, HassMessage, HistoryResponse, HomeAssistant } from '../../src/types';

const sec = (iso: string): number => Date.parse(iso) / 1000;
const ms = (iso: string): number => Date.parse(iso);

function mockHass(response: unknown | ((msg: HassMessage) => unknown)): HomeAssistant & { callWS: ReturnType<typeof vi.fn> } {
  const callWS = vi.fn(async (msg: HassMessage) => (typeof response === 'function' ? (response as (m: HassMessage) => unknown)(msg) : response));
  return {
    states: {},
    callWS,
    connection: { subscribeMessage: vi.fn() },
    locale: { language: 'en', time_zone: 'server', number_format: 'language' },
    config: { time_zone: 'Europe/Berlin' },
    themes: { darkMode: false },
  } as unknown as HomeAssistant & { callWS: ReturnType<typeof vi.fn> };
}

function state(entity_id: string, s: string, attributes: Record<string, unknown> = {}): HassEntityState {
  return { entity_id, state: s, attributes, last_changed: '2026-09-26T10:00:00Z', last_updated: '2026-09-26T10:00:00Z' };
}

describe('stateToNumber', () => {
  it.each([
    ['21.5', 21.5],
    [' 3 ', 3],
    ['-2.5', -2.5],
    ['+4', 4],
    ['.5', 0.5],
    ['1e3', 1000],
    ['0', 0],
    [7, 7],
    [0, 0],
    [true, 1],
    [false, 0],
    ['on', 1],
    ['OFF', 0],
    ['open', 1],
    ['closed', 0],
    ['home', 1],
    ['not_home', 0],
    ['True', 1],
    ['false', 0],
    ['locked', 0],
    ['unlocked', 1],
  ])('%j -> %j', (input, expected) => {
    expect(stateToNumber(input)).toBe(expected);
  });

  it.each([['unavailable'], ['unknown'], ['Unknown'], [''], ['  '], ['none'], ['abc'], ['12abc'], ['0x10'], ['Infinity'], ['1_000'], [Number.NaN], [Number.POSITIVE_INFINITY], [null], [undefined], [{}], [[1]]])(
    '%j -> null',
    (input) => {
      expect(stateToNumber(input)).toBeNull();
    },
  );
});

describe('isBinaryEntity', () => {
  it('detects binary domains', () => {
    expect(isBinaryEntity('binary_sensor.door')).toBe(true);
    expect(isBinaryEntity('switch.pump')).toBe(true);
    expect(isBinaryEntity('input_boolean.guest')).toBe(true);
    expect(isBinaryEntity('person.bob')).toBe(true);
    expect(isBinaryEntity('sensor.temp')).toBe(false);
  });

  it('detects on/off states of other domains', () => {
    expect(isBinaryEntity('sensor.mode', state('sensor.mode', 'on'))).toBe(true);
    expect(isBinaryEntity('sensor.temp', state('sensor.temp', '21.5'))).toBe(false);
    expect(isBinaryEntity('sensor.temp', state('sensor.temp', 'unavailable'))).toBe(false);
  });

  it('is false for attribute series and external statistics', () => {
    expect(isBinaryEntity('binary_sensor.door', state('binary_sensor.door', 'on'), 'battery')).toBe(false);
    expect(isBinaryEntity('climate.living', state('climate.living', 'heat'), 'current_temperature')).toBe(false);
    expect(isBinaryEntity('tibber:energy_consumption')).toBe(false);
  });
});

describe('fetchHistory', () => {
  const start = new Date('2026-09-26T00:00:00Z');
  const end = new Date('2026-09-26T12:00:00Z');

  it('issues one batched history_during_period call with minimal_response', async () => {
    const hass = mockHass({});
    await fetchHistory(hass, ['sensor.a', 'sensor.b', 'sensor.a'], start, end);
    expect(hass.callWS).toHaveBeenCalledTimes(1);
    expect(hass.callWS.mock.calls[0][0]).toEqual({
      type: 'history/history_during_period',
      start_time: '2026-09-26T00:00:00.000Z',
      end_time: '2026-09-26T12:00:00.000Z',
      entity_ids: ['sensor.a', 'sensor.b'],
      minimal_response: true,
      no_attributes: true,
      significant_changes_only: false,
    });
  });

  it('parses seconds to ms, uses lc ?? lu and clamps the initial state to start', async () => {
    const res: HistoryResponse = {
      'sensor.a': [
        { s: '20.5', a: {}, lu: sec('2026-09-26T00:00:00Z'), lc: sec('2026-09-25T18:00:00Z') },
        { s: '21', lu: sec('2026-09-26T01:00:00.250Z') },
        { s: 'unavailable', lu: sec('2026-09-26T02:00:00Z') },
        { s: '22', lu: sec('2026-09-26T03:00:00Z') },
      ],
    };
    const out = await fetchHistory(mockHass(res), ['sensor.a'], start, end);
    expect(out['sensor.a']).toEqual([
      [ms('2026-09-26T00:00:00Z'), 20.5],
      [ms('2026-09-26T01:00:00.250Z'), 21],
      [ms('2026-09-26T02:00:00Z'), null],
      [ms('2026-09-26T03:00:00Z'), 22],
    ]);
  });

  it('prefers lc over lu for state series when both are present', async () => {
    const res: HistoryResponse = {
      'sensor.a': [{ s: '1', lu: sec('2026-09-26T05:00:00Z'), lc: sec('2026-09-26T04:00:00Z') }],
    };
    const out = await fetchHistory(mockHass(res), ['sensor.a'], start, end);
    expect(out['sensor.a']).toEqual([[ms('2026-09-26T04:00:00Z'), 1]]);
  });

  it('maps binary states to 0/1', async () => {
    const res: HistoryResponse = {
      'binary_sensor.door': [
        { s: 'off', lu: sec('2026-09-26T00:00:00Z') },
        { s: 'on', lu: sec('2026-09-26T01:00:00Z') },
        { s: 'off', lu: sec('2026-09-26T01:05:00Z') },
      ],
    };
    const out = await fetchHistory(mockHass(res), ['binary_sensor.door'], start, end);
    expect(out['binary_sensor.door'].map((p) => p[1])).toEqual([0, 1, 0]);
  });

  it('returns [] for requested entities without rows (empty history)', async () => {
    const out = await fetchHistory(mockHass({ 'sensor.a': [] }), ['sensor.a', 'sensor.missing'], start, end);
    expect(out).toEqual({ 'sensor.a': [], 'sensor.missing': [] });
  });

  it('tolerates a null response', async () => {
    const out = await fetchHistory(mockHass(null), ['sensor.a'], start, end);
    expect(out).toEqual({ 'sensor.a': [] });
  });

  it('returns all-null points for an always-unavailable entity', async () => {
    const res: HistoryResponse = {
      'sensor.a': [
        { s: 'unavailable', lu: sec('2026-09-25T00:00:00Z') },
        { s: 'unknown', lu: sec('2026-09-26T06:00:00Z') },
      ],
    };
    const out = await fetchHistory(mockHass(res), ['sensor.a'], start, end);
    expect(out['sensor.a']).toEqual([
      [start.getTime(), null],
      [ms('2026-09-26T06:00:00Z'), null],
    ]);
  });

  it('sorts rows and dedupes equal timestamps keeping the last value', async () => {
    const res: HistoryResponse = {
      'sensor.a': [
        { s: '3', lu: sec('2026-09-26T03:00:00Z') },
        { s: '1', lu: sec('2026-09-26T01:00:00Z') },
        { s: '2', lu: sec('2026-09-26T01:00:00Z') },
      ],
    };
    const out = await fetchHistory(mockHass(res), ['sensor.a'], start, end);
    expect(out['sensor.a']).toEqual([
      [ms('2026-09-26T01:00:00Z'), 2],
      [ms('2026-09-26T03:00:00Z'), 3],
    ]);
  });

  it('fetches attribute values with full rows and last_updated timestamps', async () => {
    const res: HistoryResponse = {
      'climate.living': [
        { s: 'heat', a: { current_temperature: 20.5 }, lu: sec('2026-09-26T00:00:00Z'), lc: sec('2026-09-20T00:00:00Z') },
        { s: 'heat', a: { current_temperature: '21' }, lu: sec('2026-09-26T01:00:00Z'), lc: sec('2026-09-20T00:00:00Z') },
        { s: 'unavailable', a: {}, lu: sec('2026-09-26T02:00:00Z') },
      ],
    };
    const hass = mockHass(res);
    const out = await fetchHistory(hass, ['climate.living'], start, end, { attribute: 'current_temperature' });
    expect(hass.callWS.mock.calls[0][0]).toMatchObject({ minimal_response: false, no_attributes: false });
    expect(out['climate.living']).toEqual([
      [ms('2026-09-26T00:00:00Z'), 20.5],
      [ms('2026-09-26T01:00:00Z'), 21],
      [ms('2026-09-26T02:00:00Z'), null],
    ]);
  });

  it('does not call the API for an empty entity list', async () => {
    const hass = mockHass({});
    expect(await fetchHistory(hass, [], start, end)).toEqual({});
    expect(hass.callWS).not.toHaveBeenCalled();
  });

  it('rejects when callWS rejects', async () => {
    const hass = mockHass(() => {
      throw new Error('boom');
    });
    await expect(fetchHistory(hass, ['sensor.a'], start, end)).rejects.toThrow('boom');
  });
});

describe('historyRowsToPoints', () => {
  it('skips malformed rows', () => {
    const rows = [{ s: '1', lu: 10 }, { s: '2' }, null, { s: '3', lu: Number.NaN }] as never;
    expect(historyRowsToPoints(rows, 0)).toEqual([[10_000, 1]]);
    expect(historyRowsToPoints(undefined, 0)).toEqual([]);
  });
});

describe('entity ids (HA valid_entity_id / valid_statistic_id)', () => {
  it.each([
    ['sensor.living_room', true],
    ['binary_sensor.door_2', true],
    ['sensor.Living_Room', false],
    ['sensor.living-room', false],
    ['sensor._a', false],
    ['sensor.a_', false],
    ['sen__sor.a', false],
    ['sensor.a.b', false],
    ['tibber:consumption', false],
  ])('%s valid entity id: %s', (id, ok) => {
    expect(isValidEntityId(id)).toBe(ok);
  });

  it('recognises external statistic ids', () => {
    expect(isExternalStatistic('tibber:energy_consumption')).toBe(true);
    expect(isExternalStatistic('Tibber:x')).toBe(false);
    expect(isExternalStatistic('sensor.a')).toBe(false);
  });
});

describe('domain-aware binary values', () => {
  it.each([
    ['person.bob', 'home', 1],
    ['person.bob', 'not_home', 0],
    ['person.bob', 'Work', 0], // named zone = away, not a gap
    ['device_tracker.phone', 'Office', 0],
    ['lock.front', 'locked', 0],
    ['lock.front', 'unlocked', 1],
    ['lock.front', 'jammed', 1],
    ['lock.front', 'unlocking', 1],
    ['cover.garage', 'closed', 0],
    ['cover.garage', 'closing', 1], // still (partly) open
    ['cover.garage', 'stopped', 1],
    ['cover.garage', 'open', 1],
    ['person.bob', 'unavailable', null],
    ['lock.front', 'unknown', null],
    ['binary_sensor.door', 'on', 1],
    ['sensor.temp', '21.5', 21.5],
    ['sensor.mode', 'Work', null],
  ])('%s = %j -> %j', (id, state, expected) => {
    expect(entityStateToNumber(id, state)).toBe(expected);
  });

  it('seriesValue uses plain conversion for attributes', () => {
    expect(seriesValue('person.bob', 'Work')).toBe(0);
    expect(seriesValue('person.bob', 'Work', 'zone')).toBeNull();
    expect(seriesValue('climate.a', 21, 'temperature')).toBe(21);
  });

  it('knows the native state pair of each binary domain', () => {
    expect(binaryStatePair('cover.garage')).toEqual(['closed', 'open']);
    expect(binaryStatePair('lock.front')).toEqual(['locked', 'unlocked']);
    expect(binaryStatePair('person.bob')).toEqual(['not_home', 'home']);
    expect(binaryStatePair('device_tracker.phone')).toEqual(['not_home', 'home']);
    expect(binaryStatePair('binary_sensor.door', 'on')).toEqual(['off', 'on']);
    expect(binaryStatePair('sensor.garage_state', 'Open')).toEqual(['closed', 'open']);
    expect(binaryStatePair('sensor.x', 'detected')).toEqual(['clear', 'detected']);
    expect(binaryStatePair('sensor.x', '12')).toEqual(['off', 'on']);
  });

  it('fetchHistory converts rows per entity domain', async () => {
    const hass = mockHass({
      'person.bob': [
        { s: 'home', lu: sec('2026-09-26T01:00:00Z') },
        { s: 'Work', lu: sec('2026-09-26T08:00:00Z') },
        { s: 'not_home', lu: sec('2026-09-26T17:00:00Z') },
      ],
    });
    const out = await fetchHistory(hass, ['person.bob'], new Date('2026-09-26T00:00:00Z'), new Date('2026-09-26T20:00:00Z'));
    expect(out['person.bob'].map((p) => p[1])).toEqual([1, 0, 0]);
    expect(historyRowsToPoints([{ s: 'jammed', lu: 1 }], 0, undefined, 'lock.front')).toEqual([[1000, 1]]);
  });
});
