import { browserTimeZone, resolveTimeZone } from '../chart/format';
import type { GroupByFunc, HomeAssistant, NormalizedTransform, Point, SpanStart } from '../types';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** 1970-01-05 (a Monday) is epoch day 4: week buckets start on Monday. */
const MONDAY_EPOCH_DAY = 4;
/** Safety cap for synthesized empty-bucket points per groupBy call (pathological configs). */
const MAX_FILL_POINTS = 50_000;

// ---------------------------------------------------------------------------
// Time zone helpers (wall-clock aligned buckets)
// ---------------------------------------------------------------------------

const dtfCache = new Map<string, Intl.DateTimeFormat | null>();

function zoneFormatter(zone: string): Intl.DateTimeFormat | null {
  let f = dtfCache.get(zone);
  if (f === undefined) {
    try {
      f = new Intl.DateTimeFormat('en-US', {
        timeZone: zone,
        hourCycle: 'h23',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
      });
    } catch {
      f = null; // invalid IANA zone -> treated as "no zone" (UTC epoch alignment)
    }
    dtfCache.set(zone, f);
  }
  return f;
}

/** True if `zone` is a usable IANA time zone name. */
export function isValidTimeZone(zone: string | undefined): zone is string {
  return typeof zone === 'string' && zone !== '' && zoneFormatter(zone) !== null;
}

/** Offset (ms) of `zone` at instant `t`: wall-clock time = t + offset. Invalid zone -> 0. */
export function zoneOffset(zone: string, t: number): number {
  const f = zoneFormatter(zone);
  if (!f) return 0;
  const tSec = Math.floor(t / 1000) * 1000;
  let y = 1970;
  let mo = 1;
  let d = 1;
  let h = 0;
  let mi = 0;
  let s = 0;
  for (const p of f.formatToParts(tSec)) {
    switch (p.type) {
      case 'year':
        y = Number(p.value);
        break;
      case 'month':
        mo = Number(p.value);
        break;
      case 'day':
        d = Number(p.value);
        break;
      case 'hour':
        h = Number(p.value) % 24;
        break;
      case 'minute':
        mi = Number(p.value);
        break;
      case 'second':
        s = Number(p.value);
        break;
      default:
        break;
    }
  }
  return Date.UTC(y, mo - 1, d, h, mi, s) - tSec;
}

/**
 * UTC instant for a wall-clock time `wall` (wall time encoded as if it were UTC ms) in `zone`.
 * Ambiguous wall times (DST fall-back) resolve to the FIRST occurrence; non-existent wall times
 * (DST spring-forward gap) resolve to the transition instant.
 */
export function wallToUtc(zone: string, wall: number): number {
  const before = wall - zoneOffset(zone, wall - DAY_MS);
  const after = wall - zoneOffset(zone, wall + DAY_MS);
  const okBefore = before + zoneOffset(zone, before) === wall;
  const okAfter = after + zoneOffset(zone, after) === wall;
  if (okBefore && okAfter) return Math.min(before, after);
  if (okBefore) return before;
  if (okAfter) return after;
  return before;
}

/**
 * IANA zone used for wall-clock bucket alignment: the same zone the chart displays
 * (resolveTimeZone: `hass.locale.time_zone` `server` -> `hass.config.time_zone`, `local` /
 * `system` / default -> browser zone, an explicit valid IANA name as is, otherwise the browser
 * zone), so day buckets start at the midnight shown on the axis. Loader and LiveBuffer both use
 * this so live buckets match fetched ones. Undefined = UTC epoch alignment.
 */
export function bucketTimeZone(hass: HomeAssistant | undefined): string | undefined {
  const zone = hass ? resolveTimeZone(hass) : browserTimeZone();
  return isValidTimeZone(zone) ? zone : undefined;
}

/**
 * Whether bucketing for `durationMs` follows the local wall clock: whole hours > 1h that divide
 * a day (2h, 3h, 4h, 6h, 8h, 12h) and whole multiples of a day (1d, 2d, 7d = weeks from Monday).
 * 1h and shorter buckets stay UTC-epoch aligned (identical to local for whole-hour zones, and
 * they keep the repeated DST fall-back hour as two separate buckets).
 */
function isWallAligned(durationMs: number): boolean {
  if (durationMs % DAY_MS === 0) return true;
  return durationMs > HOUR_MS && durationMs % HOUR_MS === 0 && DAY_MS % durationMs === 0;
}

/**
 * `[start, end)` of the bucket containing `t` (see bucketStart for alignment). `end` is the next
 * bucket's start, so buckets spanning a DST change are 1h shorter/longer in real time.
 */
export function bucketRange(t: number, durationMs: number, zone?: string): [number, number] {
  if (zone !== undefined && isWallAligned(durationMs) && isValidTimeZone(zone)) {
    const wall = t + zoneOffset(zone, t);
    let startWall: number;
    if (durationMs % DAY_MS === 0) {
      const n = durationMs / DAY_MS;
      const anchor = n % 7 === 0 ? MONDAY_EPOCH_DAY : 0;
      const day = Math.floor(wall / DAY_MS);
      startWall = (anchor + Math.floor((day - anchor) / n) * n) * DAY_MS;
    } else {
      startWall = Math.floor(wall / durationMs) * durationMs;
    }
    const start = wallToUtc(zone, startWall);
    const end = wallToUtc(zone, startWall + durationMs);
    // Guard against pathological zone data: the range must contain t and make progress.
    if (start <= t && end > t) return [start, end];
  }
  const start = Math.floor(t / durationMs) * durationMs;
  return [start, start + durationMs];
}

/** The visible time window `[start, end]` (epoch ms). */
export interface ChartWindow {
  start: number;
  end: number;
}

/**
 * The card's time window. Without `spanStart`: `[now - spanMs, now]`. With `spanStart: 'day'`:
 * from local midnight (in `zone`, see bucketTimeZone; UTC without one) of the day containing
 * `now`, `spanMs` of wall-clock time long, so a 24h window ends at the next midnight on 23 h /
 * 25 h DST days too. The aligned window can end in the future (forecasts, the rest of today).
 */
export function chartWindow(spanMs: number, spanStart: SpanStart | null, now: number, zone?: string): ChartWindow {
  if (spanStart !== 'day') return { start: now - spanMs, end: now };
  if (zone !== undefined && isValidTimeZone(zone)) {
    const startWall = Math.floor((now + zoneOffset(zone, now)) / DAY_MS) * DAY_MS;
    const start = wallToUtc(zone, startWall);
    const end = wallToUtc(zone, startWall + spanMs);
    if (start <= now && end > start) return { start, end };
  }
  const start = Math.floor(now / DAY_MS) * DAY_MS;
  return { start, end: start + spanMs };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start of the bucket containing `t`.
 *
 * Without `zone` (and always for durations <= 1h or not dividing a day):
 * `Math.floor(t / durationMs) * durationMs` (UTC-epoch aligned, so buckets are stable across
 * refetches and live appends). With an IANA `zone`, whole-hour buckets dividing a day (2h..12h)
 * and multiples of a day follow the local wall clock: days start at local midnight (23h/25h long
 * across DST), multiples of 7d start on Monday. `durationMs <= 0` returns `t`.
 */
export function bucketStart(t: number, durationMs: number, zone?: string): number {
  if (!(durationMs > 0)) return t;
  return bucketRange(t, durationMs, zone)[0];
}

/**
 * Aggregate one bucket's values (nulls already removed by the caller; non-empty).
 * avg = mean, median = middle (mean of the two middles), first/last by position,
 * sum, min, max, delta = last - first. Empty input returns NaN.
 */
export function aggregate(values: number[], func: GroupByFunc): number {
  const n = values.length;
  if (n === 0) return Number.NaN;
  switch (func) {
    case 'avg':
    case 'sum': {
      let s = 0;
      for (const v of values) s += v;
      return func === 'avg' ? s / n : s;
    }
    case 'min': {
      let m = values[0];
      for (const v of values) if (v < m) m = v;
      return m;
    }
    case 'max': {
      let m = values[0];
      for (const v of values) if (v > m) m = v;
      return m;
    }
    case 'first':
      return values[0];
    case 'last':
      return values[n - 1];
    case 'delta':
      return values[n - 1] - values[0];
    case 'median': {
      const sorted = [...values].sort((a, b) => a - b);
      const mid = n >> 1;
      return n % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    }
    default:
      return Number.NaN;
  }
}

/**
 * Aggregate samples `points[i0..i1)` (all inside [bs, be)) with sample-and-hold semantics.
 * `carry` is the value held when the bucket starts (the last sample before it; `undefined` =
 * nothing before, `null` = unavailable). Returns null when no non-null value applies.
 */
function aggregateBucket(
  points: Point[],
  i0: number,
  i1: number,
  carry: number | null | undefined,
  func: GroupByFunc,
  bs: number,
  be: number,
): number | null {
  // A sample exactly at the bucket start supersedes the carried-in value.
  const carryNum = points[i0][0] > bs && typeof carry === 'number' ? carry : undefined;

  const values: number[] = [];
  for (let k = i0; k < i1; k++) {
    const v = points[k][1];
    if (v !== null) values.push(v);
  }

  switch (func) {
    case 'avg': {
      // Time-weighted mean over [bs, be): each value holds until the next sample / bucket end.
      let wsum = 0;
      let w = 0;
      if (carryNum !== undefined) {
        const dt = points[i0][0] - bs;
        wsum += carryNum * dt;
        w += dt;
      }
      for (let k = i0; k < i1; k++) {
        const v = points[k][1];
        if (v === null) continue;
        const dt = (k + 1 < i1 ? points[k + 1][0] : be) - points[k][0];
        wsum += v * dt;
        w += dt;
      }
      if (w > 0) return wsum / w;
      return values.length ? aggregate(values, 'avg') : null;
    }
    case 'min':
    case 'max':
      if (carryNum !== undefined) values.push(carryNum);
      return values.length ? aggregate(values, func) : null;
    case 'first':
      if (carryNum !== undefined) return carryNum;
      return values.length ? values[0] : null;
    case 'delta':
      if (!values.length) return null;
      return values[values.length - 1] - (carryNum ?? values[0]);
    default:
      // sum / last / median: only the bucket's own samples.
      return values.length ? aggregate(values, func) : null;
  }
}

/** Value of a bucket without samples while the non-null value `held` is being held. */
function fillValue(func: GroupByFunc, held: number): number {
  return func === 'sum' || func === 'delta' ? 0 : held;
}

/**
 * Bucket `points` (ascending) into windows of `durationMs` (see bucketStart; pass the card's
 * IANA `zone` for local-midnight day buckets). Emits one point per bucket at the bucket START.
 *
 * Sample-and-hold semantics (an HA state holds until the next change):
 * - `avg` is time-weighted over the bucket: each value holds until the next sample or the
 *   bucket end, and the value carried in from before the bucket fills the bucket start. The
 *   last (open) bucket therefore shows the average it will have if the value keeps holding.
 * - `min` / `max` / `first` also consider the carried-in value; `delta` = last - value at the
 *   bucket start (so hourly deltas of a meter add up to its total increase).
 *   `sum` / `last` / `median` use only the bucket's own samples.
 * - Null values are gaps: a bucket whose applicable values are all null emits
 *   `[bucketStart, null]` (keeps the line break).
 * - Empty buckets between two samples are filled while a non-null value is held
 *   (avg/min/max/first/last/median = held value, sum/delta = 0); otherwise they emit nothing.
 *   Nothing is emitted after the bucket of the last sample.
 *
 * Pure; never mutates the input. `durationMs <= 0` returns a copy of the input.
 */
export function groupBy(points: Point[], func: GroupByFunc, durationMs: number, zone?: string): Point[] {
  if (!(durationMs > 0) || points.length === 0) return points.slice();
  const z = zone !== undefined && isValidTimeZone(zone) ? zone : undefined;
  const out: Point[] = [];
  const n = points.length;
  let carry: number | null | undefined;
  let prevEnd: number | undefined;
  let fillBudget = MAX_FILL_POINTS;
  let i = 0;
  while (i < n) {
    const [bs, be] = bucketRange(points[i][0], durationMs, z);
    if (prevEnd !== undefined && prevEnd < bs && typeof carry === 'number') {
      const fv = fillValue(func, carry);
      let s = prevEnd;
      while (s < bs && fillBudget > 0) {
        const [fs, fe] = bucketRange(s, durationMs, z);
        out.push([fs, fv]);
        fillBudget--;
        s = fe;
      }
    }
    let j = i + 1;
    while (j < n && points[j][0] < be) j++;
    out.push([bs, aggregateBucket(points, i, j, carry, func, bs, be)]);
    carry = points[j - 1][1];
    prevEnd = be;
    i = j;
  }
  return out;
}

/**
 * Empty-bucket points between `fromEnd` (end of the last emitted bucket) and `toStart` (start of
 * the next bucket with samples) while the non-null value `held` is being held (see groupBy).
 */
export function fillBuckets(fromEnd: number, toStart: number, func: GroupByFunc, held: number, durationMs: number, zone?: string): Point[] {
  const out: Point[] = [];
  const z = zone !== undefined && isValidTimeZone(zone) ? zone : undefined;
  const fv = fillValue(func, held);
  let s = fromEnd;
  while (s < toStart && out.length < MAX_FILL_POINTS) {
    const [fs, fe] = bucketRange(s, durationMs, z);
    out.push([fs, fv]);
    s = fe;
  }
  return out;
}

/**
 * Incremental aggregate of ONE (open) group_by bucket `[bs, be)`, identical to what groupBy
 * computes for that bucket, in O(1) per sample (median: O(log n) search + insert).
 * Samples arrive in time order; a sample with the timestamp of the previous one replaces it.
 * `carry` is the value held when the bucket starts (see aggregateBucket).
 */
export class BucketAccumulator {
  // Aggregates over the "closed" samples (every sample except the latest one).
  private _wsum = 0;
  private _w = 0;
  private _sum = 0;
  private _count = 0;
  private _min = Infinity;
  private _max = -Infinity;
  private _first: number | undefined;
  private _lastVal: number | undefined;
  private readonly _sorted: number[] = [];
  private _carryApplies = false;
  private _started = false;
  /** Latest sample (not folded into the aggregates, it may still be replaced). */
  private _t = 0;
  private _v: number | null = null;

  constructor(
    readonly func: GroupByFunc,
    readonly bs: number,
    readonly be: number,
    private readonly _carry: number | null | undefined,
  ) {}

  /** Time of the latest sample (NaN before the first one). */
  get lastTime(): number {
    return this._started ? this._t : Number.NaN;
  }

  /** Value of the latest sample (undefined before the first one). */
  get lastValue(): number | null | undefined {
    return this._started ? this._v : undefined;
  }

  /** Add a sample (`t` >= the previous sample's time, inside the bucket). */
  push(t: number, v: number | null): void {
    if (!this._started) {
      this._started = true;
      this._carryApplies = t > this.bs && typeof this._carry === 'number';
      if (this._carryApplies) {
        const c = this._carry as number;
        this._wsum += c * (t - this.bs);
        this._w += t - this.bs;
      }
    } else if (t > this._t) {
      this._fold(t);
    }
    this._t = t;
    this._v = v;
  }

  private _fold(until: number): void {
    const v = this._v;
    if (v === null) return;
    const dt = until - this._t;
    this._wsum += v * dt;
    this._w += dt;
    this._addValue(v);
  }

  private _addValue(v: number): void {
    this._sum += v;
    this._count++;
    if (v < this._min) this._min = v;
    if (v > this._max) this._max = v;
    if (this._first === undefined) this._first = v;
    this._lastVal = v;
    if (this.func === 'median') {
      const a = this._sorted;
      let lo = 0;
      let hi = a.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (a[mid] <= v) lo = mid + 1;
        else hi = mid;
      }
      a.splice(lo, 0, v);
    }
  }

  /** The bucket's aggregate if the latest sample holds until the bucket end (null = gap). */
  value(): number | null {
    if (!this._started) return null;
    const v = this._v;
    const has = v !== null;
    const count = this._count + (has ? 1 : 0);
    const carry = this._carryApplies ? (this._carry as number) : undefined;
    switch (this.func) {
      case 'avg': {
        const dt = has ? this.be - this._t : 0;
        const w = this._w + dt;
        if (w > 0) return (this._wsum + (has ? (v as number) * dt : 0)) / w;
        return count ? (this._sum + (has ? (v as number) : 0)) / count : null;
      }
      case 'min':
      case 'max': {
        let m = this.func === 'min' ? this._min : this._max;
        if (has) m = this.func === 'min' ? Math.min(m, v as number) : Math.max(m, v as number);
        if (carry !== undefined) m = this.func === 'min' ? Math.min(m, carry) : Math.max(m, carry);
        return Number.isFinite(m) ? m : null;
      }
      case 'first':
        if (carry !== undefined) return carry;
        return this._first ?? (has ? (v as number) : null);
      case 'last':
        return has ? (v as number) : (this._lastVal ?? null);
      case 'sum':
        return count ? this._sum + (has ? (v as number) : 0) : null;
      case 'delta': {
        if (!count) return null;
        const last = has ? (v as number) : (this._lastVal as number);
        const first = carry ?? this._first ?? (v as number);
        return last - first;
      }
      case 'median': {
        if (!count) return null;
        const a = this._sorted;
        if (!has) return aggregate(a, 'median');
        // Median of the sorted closed values plus the latest value, without copying.
        const n = a.length + 1;
        const at = (k: number): number => {
          // k-th smallest of a ∪ {v}
          let lo = 0;
          let hi = a.length;
          while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (a[mid] <= (v as number)) lo = mid + 1;
            else hi = mid;
          }
          if (k < lo) return a[k];
          if (k === lo) return v as number;
          return a[k - 1];
        };
        const mid = n >> 1;
        return n % 2 ? at(mid) : (at(mid - 1) + at(mid)) / 2;
      }
      default:
        return null;
    }
  }
}

/**
 * The raw points needed to re-aggregate the LAST bucket of `points` incrementally
 * (SeriesData.rawTail): every point of the last bucket, preceded by the last point before it
 * (the carried-in value) when there is one. `[]` for empty input.
 */
export function lastBucketTail(points: Point[], durationMs: number, zone?: string): Point[] {
  if (points.length === 0 || !(durationMs > 0)) return [];
  const [bs] = bucketRange(points[points.length - 1][0], durationMs, zone);
  let k = points.length - 1;
  while (k > 0 && points[k - 1][0] >= bs) k--;
  return points.slice(k > 0 ? k - 1 : 0);
}

/**
 * Apply `v * multiply + offset` to every non-null value. Pure: returns a new array, or the
 * same array reference when `t` is the identity (`multiply 1, offset 0`).
 */
export function applyTransform(points: Point[], t: NormalizedTransform): Point[] {
  if (t.multiply === 1 && t.offset === 0) return points;
  return points.map(([ts, v]): Point => [ts, v === null ? null : v * t.multiply + t.offset]);
}

/** Scalar version of applyTransform (null stays null). Used for live values / header. */
export function transformValue(v: number | null, t: NormalizedTransform): number | null {
  return v === null ? null : v * t.multiply + t.offset;
}

/**
 * Drop points before `windowStart`, keeping the last point at or before it. With `restamp`,
 * that point is moved to `windowStart` (sample-and-hold lines then start at the left edge).
 * Returns the same array reference when nothing changes.
 */
export function clipToWindow(points: Point[], windowStart: number, restamp: boolean): Point[] {
  if (points.length === 0) return points;
  let k = 0;
  while (k + 1 < points.length && points[k + 1][0] <= windowStart) k++;
  const needsRestamp = restamp && points[k][0] < windowStart;
  if (k === 0 && !needsRestamp) return points;
  const out = points.slice(k);
  if (needsRestamp) out[0] = [windowStart, out[0][1]];
  return out;
}
