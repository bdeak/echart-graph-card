import { describe, expect, it, vi } from 'vitest';
import { normalizeConfig } from '../../src/config';
import { LiveBuffer } from '../../src/data/live';
import { groupBy, lastBucketTail } from '../../src/data/transform';
import type { CardConfig, HassEntityState, HomeAssistant, Point, SeriesData } from '../../src/types';

const M = 60_000;
const iso = (t: number): string => new Date(t).toISOString();
const T0 = Date.parse('2026-09-26T10:00:00Z');

function hassWith(states: HassEntityState[]): HomeAssistant {
  return {
    states: Object.fromEntries(states.map((s) => [s.entity_id, s])),
    callWS: vi.fn(),
    connection: { subscribeMessage: vi.fn() },
    locale: { language: 'en', time_zone: 'server', number_format: 'language' },
    config: { time_zone: 'Europe/Berlin' },
    themes: { darkMode: false },
  } as unknown as HomeAssistant;
}

function st(
  entity_id: string,
  state: string,
  changed: number,
  updated = changed,
  attributes: Record<string, unknown> = {},
): HassEntityState {
  return { entity_id, state, attributes, last_changed: iso(changed), last_updated: iso(updated) };
}

function seriesData(cfg: Partial<CardConfig>, points: Point[][], source: SeriesData['source'] = 'history'): SeriesData[] {
  const n = normalizeConfig({ type: 'custom:echart-graph-card', ...cfg } as CardConfig);
  return n.series.map((s, i) => ({ series: s, points: points[i] ?? [], name: s.entity, isBinary: false, source, latest: undefined }));
}

describe('LiveBuffer.append (raw history series)', () => {
  it('does nothing for unchanged last_updated', () => {
    const [d] = seriesData({ series: ['sensor.a'] }, [[[T0, 1]]]);
    const buf = new LiveBuffer();
    const hass = hassWith([st('sensor.a', '1', T0)]);
    buf.reset([d], hass);
    expect(buf.data[0]).toBe(d);
    expect(buf.append(hass)).toBe(false);
    expect(d.points).toEqual([[T0, 1]]);
  });

  it('appends state changes at last_changed and updates latest', () => {
    const [d] = seriesData({ series: ['sensor.a'] }, [[[T0, 1]]]);
    const buf = new LiveBuffer();
    buf.reset([d], hassWith([st('sensor.a', '1', T0)]));
    expect(buf.append(hassWith([st('sensor.a', '2.5', T0 + M)]))).toBe(true);
    expect(d.points).toEqual([
      [T0, 1],
      [T0 + M, 2.5],
    ]);
    expect(d.latest).toBe(2.5);
    expect(buf.append(hassWith([st('sensor.a', 'unavailable', T0 + 2 * M)]))).toBe(true);
    expect(d.points[2]).toEqual([T0 + 2 * M, null]);
    expect(d.latest).toBeNull();
  });

  it('ignores attribute-only updates of state series (same last_changed and value)', () => {
    const [d] = seriesData({ series: ['sensor.a'] }, [[[T0, 1]]]);
    const buf = new LiveBuffer();
    buf.reset([d], hassWith([st('sensor.a', '1', T0)]));
    d.latest = 1;
    expect(buf.append(hassWith([st('sensor.a', '1', T0, T0 + M)]))).toBe(false);
    expect(d.points).toHaveLength(1);
  });

  it('never goes back in time and replaces the value on equal timestamps', () => {
    const [d] = seriesData({ series: ['sensor.a'] }, [[[T0, 1]]]);
    const buf = new LiveBuffer();
    buf.reset([d], hassWith([st('sensor.a', '1', T0)]));
    expect(buf.append(hassWith([st('sensor.a', '3', T0 - M, T0 + M)]))).toBe(true);
    expect(d.points).toEqual([[T0, 3]]);
  });

  it('skips a state that is already contained in the fetch (race with the fetch)', () => {
    const [d] = seriesData({ series: ['sensor.a'] }, [[[T0, 1], [T0 + M, 2]]]);
    const buf = new LiveBuffer();
    buf.reset([d], hassWith([st('sensor.a', '1', T0)])); // hass snapshot from before the fetch
    d.latest = 2;
    expect(buf.append(hassWith([st('sensor.a', '2', T0 + M)]))).toBe(false);
    expect(d.points).toHaveLength(2);
  });

  it('applies the series transform', () => {
    const [d] = seriesData({ series: [{ entity: 'sensor.w', transform: { multiply: 0.001 } }] }, [[]]);
    const buf = new LiveBuffer();
    buf.reset([d], hassWith([]));
    buf.append(hassWith([st('sensor.w', '1500', T0)]));
    expect(d.points).toEqual([[T0, 1.5]]);
    expect(d.latest).toBe(1.5);
  });

  it('uses last_updated and the attribute value for attribute series', () => {
    const [d] = seriesData({ series: [{ entity: 'climate.x', attribute: 'current_temperature' }] }, [[[T0, 20]]]);
    const buf = new LiveBuffer();
    buf.reset([d], hassWith([st('climate.x', 'heat', T0 - 60 * M, T0, { current_temperature: 20 })]));
    buf.append(hassWith([st('climate.x', 'heat', T0 - 60 * M, T0 + M, { current_temperature: 20.5 })]));
    expect(d.points).toEqual([
      [T0, 20],
      [T0 + M, 20.5],
    ]);
  });

  it('updates every series of a shared entity', () => {
    const ds = seriesData({ series: ['sensor.a', { entity: 'sensor.a', transform: { offset: 10 } }] }, [[], []]);
    const buf = new LiveBuffer();
    buf.reset(ds, hassWith([]));
    buf.append(hassWith([st('sensor.a', '1', T0)]));
    expect(ds[0].points).toEqual([[T0, 1]]);
    expect(ds[1].points).toEqual([[T0, 11]]);
  });

  it('only updates latest for statistics series', () => {
    const [d] = seriesData({ series: ['sensor.a'] }, [[[T0 - 60 * M, 5]]], 'statistics');
    const buf = new LiveBuffer();
    buf.reset([d], hassWith([st('sensor.a', '5', T0)]));
    expect(buf.append(hassWith([st('sensor.a', '6', T0 + M)]))).toBe(true);
    expect(d.points).toEqual([[T0 - 60 * M, 5]]);
    expect(d.latest).toBe(6);
  });

  it('clears latest when an entity disappears and adopts entities that appear later', () => {
    const [d] = seriesData({ series: ['sensor.a'] }, [[]]);
    d.error = 'Entity not found: sensor.a';
    const buf = new LiveBuffer();
    buf.reset([d], hassWith([]));
    const appeared = st('sensor.a', '4', T0, T0, { friendly_name: 'Sensor A', unit_of_measurement: 'W' });
    expect(buf.append(hassWith([appeared]))).toBe(true);
    expect(d.error).toBeUndefined();
    expect(d.name).toBe('Sensor A');
    expect(d.unit).toBe('W');
    expect(d.points).toEqual([[T0, 4]]);
    expect(buf.append(hassWith([]))).toBe(true);
    expect(d.latest).toBeUndefined();
    expect(buf.append(hassWith([]))).toBe(false);
  });

  it('returns false before reset', () => {
    expect(new LiveBuffer().append(hassWith([]))).toBe(false);
  });
});

describe('LiveBuffer.append (grouped series)', () => {
  const B = 5 * M;

  function initGrouped(func: 'avg' | 'delta' | 'max', raw: Point[]) {
    const [d] = seriesData({ series: [{ entity: 'sensor.p', group_by: { func, duration: '5m' } }] }, [groupBy(raw, func, B)]);
    d.rawTail = lastBucketTail(raw, B);
    return d;
  }

  it.each(['avg', 'delta', 'max'] as const)('incremental %s matches a full regroup', (func) => {
    const raw: Point[] = [
      [T0, 100],
      [T0 + 2 * M, 200],
      [T0 + 6 * M, 150],
    ];
    const d = initGrouped(func, raw);
    const buf = new LiveBuffer();
    buf.reset([d], hassWith([st('sensor.p', '150', T0 + 6 * M)]));
    const updates: Array<[number, string]> = [
      [T0 + 7 * M, '300'], // same bucket
      [T0 + 8 * M, 'unavailable'], // gap in the same bucket
      [T0 + 12 * M, '120'], // next bucket
      [T0 + 31 * M, '90'], // skips buckets -> filled (held value is null here -> no fill)
      [T0 + 33 * M, '95'],
      [T0 + 52 * M, '80'], // skips buckets while 95 is held -> filled
    ];
    const all = [...raw];
    for (const [t, s] of updates) {
      expect(buf.append(hassWith([st('sensor.p', s, t)]))).toBe(true);
      all.push([t, s === 'unavailable' ? null : Number(s)]);
      const expected = groupBy(all, func, B);
      expect(d.points).toHaveLength(expected.length);
      d.points.forEach((p, i) => {
        expect(p[0]).toBe(expected[i][0]);
        if (expected[i][1] === null) expect(p[1]).toBeNull();
        else expect(p[1]).toBeCloseTo(expected[i][1] as number, 9);
      });
    }
    expect(d.rawTail?.[d.rawTail.length - 1]).toEqual([T0 + 52 * M, 80]);
  });

  it('starts a grouped series from scratch when nothing was loaded', () => {
    const [d] = seriesData({ series: [{ entity: 'sensor.p', group_by: '5m' }] }, [[]]);
    const buf = new LiveBuffer();
    buf.reset([d], hassWith([]));
    buf.append(hassWith([st('sensor.p', '10', T0 + M)]));
    expect(d.points).toEqual([[T0, 10]]);
    expect(d.rawTail).toEqual([[T0 + M, 10]]);
  });
});

describe('LiveBuffer.trim', () => {
  it('drops old points and re-stamps the left-edge point of raw history series', () => {
    const [d] = seriesData({ series: ['sensor.a'] }, [[[T0, 1], [T0 + M, 2], [T0 + 2 * M, 3]]]);
    const buf = new LiveBuffer();
    buf.reset([d], hassWith([]));
    const ref = d.points;
    expect(buf.trim(T0 + 90_000)).toBe(true);
    expect(d.points).toBe(ref); // mutated in place
    expect(d.points).toEqual([
      [T0 + 90_000, 2],
      [T0 + 2 * M, 3],
    ]);
    expect(buf.trim(T0 + 90_000)).toBe(false);
    expect(buf.trim(T0)).toBe(false);
  });

  it('keeps the bucket timestamp for grouped and statistics series', () => {
    const grouped = seriesData({ series: [{ entity: 'sensor.a', group_by: '5m' }] }, [[[T0, 1], [T0 + 5 * M, 2], [T0 + 10 * M, 3]]])[0];
    const stats = seriesData({ series: ['sensor.b'] }, [[[T0, 1], [T0 + 60 * M, 2]]], 'statistics')[0];
    const buf = new LiveBuffer();
    buf.reset([grouped, stats], hassWith([]));
    expect(buf.trim(T0 + 7 * M)).toBe(true);
    expect(grouped.points).toEqual([
      [T0 + 5 * M, 2],
      [T0 + 10 * M, 3],
    ]);
    expect(stats.points).toEqual([
      [T0, 1],
      [T0 + 60 * M, 2],
    ]);
  });

  it('re-stamps a single remaining point', () => {
    const [d] = seriesData({ series: ['sensor.a'] }, [[[T0, 1]]]);
    const buf = new LiveBuffer();
    buf.reset([d], hassWith([]));
    expect(buf.trim(T0 + M)).toBe(true);
    expect(d.points).toEqual([[T0 + M, 1]]);
  });
});

describe('LiveBuffer.append (grouped series, O(1) open bucket)', () => {
  const B = 5 * M;
  const FUNCS = ['avg', 'min', 'max', 'first', 'last', 'sum', 'delta', 'median'] as const;

  /** Deterministic pseudo-random sequence. */
  function rng(seed: number): () => number {
    let x = seed;
    return () => {
      x = (x * 1103515245 + 12345) % 2147483648;
      return x / 2147483648;
    };
  }

  it.each(FUNCS)('%s matches a full regroup for random updates (replacements, gaps, skipped buckets)', (func) => {
    const rand = rng(FUNCS.indexOf(func) + 7);
    const raw: Point[] = [
      [T0, 100],
      [T0 + 2 * M, 200],
      [T0 + 6 * M, 150],
    ];
    const [d] = seriesData({ series: [{ entity: 'sensor.p', group_by: { func, duration: '5m' } }] }, [groupBy(raw, func, B)]);
    d.rawTail = lastBucketTail(raw, B);
    const buf = new LiveBuffer();
    buf.reset([d], hassWith([st('sensor.p', '150', T0 + 6 * M)]));
    const all = [...raw];
    let t = T0 + 6 * M;
    for (let k = 0; k < 120; k++) {
      const r = rand();
      // Mostly small steps, sometimes the same timestamp (replace) or a jump over buckets.
      t += r < 0.15 ? 0 : r < 0.9 ? Math.round(rand() * 90_000) : Math.round(rand() * 25 * M);
      const value = rand() < 0.1 ? null : Math.round(rand() * 1000) / 10;
      const last = all[all.length - 1];
      if (last[0] === t) {
        if (last[1] === value) continue;
        all[all.length - 1] = [t, value];
      } else {
        all.push([t, value]);
      }
      buf.append(hassWith([st('sensor.p', value === null ? 'unavailable' : String(value), t, t + 1 + k)]));
      const expected = groupBy(all, func, B);
      expect(d.points.map((p) => p[0])).toEqual(expected.map((p) => p[0]));
      d.points.forEach((p, i) => {
        if (expected[i][1] === null) expect(p[1]).toBeNull();
        else expect(p[1]).toBeCloseTo(expected[i][1] as number, 6);
      });
      expect(d.rawTail).toEqual(lastBucketTail(all, B));
    }
  });

  it('keeps the per-append cost independent of the bucket size (no copies of the open bucket)', () => {
    const [d] = seriesData({ series: [{ entity: 'sensor.p', group_by: { func: 'avg', duration: '1d' } }] }, [[]]);
    const buf = new LiveBuffer();
    buf.reset([d], hassWith([]));
    const t0 = Date.parse('2026-09-26T00:00:30Z');
    for (let i = 0; i < 20_000; i++) buf.append(hassWith([st('sensor.p', String(i % 100), t0 + i * 1000)]));
    const tail = d.rawTail!;
    buf.append(hassWith([st('sensor.p', '5', t0 + 20_000 * 1000)]));
    expect(d.rawTail).toBe(tail); // appended in place
    expect(d.rawTail).toHaveLength(20_001);
    expect(d.points).toHaveLength(1);
  });
});

describe('LiveBuffer domain-aware values', () => {
  it('plots a person in a named zone as away (0), not as a gap', () => {
    const [d] = seriesData({ series: ['person.bob'] }, [[[T0, 1]]]);
    const buf = new LiveBuffer();
    buf.reset([d], hassWith([st('person.bob', 'home', T0)]));
    buf.append(hassWith([st('person.bob', 'Work', T0 + M)]));
    expect(d.points).toEqual([
      [T0, 1],
      [T0 + M, 0],
    ]);
    expect(d.latest).toBe(0);
  });
});

describe('LiveBuffer.backfill', () => {
  it('merges the missed history of a gap into raw and grouped series', () => {
    const raw = seriesData({ series: ['sensor.a'] }, [[[T0, 1], [T0 + M, 2]]])[0];
    const grouped = seriesData({ series: [{ entity: 'sensor.b', group_by: { func: 'max', duration: '5m' } }] }, [[[T0, 5]]])[0];
    grouped.rawTail = [[T0 + M, 5]];
    const stats = seriesData({ series: ['sensor.c'] }, [[[T0, 9]]], 'statistics')[0];
    const buf = new LiveBuffer();
    buf.reset([raw, grouped, stats], hassWith([]));
    const gap = T0 + 2 * M;
    const changed = buf.backfill(
      {
        // first row = synthetic "state at start_time" (dropped), then the missed states
        [raw.series.key]: [
          [gap, 2],
          [T0 + 3 * M, 3],
          [T0 + 4 * M, 4],
        ],
        [grouped.series.key]: [
          [gap, 5],
          [T0 + 3 * M, 7],
          [T0 + 6 * M, 6],
        ],
        [stats.series.key]: [[T0 + 3 * M, 100]],
      },
      gap,
    );
    expect(changed).toBe(true);
    expect(raw.points).toEqual([
      [T0, 1],
      [T0 + M, 2],
      [T0 + 3 * M, 3],
      [T0 + 4 * M, 4],
    ]);
    expect(grouped.points).toEqual(
      groupBy(
        [
          [T0 + M, 5],
          [T0 + 3 * M, 7],
          [T0 + 6 * M, 6],
        ],
        'max',
        5 * M,
      ),
    );
    expect(stats.points).toEqual([[T0, 9]]);
    // Samples the buffer already has (live appends newer than the gap start) are not duplicated.
    expect(buf.backfill({ [raw.series.key]: [[T0 + 3 * M, 3]] }, gap)).toBe(false);
  });
});
