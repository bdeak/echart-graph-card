import { stateToNumber } from './history';
import { applyTransform, clipToWindow, groupBy } from './transform';
import type { HassEntityState, HomeAssistant, NormalizedSeries, Point } from '../types';

/** Item keys tried, in order, for the timestamp of a list attribute item (no `time_key`). */
export const LIST_TIME_KEYS: readonly string[] = ['period_start', 'start', 'start_time', 'startsAt', 'datetime', 'time', 'from'];

/** Epoch numbers below this are seconds, above it milliseconds (1e11 s is the year 5138). */
const EPOCH_SECONDS_BELOW = 1e11;

/** Points of a list attribute series, or the reason there are none. */
export interface ListPoints {
  points: Point[];
  error?: string;
}

/** Epoch ms of a list item's timestamp: ISO / date strings, epoch seconds or ms, Date. NaN if invalid. */
function itemTime(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? (Math.abs(v) < EPOCH_SECONDS_BELOW ? v * 1000 : v) : Number.NaN;
  if (typeof v === 'string') {
    const t = v.trim();
    if (/^-?\d+(\.\d+)?$/.test(t)) return itemTime(Number(t));
    return Date.parse(t);
  }
  if (v instanceof Date) return v.getTime();
  return Number.NaN;
}

/**
 * Points of a list attribute series (`series.valueKey`) from the entity's CURRENT state:
 * `attributes[series.attribute]` must be a list of objects; each item gives one point
 * `[item[timeKey], item[valueKey]]` (timeKey = series.timeKey, else the first LIST_TIME_KEYS key
 * the items have). Values go through stateToNumber (numbers, numeric strings; anything else is a
 * gap). Items without a valid time are skipped. Returns ascending, de-duplicated points (the
 * later item wins); untransformed. `error` explains an empty result.
 */
export function listPoints(st: HassEntityState | undefined, series: NormalizedSeries): ListPoints {
  const attr = series.attribute ?? '';
  const valueKey = series.valueKey ?? '';
  if (!st) return { points: [], error: `Entity not found: ${series.entity}` };
  const list = st.attributes?.[attr];
  if (!Array.isArray(list)) {
    return { points: [], error: `${series.entity} has no list attribute "${attr}"${list === undefined ? '' : ' (it is not a list)'}` };
  }
  const items = list.filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x));
  const timeKey = series.timeKey ?? LIST_TIME_KEYS.find((k) => items.some((x) => x[k] !== undefined));
  if (items.length === 0) return { points: [] };
  if (timeKey === undefined) {
    return { points: [], error: `${series.entity}.${attr}: no time key found in the items (set time_key)` };
  }
  if (!items.some((x) => x[valueKey] !== undefined)) {
    return { points: [], error: `${series.entity}.${attr}: the items have no "${valueKey}"` };
  }

  const raw: Point[] = [];
  for (const item of items) {
    const t = itemTime(item[timeKey]);
    if (!Number.isFinite(t)) continue;
    raw.push([t, stateToNumber(item[valueKey])]);
  }
  if (raw.length === 0) return { points: [], error: `${series.entity}.${attr}: no valid "${timeKey}" timestamps` };

  let sorted = true;
  for (let i = 1; i < raw.length && sorted; i++) if (raw[i][0] < raw[i - 1][0]) sorted = false;
  if (!sorted) raw.sort((a, b) => a[0] - b[0]);
  const points: Point[] = [];
  for (const p of raw) {
    const last = points[points.length - 1];
    if (last && last[0] === p[0]) points[points.length - 1] = p;
    else points.push(p);
  }
  return { points };
}

/**
 * Points and `latest` of a list attribute series (`value_key`) from the entity's current state:
 * listPoints -> applyTransform -> groupBy (if `series.groupBy`) -> clipToWindow(windowStart).
 * `latest` = the value of the point (bucket) covering `now`. Every call returns a fresh array
 * (listPoints builds a new one), so caches keyed by the points array start over.
 */
export function attributeSeriesPoints(
  s: NormalizedSeries,
  hass: HomeAssistant,
  windowStart: number,
  now: number,
  zone: string | undefined,
): { points: Point[]; latest: number | null | undefined; error?: string } {
  const st = hass.states?.[s.entity];
  const { points: raw, error } = listPoints(st, s);
  let tr = applyTransform(raw, s.transform);
  if (s.groupBy) tr = groupBy(tr, s.groupBy.func, s.groupBy.durationMs, zone);
  const points = clipToWindow(tr, windowStart, false);
  let latest: number | null | undefined;
  for (const p of points) {
    if (p[0] > now) break;
    latest = p[1];
  }
  return { points, latest: st ? (latest ?? null) : undefined, error };
}
