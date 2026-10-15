import { seriesValue } from './history';
import { attributeSeriesPoints } from './list';
import { BucketAccumulator, bucketRange, bucketTimeZone, clipToWindow, fillBuckets, transformValue } from './transform';
import { attributeUnit } from './units';
import type { HassEntityState, HomeAssistant, Point, SeriesData } from '../types';

/**
 * Incrementally extends loaded series from `hass.states` changes (no refetch).
 *
 * Usage (card): after every (re)fetch call `reset(data, hass)` with the `hass` object that was
 * current when the fetch STARTED (so changes that race the fetch are still appended; duplicates
 * are skipped); on each `hass` set call `append(hass)` and, if it returns true, schedule a
 * throttled redraw; before redrawing call `trim(windowStart)`. After a gap in the live
 * feed (detached card, reconnect) `backfill()` merges the recorder's history of the gap.
 *
 * The SeriesData objects passed to reset() are owned by the buffer and mutated in place
 * (`points` array contents, `rawTail`, `latest`, and `error`/`name`/`unit` when a previously
 * missing entity appears); `data` exposes them. Point tuples are never mutated, only replaced,
 * and appends only touch points at or after the previous last point's time (the chart's
 * reduction cache in src/data/reduce.ts relies on that). List attribute series are the
 * exception: each change gives them a new `points` array (a fresh cache).
 */
export class LiveBuffer {
  private _data: SeriesData[] = [];
  /** entity_id -> last seen `last_updated` (ISO string). */
  private readonly _lastUpdated = new Map<string, string>();
  /** entity_id -> the series plotting it. */
  private readonly _byEntity = new Map<string, SeriesData[]>();
  /** Open group_by bucket per grouped history series (built lazily from `rawTail`). */
  private readonly _open = new WeakMap<SeriesData, BucketAccumulator>();

  /** The series currently tracked (same objects given to reset()). */
  get data(): SeriesData[] {
    return this._data;
  }

  /**
   * Adopt a freshly loaded dataset and snapshot `last_updated` of every tracked entity from
   * `hass`, so states already contained in the fetch are not appended again.
   */
  reset(data: SeriesData[], hass: HomeAssistant): void {
    this._data = data;
    this._lastUpdated.clear();
    this._byEntity.clear();
    for (const d of data) {
      const id = d.series.entity;
      const list = this._byEntity.get(id);
      if (list) list.push(d);
      else this._byEntity.set(id, [d]);
      const st = hass?.states?.[id];
      if (st) this._lastUpdated.set(id, st.last_updated);
    }
  }

  /**
   * For every tracked entity whose `last_updated` changed since the last call:
   * - update `latest` of every series on that entity (transform applied);
   * - for `source: 'history'` series, append a point at `last_changed` (state series) or
   *   `last_updated` (attribute series), in ms, value via seriesValue + transformValue.
   *   Timestamps never go backwards (clamped to the last point). Skipped if the value equals the
   *   last point's value and the timestamp didn't advance; same timestamp + new value replaces.
   *   Grouped series: the open bucket is updated incrementally (O(1), BucketAccumulator; same
   *   bucket -> last point replaced; new bucket -> empty buckets in between filled per groupBy
   *   rules, new point pushed, `rawTail` restarted).
   * Statistics series only get `latest` updated. List attribute series (`source: 'attribute'`)
   * are re-read from the new state: `points` is REPLACED by a new array (its whole content may
   * change), `latest` and `error` follow.
   * Returns true if any series' points or latest changed.
   */
  append(hass: HomeAssistant): boolean {
    if (this._data.length === 0 || !hass?.states) return false;
    let changed = false;
    let zone: string | undefined;
    let zoneResolved = false;
    const getZone = (): string | undefined => {
      if (!zoneResolved) {
        zone = bucketTimeZone(hass);
        zoneResolved = true;
      }
      return zone;
    };
    for (const [id, list] of this._byEntity) {
      const st = hass.states[id];
      if (!st) {
        if (this._lastUpdated.delete(id)) {
          for (const d of list) {
            if (d.latest !== undefined) {
              d.latest = undefined;
              changed = true;
            }
          }
        }
        continue;
      }
      if (this._lastUpdated.get(id) === st.last_updated) continue;
      this._lastUpdated.set(id, st.last_updated);
      for (const d of list) if (this._applyState(d, st, hass, getZone)) changed = true;
    }
    return changed;
  }

  /**
   * Merge recorder history of a gap in the live feed into the tracked history series.
   * `pointsByKey`: series key -> transformed, ungrouped points (ascending) of the gap, e.g. from
   * loadHistoryRange(). Only points after both `after` (the gap start; this also drops the
   * recorder's synthetic "state at start_time" row) and the series' own last known sample are
   * used, appended with the rules of append(). Statistics series are ignored.
   * Returns true if anything changed.
   */
  backfill(pointsByKey: Readonly<Record<string, Point[]>>, after: number, hass?: HomeAssistant): boolean {
    let changed = false;
    const zone = bucketTimeZone(hass);
    const getZone = (): string | undefined => zone;
    for (const d of this._data) {
      const pts = pointsByKey[d.series.key];
      if (d.source !== 'history' || !pts?.length) continue;
      const since = Math.max(after, lastSampleTime(d));
      for (const [t, v] of pts) {
        if (!(t > since)) continue;
        const added = d.series.groupBy ? this._appendGrouped(d, t, v, getZone) : appendRaw(d.points, t, v);
        if (added) changed = true;
      }
    }
    return changed;
  }

  /**
   * Drop points older than `windowStart` (ms) from every series, keeping the last point at or
   * before `windowStart` so lines still start at the left edge. That point is re-stamped to
   * `windowStart` for raw (ungrouped) history series only; bucketed series (group_by or
   * statistics) keep the bucket's own timestamp (the chart clips it at the axis).
   * Returns true if anything was removed or re-stamped.
   */
  trim(windowStart: number): boolean {
    let changed = false;
    for (const d of this._data) {
      const restamp = d.source === 'history' && !d.series.groupBy;
      const next = clipToWindow(d.points, windowStart, restamp);
      if (next === d.points) continue;
      d.points.splice(0, d.points.length - next.length);
      if (next.length) d.points[0] = next[0];
      changed = true;
    }
    return changed;
  }

  private _applyState(d: SeriesData, st: HassEntityState, hass: HomeAssistant, getZone: () => string | undefined): boolean {
    const s = d.series;
    if (d.source === 'attribute') {
      // The trim on the next redraw drops what lies before the window.
      const next = attributeSeriesPoints(s, hass, Number.NEGATIVE_INFINITY, Date.now(), getZone());
      d.points = next.points;
      d.latest = next.latest;
      if (s.name === undefined && typeof st.attributes?.friendly_name === 'string') d.name = st.attributes.friendly_name;
      if (next.error) d.error = next.error;
      else delete d.error;
      return true;
    }
    let changed = false;
    if (d.error !== undefined && d.error === `Entity not found: ${s.entity}`) {
      // The entity appeared after the load: adopt its metadata.
      d.error = undefined;
      if (s.name === undefined && typeof st.attributes?.friendly_name === 'string') d.name = st.attributes.friendly_name;
      if (d.unit === undefined) {
        const unit = s.attribute ? attributeUnit(s.entity, s.attribute, hass) : st.attributes?.unit_of_measurement;
        if (typeof unit === 'string' && unit) d.unit = unit;
      }
      changed = true;
    }
    const raw = s.attribute ? st.attributes?.[s.attribute] : st.state;
    const v = transformValue(seriesValue(s.entity, raw, s.attribute), s.transform);
    if (d.latest !== v) {
      d.latest = v;
      changed = true;
    }
    if (d.source !== 'history') return changed;

    let t = Date.parse(s.attribute ? st.last_updated : st.last_changed);
    if (!Number.isFinite(t)) t = Date.parse(st.last_updated);
    if (!Number.isFinite(t)) return changed;

    const appended = s.groupBy ? this._appendGrouped(d, t, v, getZone) : appendRaw(d.points, t, v);
    return appended || changed;
  }

  /** The open-bucket accumulator of a grouped series, rebuilt from `rawTail` when missing. */
  private _accumulator(d: SeriesData, zone: string | undefined): BucketAccumulator | undefined {
    const known = this._open.get(d);
    if (known) return known;
    const g = d.series.groupBy;
    const tail = d.rawTail;
    if (!g || !tail?.length) return undefined;
    const last = tail[tail.length - 1];
    const [bs, be] = bucketRange(last[0], g.durationMs, zone);
    let k = 0;
    let carry: number | null | undefined;
    if (tail[0][0] < bs) {
      carry = tail[0][1];
      k = 1;
    }
    const acc = new BucketAccumulator(g.func, bs, be, carry);
    for (; k < tail.length; k++) acc.push(tail[k][0], tail[k][1]);
    this._open.set(d, acc);
    return acc;
  }

  private _appendGrouped(d: SeriesData, t: number, v: number | null, getZone: () => string | undefined): boolean {
    const g = d.series.groupBy;
    if (!g) return false;
    const zone = getZone();
    const pts = d.points;
    const acc = this._accumulator(d, zone);

    if (acc) {
      const lastT = acc.lastTime;
      if (t < lastT) t = lastT;
      if (t === lastT && acc.lastValue === v) return false;
      if (t < acc.be) {
        // Same (open) bucket: update it in place.
        const tail = d.rawTail ?? (d.rawTail = []);
        const tailLast = tail[tail.length - 1];
        if (t === lastT && tailLast && tailLast[0] === t) tail[tail.length - 1] = [t, v];
        else tail.push([t, v]);
        acc.push(t, v);
        setBucketPoint(pts, acc.bs, acc.value());
        return true;
      }
    }

    // A new bucket starts: the previous one is final (its value already assumed the hold).
    const [bs, be] = bucketRange(t, g.durationMs, zone);
    let carry: number | null | undefined;
    if (acc) {
      setBucketPoint(pts, acc.bs, acc.value());
      carry = acc.lastValue;
      if (typeof carry === 'number' && acc.be < bs) for (const p of fillBuckets(acc.be, bs, g.func, carry, g.durationMs, zone)) pts.push(p);
    }
    const next = new BucketAccumulator(g.func, bs, be, carry);
    next.push(t, v);
    this._open.set(d, next);
    pts.push([bs, next.value()]);
    d.rawTail = acc && carry !== undefined ? [[acc.lastTime, carry], [t, v]] : [[t, v]];
    return true;
  }
}

/** Time of the latest raw sample of a history series (grouped: from rawTail), -Infinity if none. */
function lastSampleTime(d: SeriesData): number {
  const src = d.series.groupBy ? d.rawTail : d.points;
  const last = src?.[src.length - 1];
  return last ? last[0] : Number.NEGATIVE_INFINITY;
}

/** Set the value of the bucket point at `bs` (the last point), or append it. */
function setBucketPoint(pts: Point[], bs: number, v: number | null): void {
  const last = pts[pts.length - 1];
  if (last && last[0] === bs) {
    if (last[1] !== v) pts[pts.length - 1] = [bs, v];
  } else {
    pts.push([bs, v]);
  }
}

/** Append `[t, v]` to raw points with the dedupe/clamp rules of LiveBuffer.append. */
function appendRaw(pts: Point[], t: number, v: number | null): boolean {
  const last = pts[pts.length - 1];
  if (last) {
    if (t < last[0]) t = last[0];
    if (t === last[0]) {
      if (last[1] === v) return false;
      pts[pts.length - 1] = [t, v];
      return true;
    }
  }
  pts.push([t, v]);
  return true;
}
