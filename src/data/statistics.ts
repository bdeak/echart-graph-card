import { notImplemented } from '../stub';
import type { HomeAssistant, NormalizedSeries, Point, StatisticType, StatisticsPeriod } from '../types';

/**
 * Resolve NormalizedSeries.statistic `'auto'`: `'state'` when the entity's `state_class` is
 * `total` or `total_increasing`, otherwise `'mean'`. Explicit types are returned unchanged.
 */
export function resolveStatisticType(series: NormalizedSeries, hass: HomeAssistant): StatisticType {
  return notImplemented('resolveStatisticType', series, hass);
}

/**
 * Fetch long-term statistics for `series` over [start, end] in ONE WebSocket call:
 * `{ type: 'recorder/statistics_during_period', start_time, end_time,
 *    statistic_ids: <deduped series entities>, period, types: <deduped resolved types> }`
 * (see StatisticsDuringPeriodMessage / StatisticsResponse in types.ts).
 *
 * Returns `series.key -> Point[]` (every series key present, `[]` if no rows) using
 * `row[resolveStatisticType(series)]` (missing/NaN -> null) at timestamp `row.start`
 * (epoch ms; ISO strings from older HA are parsed). transform/group_by are NOT applied here.
 * Rejects if callWS rejects. Empty `series` resolves to `{}` without a call.
 */
export async function fetchStatistics(
  hass: HomeAssistant,
  series: NormalizedSeries[],
  start: Date,
  end: Date,
  period: StatisticsPeriod,
): Promise<Record<string, Point[]>> {
  return notImplemented('fetchStatistics', hass, series, start, end, period);
}
