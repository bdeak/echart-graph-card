import { fetchHistory, isBinaryEntity, stateToNumber } from './history';
import { fetchStatistics, fetchStatisticsMetadata } from './statistics';
import type { StatisticMetadata } from './statistics';
import { applyTransform, bucketStart, bucketTimeZone, clipToWindow, groupBy, lastBucketTail, transformValue } from './transform';
import type { HomeAssistant, NormalizedConfig, NormalizedSeries, Point, SeriesData, StatisticsPeriod } from '../types';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

type Source = 'history' | 'statistics';

/**
 * Backend for one series before any fetch:
 * - forced `history` -> history; attribute series always use history (statistics only exist
 *   for states);
 * - `statistics` + `dataSourceAuto`: entities present in hass.states without a `state_class`
 *   can't have long-term statistics -> straight to history (saves a round trip);
 * - otherwise statistics (external `source:id` statistics included).
 */
function plannedSource(s: NormalizedSeries, cfg: NormalizedConfig, hass: HomeAssistant): Source {
  if (cfg.dataSource === 'history' || s.attribute) return 'history';
  if (cfg.dataSourceAuto) {
    const st = hass.states?.[s.entity];
    if (st && !st.attributes?.state_class) return 'history';
  }
  return 'statistics';
}

/** Earliest bucket start needed so the first bucket overlapping the window is complete. */
function alignedStart(windowStart: number, series: NormalizedSeries[], zone: string | undefined): number {
  let start = windowStart;
  for (const s of series) if (s.groupBy) start = Math.min(start, bucketStart(windowStart, s.groupBy.durationMs, zone));
  return start;
}

/**
 * Statistics fetch start: one period before the window start (the row covering the left edge
 * is then included; HA only returns rows starting at/after start_time), aligned to local
 * midnight for day/week/month periods, and to group_by buckets.
 */
function statisticsStart(windowStart: number, period: StatisticsPeriod, series: NormalizedSeries[], zone: string | undefined): number {
  let start: number;
  switch (period) {
    case '5minute':
      start = windowStart - 5 * MINUTE_MS;
      break;
    case 'hour':
      start = windowStart - HOUR_MS;
      break;
    case 'day':
      start = bucketStart(windowStart - DAY_MS, DAY_MS, zone);
      break;
    case 'week':
      start = bucketStart(windowStart - 7 * DAY_MS, DAY_MS, zone);
      break;
    default:
      start = bucketStart(windowStart - 31 * DAY_MS, DAY_MS, zone);
      break;
  }
  return Math.min(start, alignedStart(windowStart, series, zone));
}

/**
 * History for `series` over [aligned window start, end]: one call for all state-based series
 * (deduped entities) plus one call per distinct attribute, in parallel. Returns raw
 * (untransformed) points by series key.
 */
async function loadHistory(
  hass: HomeAssistant,
  series: NormalizedSeries[],
  windowStart: number,
  end: Date,
  zone: string | undefined,
): Promise<Record<string, Point[]>> {
  if (series.length === 0) return {};
  const start = new Date(alignedStart(windowStart, series, zone));
  const stateIds: string[] = [];
  const byAttr = new Map<string, string[]>();
  for (const s of series) {
    if (s.attribute) {
      const ids = byAttr.get(s.attribute);
      if (ids) ids.push(s.entity);
      else byAttr.set(s.attribute, [s.entity]);
    } else stateIds.push(s.entity);
  }
  const attrs = [...byAttr.keys()];
  const [stateRes, ...attrRes] = await Promise.all([
    fetchHistory(hass, stateIds, start, end),
    ...attrs.map((a) => fetchHistory(hass, byAttr.get(a) ?? [], start, end, { attribute: a })),
  ]);
  const attrMaps = new Map(attrs.map((a, i) => [a, attrRes[i]]));
  const out: Record<string, Point[]> = {};
  for (const s of series) {
    const m = s.attribute ? attrMaps.get(s.attribute) : stateRes;
    out[s.key] = m?.[s.entity] ?? [];
  }
  return out;
}

const hasValues = (pts: Point[] | undefined): boolean => !!pts && pts.some((p) => p[1] !== null);

/**
 * Load every series of `cfg` for the window [now - cfg.spanMs, now].
 *
 * Source selection:
 * - `cfg.dataSource === 'history'`: one fetchHistory call for all state-based series
 *   (deduped entities), plus one call per distinct `attribute`.
 * - `cfg.dataSource === 'statistics'`: one fetchStatistics call (period cfg.statisticsPeriod).
 *   Attribute series always use history. With `cfg.dataSourceAuto`, entities in hass.states
 *   without a `state_class` go straight to history, and series whose statistics have no values
 *   fall back to history for the same window (batched).
 * - Fetches start early enough that the first group_by bucket / statistics row covering the
 *   window start is complete; results are clipped so each series starts with the point that
 *   covers the left edge (raw history re-stamped to the window start).
 * - group_by buckets and day-aligned statistics use the HA profile time zone (bucketTimeZone).
 *
 * Per series, in this order: applyTransform -> groupBy (if `series.groupBy`) -> SeriesData.
 * For grouped history series, `rawTail` = transformed raw points of the last bucket (preceded
 * by the carried-in point, see lastBucketTail).
 * `name` = series.name ?? friendly_name ?? statistics metadata name ?? entity;
 * `unit` = series.unit ?? unit_of_measurement (state series only) ?? statistics metadata unit;
 * `isBinary` via isBinaryEntity; `latest` from hass.states (transformed); `source` = the
 * backend actually used. Entities missing from hass.states AND without data get
 * `error: 'Entity not found: <id>'` and `points: []`; forced statistics without values get a
 * hint in `error`.
 *
 * Result is aligned with cfg.series (same length/order, hidden series included). Every
 * SeriesData owns fresh `points` / `rawTail` arrays (safe for LiveBuffer to mutate).
 * Rejects only when a data WebSocket call fails (the card shows the error).
 */
export async function loadSeriesData(hass: HomeAssistant, cfg: NormalizedConfig, now: Date): Promise<SeriesData[]> {
  const nowMs = now.getTime();
  const windowStart = nowMs - cfg.spanMs;
  const zone = bucketTimeZone(hass);
  const states = hass.states ?? {};

  const sources: Source[] = cfg.series.map((s) => plannedSource(s, cfg, hass));
  const histSeries = cfg.series.filter((_, i) => sources[i] === 'history');
  const statSeries = cfg.series.filter((_, i) => sources[i] === 'statistics');
  const metaIds = statSeries.filter((s) => !states[s.entity]).map((s) => s.entity);

  const [histRaw, statRaw, meta] = await Promise.all([
    loadHistory(hass, histSeries, windowStart, now, zone),
    statSeries.length
      ? fetchStatistics(hass, statSeries, new Date(statisticsStart(windowStart, cfg.statisticsPeriod, statSeries, zone)), now, cfg.statisticsPeriod)
      : Promise.resolve({} as Record<string, Point[]>),
    fetchStatisticsMetadata(hass, metaIds),
  ]);

  const raw: Record<string, Point[]> = { ...histRaw, ...statRaw };
  if (cfg.dataSourceAuto) {
    const fallback = statSeries.filter((s) => !hasValues(statRaw[s.key]));
    if (fallback.length) {
      const fb = await loadHistory(hass, fallback, windowStart, now, zone);
      for (const s of fallback) {
        sources[s.index] = 'history';
        raw[s.key] = fb[s.key] ?? [];
      }
    }
  }

  return cfg.series.map((s, i) => buildSeriesData(s, sources[i], raw[s.key] ?? [], hass, cfg, meta, windowStart, zone));
}

function buildSeriesData(
  s: NormalizedSeries,
  source: Source,
  rawPoints: Point[],
  hass: HomeAssistant,
  cfg: NormalizedConfig,
  meta: Record<string, StatisticMetadata>,
  windowStart: number,
  zone: string | undefined,
): SeriesData {
  const st = hass.states?.[s.entity];
  let tr = applyTransform(rawPoints, s.transform);
  if (tr === rawPoints) tr = rawPoints.slice(); // never share arrays between series

  let points: Point[];
  let rawTail: Point[] | undefined;
  if (s.groupBy) {
    const { func, durationMs } = s.groupBy;
    points = clipToWindow(groupBy(tr, func, durationMs, zone), windowStart, false);
    if (source === 'history') rawTail = lastBucketTail(tr, durationMs, zone);
  } else {
    points = clipToWindow(tr, windowStart, source === 'history');
  }

  const m = source === 'statistics' ? meta[s.entity] : undefined;
  const friendly = st?.attributes?.friendly_name;
  const stateUnit = s.attribute ? undefined : st?.attributes?.unit_of_measurement;
  const name = s.name ?? (typeof friendly === 'string' && friendly ? friendly : undefined) ?? (m?.name || undefined) ?? s.entity;
  const unit =
    s.unit ?? (typeof stateUnit === 'string' && stateUnit ? stateUnit : undefined) ?? (m?.statistics_unit_of_measurement || undefined);

  const data: SeriesData = {
    series: s,
    points,
    unit,
    name,
    isBinary: isBinaryEntity(s.entity, st, s.attribute),
    latest: st ? transformValue(stateToNumber(s.attribute ? st.attributes?.[s.attribute] : st.state), s.transform) : undefined,
    source,
  };
  if (rawTail) data.rawTail = rawTail;
  if (!st && points.length === 0) data.error = `Entity not found: ${s.entity}`;
  else if (source === 'statistics' && !cfg.dataSourceAuto && !hasValues(points)) {
    data.error = `No long-term statistics for ${s.entity} in this period (does it have a state_class?)`;
  }
  return data;
}
