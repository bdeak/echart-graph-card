import { notImplemented } from '../stub';
import type { HomeAssistant, SeriesData } from '../types';

/**
 * Incrementally extends loaded series from `hass.states` changes (no refetch).
 *
 * Usage (card): after every (re)fetch call `reset(data, hass)`; on each `hass` set call
 * `append(hass)` and, if it returns true, schedule a throttled redraw; before redrawing call
 * `trim(now - cfg.spanMs)`.
 *
 * The SeriesData objects passed to reset() are owned by the buffer and mutated in place
 * (`points`, `rawTail`, `latest`); `data` exposes them.
 */
export class LiveBuffer {
  private _data: SeriesData[] = [];
  /** entity_id -> last seen `last_updated` (ISO string). */
  private readonly _lastUpdated = new Map<string, string>();

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
    notImplemented('LiveBuffer.reset', hass);
  }

  /**
   * For every tracked entity whose `last_updated` changed since the last call:
   * - update `latest` of every series on that entity (transform applied);
   * - for `source: 'history'` series, append a point at `last_changed` (state series) or
   *   `last_updated` (attribute series), in ms, value via stateToNumber + transformValue.
   *   Skip if the value equals the last point's value and timestamp didn't advance.
   *   Grouped series: add to `rawTail`; same bucket -> replace the last point with the
   *   re-aggregated bucket, new bucket -> start a new `rawTail` and push a new point.
   * Statistics series only get `latest` updated.
   * Returns true if any series' points or latest changed.
   */
  append(hass: HomeAssistant): boolean {
    return notImplemented('LiveBuffer.append', hass, this._lastUpdated);
  }

  /**
   * Drop points older than `windowStart` (ms) from every series, keeping the last point at or
   * before `windowStart` (re-stamped to `windowStart`) so lines still start at the left edge.
   * Returns true if anything was removed.
   */
  trim(windowStart: number): boolean {
    return notImplemented('LiveBuffer.trim', windowStart);
  }
}
