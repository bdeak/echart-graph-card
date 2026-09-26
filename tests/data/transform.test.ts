import { describe, expect, it } from 'vitest';
import {
  aggregate,
  applyTransform,
  bucketRange,
  bucketStart,
  bucketTimeZone,
  clipToWindow,
  groupBy,
  isValidTimeZone,
  lastBucketTail,
  transformValue,
  wallToUtc,
  zoneOffset,
} from '../../src/data/transform';
import type { HomeAssistant, Point } from '../../src/types';

const S = 1000;
const M = 60 * S;
const H = 60 * M;
const D = 24 * H;
const Z = (iso: string): number => Date.parse(iso);
const BERLIN = 'Europe/Berlin';

describe('bucketStart / bucketRange', () => {
  it('is UTC-epoch aligned without a zone', () => {
    expect(bucketStart(Z('2026-09-26T10:07:31Z'), 5 * M)).toBe(Z('2026-09-26T10:05:00Z'));
    expect(bucketStart(Z('2026-09-26T10:07:31Z'), D)).toBe(Z('2026-09-26T00:00:00Z'));
    expect(bucketRange(Z('2026-09-26T10:07:31Z'), H)).toEqual([Z('2026-09-26T10:00:00Z'), Z('2026-09-26T11:00:00Z')]);
  });

  it('returns t for non-positive durations', () => {
    expect(bucketStart(1234, 0)).toBe(1234);
    expect(bucketStart(1234, -5)).toBe(1234);
  });

  it('aligns day buckets to local midnight in the given zone', () => {
    // 10:00 CEST on 2026-09-26 -> local midnight = 2026-09-25T22:00Z
    expect(bucketStart(Z('2026-09-26T08:00:00Z'), D, BERLIN)).toBe(Z('2026-09-25T22:00:00Z'));
    // 00:30 local (22:30Z the day before) belongs to the new local day
    expect(bucketStart(Z('2026-09-25T22:30:00Z'), D, BERLIN)).toBe(Z('2026-09-25T22:00:00Z'));
    expect(bucketStart(Z('2026-09-25T21:59:59Z'), D, BERLIN)).toBe(Z('2026-09-24T22:00:00Z'));
  });

  it('makes the spring-forward day 23h and the fall-back day 25h long', () => {
    expect(bucketRange(Z('2026-03-29T12:00:00Z'), D, BERLIN)).toEqual([Z('2026-03-28T23:00:00Z'), Z('2026-03-29T22:00:00Z')]);
    expect(bucketRange(Z('2026-10-25T12:00:00Z'), D, BERLIN)).toEqual([Z('2026-10-24T22:00:00Z'), Z('2026-10-25T23:00:00Z')]);
  });

  it('keeps 1h buckets UTC aligned (the repeated fall-back hour stays two buckets)', () => {
    expect(bucketStart(Z('2026-10-25T00:30:00Z'), H, BERLIN)).toBe(Z('2026-10-25T00:00:00Z')); // 02:30 CEST
    expect(bucketStart(Z('2026-10-25T01:30:00Z'), H, BERLIN)).toBe(Z('2026-10-25T01:00:00Z')); // 02:30 CET
  });

  it('aligns multi-hour buckets to the local wall clock across DST changes', () => {
    // Fall-back: wall [02:00, 04:00) spans 3 real hours starting at the first 02:00 (CEST).
    expect(bucketRange(Z('2026-10-25T01:30:00Z'), 2 * H, BERLIN)).toEqual([Z('2026-10-25T00:00:00Z'), Z('2026-10-25T03:00:00Z')]);
    expect(bucketRange(Z('2026-10-24T23:30:00Z'), 2 * H, BERLIN)).toEqual([Z('2026-10-24T22:00:00Z'), Z('2026-10-25T00:00:00Z')]);
    // Spring-forward: wall 02:00 does not exist -> bucket starts at the transition (03:00 CEST).
    expect(bucketRange(Z('2026-03-29T01:30:00Z'), 2 * H, BERLIN)).toEqual([Z('2026-03-29T01:00:00Z'), Z('2026-03-29T02:00:00Z')]);
    expect(bucketRange(Z('2026-03-29T00:30:00Z'), 2 * H, BERLIN)).toEqual([Z('2026-03-28T23:00:00Z'), Z('2026-03-29T01:00:00Z')]);
    // Regular day: 6h buckets at 00/06/12/18 local.
    expect(bucketStart(Z('2026-09-26T05:00:00Z'), 6 * H, BERLIN)).toBe(Z('2026-09-26T04:00:00Z')); // 07:00 local -> 06:00 local
  });

  it('starts week buckets on Monday local midnight', () => {
    // Saturday 2026-09-26 -> Monday 2026-09-21 00:00 CEST = 2026-09-20T22:00Z
    expect(bucketStart(Z('2026-09-26T12:00:00Z'), 7 * D, BERLIN)).toBe(Z('2026-09-20T22:00:00Z'));
  });

  it('falls back to UTC alignment for invalid zones and non-dividing durations', () => {
    expect(bucketStart(Z('2026-09-26T08:00:00Z'), D, 'Not/AZone')).toBe(Z('2026-09-26T00:00:00Z'));
    expect(bucketStart(Z('2026-09-26T08:00:00Z'), 5 * H, BERLIN)).toBe(Math.floor(Z('2026-09-26T08:00:00Z') / (5 * H)) * 5 * H);
    expect(bucketStart(Z('2026-09-26T08:00:00Z'), D, 'UTC')).toBe(Z('2026-09-26T00:00:00Z'));
  });
});

describe('zone helpers', () => {
  it('computes zone offsets and wall->UTC conversion', () => {
    expect(zoneOffset(BERLIN, Z('2026-01-15T12:00:00Z'))).toBe(H);
    expect(zoneOffset(BERLIN, Z('2026-07-15T12:00:00Z'))).toBe(2 * H);
    expect(zoneOffset('UTC', Z('2026-07-15T12:00:00Z'))).toBe(0);
    expect(zoneOffset('Asia/Kolkata', Z('2026-07-15T12:00:00Z'))).toBe(5.5 * H);
    // ambiguous 02:30 on fall-back day -> first occurrence (CEST)
    expect(wallToUtc(BERLIN, Z('2026-10-25T02:30:00Z'))).toBe(Z('2026-10-25T00:30:00Z'));
    expect(wallToUtc(BERLIN, Z('2026-07-15T14:00:00Z'))).toBe(Z('2026-07-15T12:00:00Z'));
  });

  it('validates zones', () => {
    expect(isValidTimeZone(BERLIN)).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(isValidTimeZone(undefined)).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });

  it('bucketTimeZone follows the HA profile time zone setting', () => {
    const hass = (tz: string | undefined, server = 'America/New_York') =>
      ({ locale: { time_zone: tz }, config: { time_zone: server } }) as unknown as HomeAssistant;
    expect(bucketTimeZone(hass('server'))).toBe('America/New_York');
    expect(bucketTimeZone(hass('local'))).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(bucketTimeZone(hass(undefined))).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(bucketTimeZone(hass('Asia/Tokyo'))).toBe('Asia/Tokyo');
    // Same rules as the display zone (resolveTimeZone): invalid zones fall back to the browser zone.
    expect(bucketTimeZone(hass('system'))).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(bucketTimeZone(hass('garbage'))).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(bucketTimeZone(hass('server', 'garbage'))).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(bucketTimeZone(undefined)).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });
});

describe('aggregate', () => {
  const v = [4, 1, 3, 2];
  it.each([
    ['avg', 2.5],
    ['min', 1],
    ['max', 4],
    ['first', 4],
    ['last', 2],
    ['sum', 10],
    ['delta', -2],
    ['median', 2.5],
  ] as const)('%s', (func, expected) => {
    expect(aggregate(v, func)).toBe(expected);
  });

  it('median of an odd count is the middle value', () => {
    expect(aggregate([5, 1, 9], 'median')).toBe(5);
  });

  it('does not mutate the input (median sorts a copy)', () => {
    const arr = [3, 1, 2];
    aggregate(arr, 'median');
    expect(arr).toEqual([3, 1, 2]);
  });

  it('returns NaN for empty input', () => {
    expect(aggregate([], 'avg')).toBeNaN();
  });
});

describe('groupBy', () => {
  const B = 5 * M;

  it('returns a copy for non-positive durations and handles empty input', () => {
    const pts: Point[] = [[0, 1]];
    const out = groupBy(pts, 'avg', 0);
    expect(out).toEqual(pts);
    expect(out).not.toBe(pts);
    expect(groupBy([], 'avg', B)).toEqual([]);
  });

  it('emits one point per bucket at the bucket start', () => {
    const pts: Point[] = [
      [10 * S, 1],
      [70 * S, 3],
      [B + 5 * S, 10],
    ];
    expect(groupBy(pts, 'max', B).map((p) => p[0])).toEqual([0, B]);
  });

  it('avg is time-weighted with sample-and-hold', () => {
    // 10 for 60s, then 20 for the remaining 240s of the bucket
    expect(groupBy([[0, 10], [60 * S, 20]], 'avg', B)).toEqual([[0, 18]]);
  });

  it('avg carries the previous value into the bucket start', () => {
    // 100 W held; a 2000 W spike for the last minute of the second bucket -> 480 W average
    const pts: Point[] = [
      [0, 100],
      [9 * M, 2000],
    ];
    expect(groupBy(pts, 'avg', B)).toEqual([
      [0, 100],
      [B, 480],
    ]);
  });

  it('min/max/first include the carried-in value; a sample at the bucket start supersedes it', () => {
    const pts: Point[] = [
      [0, 20],
      [7 * M, 25],
    ];
    expect(groupBy(pts, 'min', B)[1]).toEqual([B, 20]);
    expect(groupBy(pts, 'max', B)[1]).toEqual([B, 25]);
    expect(groupBy(pts, 'first', B)[1]).toEqual([B, 20]);
    expect(groupBy([[0, 20], [B, 30]], 'first', B)[1]).toEqual([B, 30]);
    expect(groupBy([[0, 20], [B, 30]], 'min', B)[1]).toEqual([B, 30]);
  });

  it('delta uses the value at the bucket start so bucket deltas add up to the total', () => {
    const meter: Point[] = [
      [0, 100],
      [100 * S, 101],
      [350 * S, 103],
      [650 * S, 106],
    ];
    const out = groupBy(meter, 'delta', B);
    expect(out).toEqual([
      [0, 1],
      [B, 2],
      [2 * B, 3],
    ]);
    expect(out.reduce((s, p) => s + (p[1] ?? 0), 0)).toBe(106 - 100);
  });

  it('delta of a single sample without carry is 0', () => {
    expect(groupBy([[10 * S, 5]], 'delta', B)).toEqual([[0, 0]]);
  });

  it('sum/last/median only use the bucket samples', () => {
    const pts: Point[] = [
      [0, 5],
      [6 * M, 1],
      [7 * M, 2],
      [8 * M, 4],
    ];
    expect(groupBy(pts, 'sum', B)[1]).toEqual([B, 7]);
    expect(groupBy(pts, 'last', B)[1]).toEqual([B, 4]);
    expect(groupBy(pts, 'median', B)[1]).toEqual([B, 2]);
  });

  it('fills empty buckets between samples with the held value (sum/delta: 0)', () => {
    const pts: Point[] = [
      [0, 5],
      [1_000 * S, 7],
    ];
    expect(groupBy(pts, 'max', B)).toEqual([
      [0, 5],
      [B, 5],
      [2 * B, 5],
      [3 * B, 7],
    ]);
    expect(groupBy(pts, 'delta', B)).toEqual([
      [0, 0],
      [B, 0],
      [2 * B, 0],
      [3 * B, 2],
    ]);
    expect(groupBy(pts, 'sum', B).map((p) => p[1])).toEqual([5, 0, 0, 7]);
    const avg = groupBy(pts, 'avg', B);
    expect(avg.slice(0, 3)).toEqual([
      [0, 5],
      [B, 5],
      [2 * B, 5],
    ]);
    // last bucket: 5 held for 100s, then 7 for 200s
    expect(avg[3][1]).toBeCloseTo((5 * 100 + 7 * 200) / 300, 10);
  });

  it('keeps gaps: null-only buckets emit null and nulls are not filled', () => {
    const pts: Point[] = [
      [0, 5],
      [60 * S, null],
      [1_000 * S, 7],
    ];
    const out = groupBy(pts, 'avg', B);
    // bucket 0: 5 for 60s, null afterwards -> 5; empty buckets while unavailable -> nothing
    expect(out).toEqual([
      [0, 5],
      [3 * B, 7],
    ]);
    expect(groupBy([[0, null], [10 * S, null]], 'avg', B)).toEqual([[0, null]]);
    expect(groupBy([[0, null]], 'delta', B)).toEqual([[0, null]]);
  });

  it('ignores nulls inside a bucket', () => {
    const pts: Point[] = [
      [0, 2],
      [M, null],
      [2 * M, 6],
    ];
    expect(groupBy(pts, 'max', B)).toEqual([[0, 6]]);
    // time-weighted: 2 for 60s, gap for 60s, 6 for 180s -> (120 + 1080) / 240
    expect(groupBy(pts, 'avg', B)[0][1]).toBeCloseTo((2 * 60 + 6 * 180) / 240, 10);
  });

  it('is pure', () => {
    const pts: Point[] = [
      [0, 1],
      [M, 2],
    ];
    const snapshot = JSON.stringify(pts);
    Object.freeze(pts);
    groupBy(pts, 'avg', B);
    expect(JSON.stringify(pts)).toBe(snapshot);
  });

  it('groups by local day across the spring-forward DST change', () => {
    // hourly samples of 1 from 2026-03-28 00:00 CET to 2026-03-30 23:00 CEST
    const pts: Point[] = [];
    for (let t = Z('2026-03-27T23:00:00Z'); t < Z('2026-03-30T22:00:00Z'); t += H) pts.push([t, 1]);
    const out = groupBy(pts, 'sum', D, BERLIN);
    expect(out).toEqual([
      [Z('2026-03-27T23:00:00Z'), 24],
      [Z('2026-03-28T23:00:00Z'), 23],
      [Z('2026-03-29T22:00:00Z'), 24],
    ]);
  });

  it('groups by local day across the fall-back DST change', () => {
    const pts: Point[] = [];
    for (let t = Z('2026-10-24T22:00:00Z'); t < Z('2026-10-26T23:00:00Z'); t += H) pts.push([t, 1]);
    expect(groupBy(pts, 'sum', D, BERLIN).map((p) => p[1])).toEqual([25, 24]);
    // time-weighted avg is unaffected by the 25h day
    expect(groupBy(pts, 'avg', D, BERLIN).map((p) => p[1])).toEqual([1, 1]);
  });

  it('keeps hourly buckets uniform across DST (UTC aligned)', () => {
    const pts: Point[] = [];
    for (let t = Z('2026-10-24T22:00:00Z'); t < Z('2026-10-25T04:00:00Z'); t += 15 * M) pts.push([t, 1]);
    const out = groupBy(pts, 'sum', H, BERLIN);
    expect(out).toHaveLength(6);
    expect(out.every((p) => p[1] === 4)).toBe(true);
    expect(out[1][0] - out[0][0]).toBe(H);
  });
});

describe('lastBucketTail', () => {
  const B = 5 * M;
  it('returns the last bucket samples preceded by the carried-in point', () => {
    const pts: Point[] = [
      [0, 1],
      [M, 2],
      [6 * M, 3],
      [7 * M, 4],
    ];
    expect(lastBucketTail(pts, B)).toEqual([
      [M, 2],
      [6 * M, 3],
      [7 * M, 4],
    ]);
  });

  it('has no carry when the first point is in the last bucket', () => {
    expect(lastBucketTail([[6 * M, 3], [7 * M, 4]], B)).toEqual([
      [6 * M, 3],
      [7 * M, 4],
    ]);
    expect(lastBucketTail([], B)).toEqual([]);
  });
});

describe('applyTransform / transformValue', () => {
  it('returns the same array for the identity transform', () => {
    const pts: Point[] = [[0, 1]];
    expect(applyTransform(pts, { multiply: 1, offset: 0 })).toBe(pts);
  });

  it('applies v * multiply + offset and keeps nulls', () => {
    const pts: Point[] = [
      [0, 1500],
      [1, null],
      [2, -250],
    ];
    const out = applyTransform(pts, { multiply: 0.001, offset: 1 });
    expect(out).toEqual([
      [0, 2.5],
      [1, null],
      [2, 0.75],
    ]);
    expect(pts[0][1]).toBe(1500);
  });

  it('transforms scalars', () => {
    expect(transformValue(10, { multiply: -1, offset: 5 })).toBe(-5);
    expect(transformValue(null, { multiply: 2, offset: 5 })).toBeNull();
  });
});

describe('clipToWindow', () => {
  const pts: Point[] = [
    [0, 1],
    [10, 2],
    [20, 3],
    [30, 4],
  ];
  it('keeps the last point at or before the window start and optionally re-stamps it', () => {
    expect(clipToWindow(pts, 15, true)).toEqual([
      [15, 2],
      [20, 3],
      [30, 4],
    ]);
    expect(clipToWindow(pts, 15, false)).toEqual([
      [10, 2],
      [20, 3],
      [30, 4],
    ]);
    expect(clipToWindow(pts, 20, true)).toEqual([
      [20, 3],
      [30, 4],
    ]);
    expect(pts[1]).toEqual([10, 2]); // input untouched
  });

  it('returns the same array when nothing changes', () => {
    expect(clipToWindow(pts, 0, true)).toBe(pts);
    expect(clipToWindow(pts, -5, true)).toBe(pts);
    const empty: Point[] = [];
    expect(clipToWindow(empty, 5, true)).toBe(empty);
  });

  it('keeps a single stale point (re-stamped) so the line still starts at the edge', () => {
    expect(clipToWindow([[0, 7]], 100, true)).toEqual([[100, 7]]);
  });
});
