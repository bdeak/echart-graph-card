import { notImplemented } from '../stub';
import type { HomeAssistant, NormalizedConfig, SeriesData } from '../types';

/**
 * Load every series of `cfg` for the window [now - cfg.spanMs, now].
 *
 * Source selection:
 * - `cfg.dataSource === 'history'`: one fetchHistory call for all state-based series
 *   (deduped entities), plus one call per distinct `attribute`.
 * - `cfg.dataSource === 'statistics'`: one fetchStatistics call (period cfg.statisticsPeriod).
 *   If `cfg.dataSourceAuto` and a series got no rows (entity has no long-term statistics),
 *   that series falls back to history for the same window (batched).
 *
 * Per series, in this order: applyTransform -> groupBy (if `series.groupBy`) -> SeriesData.
 * For grouped history series, `rawTail` = transformed raw points of the last bucket.
 * `name` = series.name ?? friendly_name ?? entity; `unit` = series.unit ?? unit_of_measurement;
 * `isBinary` via isBinaryEntity; `latest` from hass.states (transformed); `source` = the
 * backend actually used. Entities missing from hass.states AND without data get
 * `error: 'Entity not found: <id>'` and `points: []`.
 *
 * Result is aligned with cfg.series (same length/order, hidden series included).
 * Rejects only when a WebSocket call fails (the card shows the error).
 */
export async function loadSeriesData(hass: HomeAssistant, cfg: NormalizedConfig, now: Date): Promise<SeriesData[]> {
  return notImplemented('loadSeriesData', hass, cfg, now);
}
