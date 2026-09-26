import { fetchHistory, isBinaryEntity, isExternalStatistic, isValidEntityId, seriesValue } from './history';
import { fetchStatistics, fetchStatisticsMetadata } from './statistics';
import type { StatisticMetadata } from './statistics';
import { applyTransform, bucketStart, bucketTimeZone, clipToWindow, groupBy, lastBucketTail, transformValue } from './transform';
import { attributeUnit } from './units';
import type { HomeAssistant, NormalizedConfig, NormalizedSeries, Point, SeriesData, StatisticsPeriod } from '../types';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

type Source = 'history' | 'statistics';

/** Options of loadSeriesData. */
export interface LoadOptions {
  /**
   * Load only the series with these keys (e.g. the card's statistics-only refresh). The result
   * then contains just those series, in cfg.series order.
   */
  only?: ReadonlySet<string>;
}

/**
 * Backend for one series before any fetch:
 * - external statistics (`source:id`) only exist in long-term statistics;
 * - attribute series always use history (statistics only exist for states);
 * - an explicit `statistic` column asks for statistics, whatever the window;
 * - forced `history` -> history;
 * - `statistics` + `dataSourceAuto`: entities present in hass.states without a `state_class`
 *   can't have long-term statistics -> straight to history (saves a round trip);
 * - otherwise statistics.
 */
function plannedSource(s: NormalizedSeries, cfg: NormalizedConfig, hass: HomeAssistant): Source {
  if (isExternalStatistic(s.entity)) return 'statistics';
  if (s.attribute) return 'history';
  if (s.statistic !== 'auto') return 'statistics';
  if (cfg.dataSource === 'history') return 'history';
  if (cfg.dataSourceAuto) {
    const st = hass.states?.[s.entity];
    if (st && !st.attributes?.state_class) return 'history';
  }
  return 'statistics';
}

/**
 * Whether a statistics series without values may be retried from history: only in auto mode,
 * never for external statistics (no history exists) or an explicit `statistic` column (history
 * would silently plot a different quantity, e.g. the meter reading instead of the usage).
 */
function canFallBack(s: NormalizedSeries, cfg: NormalizedConfig): boolean {
  return cfg.dataSourceAuto && s.statistic === 'auto' && !isExternalStatistic(s.entity);
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
 * History for `series` over [start, end]: one call for all state-based series (deduped
 * entities) plus one call per distinct attribute, in parallel. Returns raw (untransformed)
 * points by series key. Ids Home Assistant would reject (neither in hass.states nor a valid
 * entity id: HA answers `invalid_entity_ids` for the WHOLE call) are left out and get `[]`.
 */
async function loadHistory(hass: HomeAssistant, series: NormalizedSeries[], start: number, end: Date): Promise<Record<string, Point[]>> {
  if (series.length === 0) return {};
  const states = hass.states ?? {};
  const startDate = new Date(start);
  const stateIds: string[] = [];
  const byAttr = new Map<string, string[]>();
  for (const s of series) {
    if (states[s.entity] === undefined && !isValidEntityId(s.entity)) continue;
    if (s.attribute) {
      const ids = byAttr.get(s.attribute);
      if (ids) ids.push(s.entity);
      else byAttr.set(s.attribute, [s.entity]);
    } else stateIds.push(s.entity);
  }
  const attrs = [...byAttr.keys()];
  const [stateRes, ...attrRes] = await Promise.all([
    fetchHistory(hass, stateIds, startDate, end),
    ...attrs.map((a) => fetchHistory(hass, byAttr.get(a) ?? [], startDate, end, { attribute: a })),
  ]);
  const attrMaps = new Map(attrs.map((a, i) => [a, attrRes[i]]));
  const out: Record<string, Point[]> = {};
  for (const s of series) {
    const m = s.attribute ? attrMaps.get(s.attribute) : stateRes;
    out[s.key] = m?.[s.entity] ?? [];
  }
  return out;
}

/**
 * Recorder history of `series` over [start, end] as TRANSFORMED, ungrouped points by series key
 * (one batched call, see loadHistory). Used by the card to backfill a gap in the live feed
 * (LiveBuffer.backfill). The first point of each series is the state valid at `start`, stamped
 * `start`. Rejects when a WebSocket call fails.
 */
export async function loadHistoryRange(
  hass: HomeAssistant,
  series: NormalizedSeries[],
  start: number,
  end: Date,
): Promise<Record<string, Point[]>> {
  const raw = await loadHistory(hass, series, start, end);
  const out: Record<string, Point[]> = {};
  for (const s of series) out[s.key] = applyTransform(raw[s.key] ?? [], s.transform);
  return out;
}

const hasValues = (pts: Point[] | undefined): boolean => !!pts && pts.some((p) => p[1] !== null);

const nonEmpty = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** Unit of the entity's current state (attribute series: attributeUnit). */
function stateUnitOf(s: NormalizedSeries, hass: HomeAssistant): string | undefined {
  if (s.attribute) return attributeUnit(s.entity, s.attribute, hass);
  return nonEmpty(hass.states?.[s.entity]?.attributes?.unit_of_measurement);
}

/**
 * Load every series of `cfg` for the window [now - cfg.spanMs, now].
 *
 * Source selection (per series, see plannedSource):
 * - history: one fetchHistory call for all state-based series (deduped entities), plus one call
 *   per distinct `attribute`.
 * - statistics: one fetchStatistics call (period cfg.statisticsPeriod) plus, in parallel, the
 *   statistics metadata. Series whose statistics are kept in another unit than the entity's state
 *   (display unit changed in HA) are fetched again with `units` so they match the state unit; if
 *   that is impossible they are labelled with the statistics unit. With `cfg.dataSourceAuto`,
 *   series whose statistics have no values fall back to history for the same window (batched),
 *   except external statistics and explicit `statistic` columns.
 * - Fetches start early enough that the first group_by bucket / statistics row covering the
 *   window start is complete; results are clipped so each series starts with the point that
 *   covers the left edge (raw history re-stamped to the window start).
 * - group_by buckets and day-aligned statistics use the HA profile time zone (bucketTimeZone).
 *
 * Per series, in this order: applyTransform -> groupBy (if `series.groupBy`) -> SeriesData.
 * For grouped history series, `rawTail` = transformed raw points of the last bucket (preceded
 * by the carried-in point, see lastBucketTail).
 * `name` = series.name ?? friendly_name ?? statistics metadata name ?? entity;
 * `unit` = series.unit ?? (statistics unit when not convertible) ?? state unit_of_measurement
 * (attribute series: attributeUnit) ?? statistics metadata unit;
 * `isBinary` via isBinaryEntity; `latest` from hass.states (transformed); `source` = the
 * backend actually used. Entities missing from hass.states AND without data get
 * `error: 'Entity not found: <id>'` and `points: []`; statistics series without values that
 * cannot fall back get a hint in `error`.
 *
 * Result is aligned with cfg.series (same length/order, hidden series included), or with the
 * `opts.only` subset. Every SeriesData owns fresh `points` / `rawTail` arrays (safe for
 * LiveBuffer to mutate). Rejects only when a data WebSocket call fails (the card shows the error).
 */
export async function loadSeriesData(hass: HomeAssistant, cfg: NormalizedConfig, now: Date, opts: LoadOptions = {}): Promise<SeriesData[]> {
  const nowMs = now.getTime();
  const windowStart = nowMs - cfg.spanMs;
  const zone = bucketTimeZone(hass);
  const only = opts.only;
  const list = only ? cfg.series.filter((s) => only.has(s.key)) : cfg.series;

  const sources = new Map<string, Source>(list.map((s) => [s.key, plannedSource(s, cfg, hass)]));
  const histSeries = list.filter((s) => sources.get(s.key) === 'history');
  const statSeries = list.filter((s) => sources.get(s.key) === 'statistics');
  const statStart = new Date(statisticsStart(windowStart, cfg.statisticsPeriod, statSeries, zone));

  const [histRaw, statRaw, meta] = await Promise.all([
    loadHistory(hass, histSeries, alignedStart(windowStart, histSeries, zone), now),
    statSeries.length ? fetchStatistics(hass, statSeries, statStart, now, cfg.statisticsPeriod) : Promise.resolve({} as Record<string, Point[]>),
    fetchStatisticsMetadata(
      hass,
      statSeries.map((s) => s.entity),
    ),
  ]);

  // Statistics kept in another unit than the state (HA keeps compiling in the metadata unit when
  // the display unit changes): convert them into the state unit, or label them with their own.
  const unitOverride = new Map<string, string>();
  const groups: Array<{ units: Record<string, string>; series: NormalizedSeries[] }> = [];
  for (const s of statSeries) {
    const m = meta[s.entity];
    const statUnit = nonEmpty(m?.statistics_unit_of_measurement);
    const stateUnit = stateUnitOf(s, hass);
    if (!m || !statUnit || !stateUnit || statUnit === stateUnit) continue;
    const cls = nonEmpty(m.unit_class);
    if (!cls) {
      unitOverride.set(s.key, statUnit);
      continue;
    }
    let g = groups.find((x) => x.units[cls] === undefined || x.units[cls] === stateUnit);
    if (!g) {
      g = { units: {}, series: [] };
      groups.push(g);
    }
    g.units[cls] = stateUnit;
    g.series.push(s);
  }
  if (groups.length) {
    const converted = await Promise.all(
      groups.map((g) => fetchStatistics(hass, g.series, statStart, now, cfg.statisticsPeriod, g.units).catch(() => undefined)),
    );
    groups.forEach((g, i) => {
      const res = converted[i];
      for (const s of g.series) {
        if (res) statRaw[s.key] = res[s.key] ?? [];
        else unitOverride.set(s.key, meta[s.entity]?.statistics_unit_of_measurement as string);
      }
    });
  }

  const raw: Record<string, Point[]> = { ...histRaw, ...statRaw };
  const fallback = statSeries.filter((s) => canFallBack(s, cfg) && !hasValues(statRaw[s.key]));
  if (fallback.length) {
    const fb = await loadHistory(hass, fallback, alignedStart(windowStart, fallback, zone), now);
    for (const s of fallback) {
      sources.set(s.key, 'history');
      raw[s.key] = fb[s.key] ?? [];
      unitOverride.delete(s.key);
    }
  }

  return list.map((s) =>
    buildSeriesData(s, sources.get(s.key) ?? 'history', raw[s.key] ?? [], hass, cfg, meta, unitOverride.get(s.key), windowStart, zone),
  );
}

function buildSeriesData(
  s: NormalizedSeries,
  source: Source,
  rawPoints: Point[],
  hass: HomeAssistant,
  cfg: NormalizedConfig,
  meta: Record<string, StatisticMetadata>,
  unitOverride: string | undefined,
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
  const external = isExternalStatistic(s.entity);
  const friendly = nonEmpty(st?.attributes?.friendly_name);
  const name = s.name ?? friendly ?? (m?.name || undefined) ?? s.entity;
  const unit = s.unit ?? unitOverride ?? stateUnitOf(s, hass) ?? (m?.statistics_unit_of_measurement || undefined);

  const data: SeriesData = {
    series: s,
    points,
    unit,
    name,
    isBinary: isBinaryEntity(s.entity, st, s.attribute),
    latest: st ? transformValue(seriesValue(s.entity, s.attribute ? st.attributes?.[s.attribute] : st.state, s.attribute), s.transform) : undefined,
    source,
  };
  if (rawTail) data.rawTail = rawTail;
  if (!st && !external && points.length === 0) data.error = `Entity not found: ${s.entity}`;
  else if (source === 'statistics' && !hasValues(points) && !canFallBack(s, cfg)) {
    data.error = external
      ? `No long-term statistics for ${s.entity} in this period`
      : `No long-term statistics for ${s.entity} in this period (does it have a state_class?)`;
  }
  return data;
}
