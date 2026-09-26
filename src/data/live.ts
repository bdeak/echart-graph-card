import { stateToNumber } from './history';
import { bucketStart, bucketTimeZone, clipToWindow, groupBy, lastBucketTail, transformValue } from './transform';
import type { HassEntityState, HomeAssistant, Point, SeriesData } from '../types';

/**
 * Incrementally extends loaded series from `hass.states` changes (no refetch).
 *
 * Usage (card): after every (re)fetch call `reset(data, hass)` with the `hass` object that was
 * current when the fetch STARTED (so changes that race the fetch are still appended; duplicates
 * are skipped); on each `hass` set call `append(hass)` and, if it returns true, schedule a
 * throttled redraw; before redrawing call `trim(now - cfg.spanMs)`.
 *
 * The SeriesData objects passed to reset() are owned by the buffer and mutated in place
 * (`points` array contents, `rawTail`, `latest`, and `error`/`name`/`unit` when a previously
 * missing entity appears); `data` exposes them. Point tuples are never mutated, only replaced.
 */
export class LiveBuffer {
  private _data: SeriesData[] = [];
  /** entity_id -> last seen `last_updated` (ISO string). */
  private readonly _lastUpdated = new Map<string, string>();
  /** entity_id -> the series plotting it. */
  private readonly _byEntity = new Map<string, SeriesData[]>();

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
   *   `last_updated` (attribute series), in ms, value via stateToNumber + transformValue.
   *   Timestamps never go backwards (clamped to the last point). Skipped if the value equals the
   *   last point's value and the timestamp didn't advance; same timestamp + new value replaces.
   *   Grouped series: the new raw point is added to `rawTail` and the open bucket is
   *   re-aggregated with groupBy (same bucket -> last point replaced; new bucket -> empty buckets
   *   in between filled per groupBy rules, new point pushed, `rawTail` restarted).
   * Statistics series only get `latest` updated.
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
      for (const d of list) if (this._applyState(d, st, getZone)) changed = true;
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

  private _applyState(d: SeriesData, st: HassEntityState, getZone: () => string | undefined): boolean {
    const s = d.series;
    let changed = false;
    if (d.error !== undefined && d.error === `Entity not found: ${s.entity}`) {
      // The entity appeared after the load: adopt its metadata.
      d.error = undefined;
      if (s.name === undefined && typeof st.attributes?.friendly_name === 'string') d.name = st.attributes.friendly_name;
      if (d.unit === undefined && !s.attribute && typeof st.attributes?.unit_of_measurement === 'string') {
        d.unit = st.attributes.unit_of_measurement;
      }
      changed = true;
    }
    const raw = s.attribute ? st.attributes?.[s.attribute] : st.state;
    const v = transformValue(stateToNumber(raw), s.transform);
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

  private _appendGrouped(d: SeriesData, t: number, v: number | null, getZone: () => string | undefined): boolean {
    const g = d.series.groupBy;
    if (!g) return false;
    const tail = d.rawTail ?? [];
    const lastRaw = tail[tail.length - 1];
    let newTail: Point[];
    if (lastRaw) {
      if (t < lastRaw[0]) t = lastRaw[0];
      if (t === lastRaw[0]) {
        if (lastRaw[1] === v) return false;
        newTail = [...tail.slice(0, -1), [t, v]];
      } else newTail = [...tail, [t, v]];
    } else newTail = [[t, v]];

    const zone = getZone();
    // Buckets from the previously open bucket onwards are (re)computed; older ones stay.
    const from = lastRaw ? bucketStart(lastRaw[0], g.durationMs, zone) : Number.NEGATIVE_INFINITY;
    const regrouped = groupBy(newTail, g.func, g.durationMs, zone).filter((p) => p[0] >= from);
    const pts = d.points;
    let k = pts.length;
    while (k > 0 && pts[k - 1][0] >= from) k--;
    pts.splice(k, pts.length - k, ...regrouped);
    d.rawTail = lastBucketTail(newTail, g.durationMs, zone);
    return true;
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
