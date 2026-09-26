import type {
  HomeAssistant,
  NormalizedSeries,
  Point,
  StatisticType,
  StatisticValue,
  StatisticsDuringPeriodMessage,
  StatisticsPeriod,
  StatisticsResponse,
} from '../types';

/** Metadata row of `recorder/get_statistics_metadata` (only the fields we use). */
export interface StatisticMetadata {
  statistic_id: string;
  statistics_unit_of_measurement?: string | null;
  /** Unit converter class (`power`, `energy`, `temperature`, ...); null = not convertible. */
  unit_class?: string | null;
  name?: string | null;
  has_mean?: boolean;
  has_sum?: boolean;
}

/**
 * Resolve NormalizedSeries.statistic `'auto'`: `'state'` when the entity's `state_class` is
 * `total` or `total_increasing`, otherwise `'mean'`. Explicit types are returned unchanged.
 */
export function resolveStatisticType(series: NormalizedSeries, hass: HomeAssistant): StatisticType {
  if (series.statistic !== 'auto') return series.statistic;
  const sc = hass.states?.[series.entity]?.attributes?.state_class;
  return sc === 'total' || sc === 'total_increasing' ? 'state' : 'mean';
}

/**
 * Columns tried in order for a series. Explicit `statistic` -> exactly that column. `auto` ->
 * the resolved column first, then fallbacks for statistics that lack it (e.g. external
 * statistics without a hass.states entity only have `state`/`sum`, sum-type stats have no mean).
 */
export function statisticCandidates(series: NormalizedSeries, hass: HomeAssistant): StatisticType[] {
  const primary = resolveStatisticType(series, hass);
  if (series.statistic !== 'auto') return [primary];
  return primary === 'mean' ? ['mean', 'state', 'sum'] : ['state', 'sum', 'mean'];
}

/** Row `start` (epoch ms; older HA: ISO string; defensive: epoch seconds) -> ms, NaN if invalid. */
function rowTime(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? (Math.abs(v) < 1e11 ? Math.round(v * 1000) : v) : Number.NaN;
  if (typeof v === 'string') return Date.parse(v);
  return Number.NaN;
}

function rowValue(row: StatisticValue, col: StatisticType): number | null {
  const v = row[col];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function rowsToPoints(rows: StatisticValue[], col: StatisticType): Point[] {
  const out: Point[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const t = rowTime(row.start);
    if (Number.isNaN(t)) continue;
    out.push([t, rowValue(row, col)]);
  }
  out.sort((a, b) => a[0] - b[0]);
  // Dedupe equal timestamps (keep last).
  const dedup: Point[] = [];
  for (const p of out) {
    if (dedup.length && dedup[dedup.length - 1][0] === p[0]) dedup[dedup.length - 1] = p;
    else dedup.push(p);
  }
  return dedup;
}

/**
 * Fetch long-term statistics for `series` over [start, end] in ONE WebSocket call:
 * `{ type: 'recorder/statistics_during_period', start_time, end_time,
 *    statistic_ids: <deduped series entities>, period, types: <deduped candidate columns> }`
 * (see StatisticsDuringPeriodMessage / StatisticsResponse in types.ts).
 *
 * Returns `series.key -> Point[]` (every series key present, `[]` if no rows) using
 * `row[resolveStatisticType(series)]` (missing/NaN -> null) at timestamp `row.start`
 * (epoch ms; ISO strings from older HA are parsed). For `statistic: auto` series whose
 * resolved column has no values at all, the first fallback column with values is used
 * (see statisticCandidates). transform/group_by are NOT applied here.
 * `units` (unit class -> unit, e.g. `{ power: 'kW' }`) asks HA to convert the rows; without it
 * rows come in the statistics metadata unit (`statistics_unit_of_measurement`).
 * Rejects if callWS rejects. Empty `series` resolves to `{}` without a call.
 */
export async function fetchStatistics(
  hass: HomeAssistant,
  series: NormalizedSeries[],
  start: Date,
  end: Date,
  period: StatisticsPeriod,
  units?: Record<string, string>,
): Promise<Record<string, Point[]>> {
  if (series.length === 0) return {};
  const ids = [...new Set(series.map((s) => s.entity))];
  const candidates = new Map<string, StatisticType[]>();
  const types = new Set<StatisticType>();
  for (const s of series) {
    const c = statisticCandidates(s, hass);
    candidates.set(s.key, c);
    for (const t of c) types.add(t);
  }
  const msg: StatisticsDuringPeriodMessage = {
    type: 'recorder/statistics_during_period',
    start_time: start.toISOString(),
    end_time: end.toISOString(),
    statistic_ids: ids,
    period,
    types: [...types],
  };
  if (units && Object.keys(units).length) msg.units = units;
  const res = await hass.callWS<StatisticsResponse | null>(msg);
  const out: Record<string, Point[]> = {};
  for (const s of series) {
    const rows = res?.[s.entity];
    if (!Array.isArray(rows) || rows.length === 0) {
      out[s.key] = [];
      continue;
    }
    const cols = candidates.get(s.key) ?? ['mean'];
    let pts = rowsToPoints(rows, cols[0]);
    for (let i = 1; i < cols.length && !pts.some((p) => p[1] !== null); i++) {
      const alt = rowsToPoints(rows, cols[i]);
      if (alt.some((p) => p[1] !== null)) pts = alt;
    }
    out[s.key] = pts;
  }
  return out;
}

/**
 * `recorder/get_statistics_metadata` for `ids` -> `statistic_id -> metadata`. Used for the
 * unit/name of external statistics that have no hass.states entity, and to detect statistics
 * kept in another unit than the entity's current state. Resolves `{}` on any error (metadata is
 * optional) and for empty `ids` without a call.
 */
export async function fetchStatisticsMetadata(hass: HomeAssistant, ids: string[]): Promise<Record<string, StatisticMetadata>> {
  const uniq = [...new Set(ids)];
  if (uniq.length === 0) return {};
  try {
    const res = await hass.callWS<StatisticMetadata[] | null>({ type: 'recorder/get_statistics_metadata', statistic_ids: uniq });
    const out: Record<string, StatisticMetadata> = {};
    if (Array.isArray(res)) for (const m of res) if (m && typeof m.statistic_id === 'string') out[m.statistic_id] = m;
    return out;
  } catch {
    return {};
  }
}
