import { DEFAULT_PALETTE } from './chart/theme';
import { BINARY_DOMAINS } from './data/history';
import type {
  AxisPosition,
  CardConfig,
  ColorThreshold,
  DataSource,
  FillMode,
  GroupByConfig,
  GroupByFunc,
  LineStyle,
  NormalizedConfig,
  NormalizedGroupBy,
  NormalizedLine,
  NormalizedSeries,
  NormalizedShow,
  NormalizedThreshold,
  NormalizedUpdate,
  NormalizedYAxis,
  SeriesConfig,
  StatisticType,
  StatisticsPeriod,
  StepMode,
} from './types';

// ---------------------------------------------------------------------------
// Constants (exported so other modules / tests share one source of truth)
// ---------------------------------------------------------------------------

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
export const WEEK = 7 * DAY;

export const DEFAULTS = {
  spanMs: 24 * HOUR,
  height: '220px',
  /** data_source: auto uses history up to and including this span. */
  autoHistoryMaxSpanMs: 72 * HOUR,
  /** update: live -> periodic full refetch / re-anchor. */
  liveRefreshMs: 5 * MINUTE,
  lineWidth: 2,
  binaryLineWidth: 1.5,
  smooth: 0.35,
  /** fill defaults to gradient when the card has at most this many series. */
  autoFillMaxSeries: 2,
  gradientOpacity: 0.35,
  solidOpacity: 0.2,
  thresholdLineOpacity: 0.8,
  thresholdAreaOpacity: 0.12,
} as const;

export const GROUP_BY_FUNCS: readonly GroupByFunc[] = ['avg', 'min', 'max', 'first', 'last', 'sum', 'delta', 'median'];
export const FILL_MODES: readonly FillMode[] = ['none', 'solid', 'gradient'];
export const LINE_STYLES: readonly LineStyle[] = ['solid', 'dashed', 'dotted'];
export const DATA_SOURCES: readonly DataSource[] = ['auto', 'history', 'statistics'];
export const STATISTICS_PERIODS: readonly StatisticsPeriod[] = ['5minute', 'hour', 'day', 'week', 'month'];
export const STATISTIC_TYPES: readonly StatisticType[] = ['mean', 'min', 'max', 'sum', 'state', 'change'];

// ---------------------------------------------------------------------------
// Duration parsing
// ---------------------------------------------------------------------------

const UNIT_MS: Record<string, number> = {
  ms: 1,
  millisecond: 1,
  milliseconds: 1,
  s: SECOND,
  sec: SECOND,
  secs: SECOND,
  second: SECOND,
  seconds: SECOND,
  m: MINUTE,
  min: MINUTE,
  mins: MINUTE,
  minute: MINUTE,
  minutes: MINUTE,
  h: HOUR,
  hr: HOUR,
  hrs: HOUR,
  hour: HOUR,
  hours: HOUR,
  d: DAY,
  day: DAY,
  days: DAY,
  w: WEEK,
  week: WEEK,
  weeks: WEEK,
};

/**
 * Parse a duration into milliseconds.
 *
 * - number, or purely numeric string: multiplied by `bareNumberUnitMs` (default: seconds).
 * - string: one or more `<number><unit>` groups, e.g. `"30s"`, `"5m"`, `"1h30m"`, `"1.5h"`,
 *   `"7d"`, `"2w"`, `"500ms"`, `"10 minutes"`. Case-insensitive; whitespace allowed.
 *
 * Returns 0 for zero durations (callers decide whether 0 is valid).
 * Throws an Error with a friendly message for negative, non-finite or unparseable input.
 */
export function parseDuration(v: string | number, bareNumberUnitMs: number = SECOND): number {
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v < 0) throw new Error(`Invalid duration ${String(v)}: must be a non-negative number`);
    return Math.round(v * bareNumberUnitMs);
  }
  if (typeof v !== 'string') throw new Error(`Invalid duration ${JSON.stringify(v)}: expected e.g. "30s", "5m", "24h", "7d"`);
  const s = v.trim().toLowerCase();
  if (s === '') throw new Error('Invalid duration "": expected e.g. "30s", "5m", "24h", "7d"');
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * bareNumberUnitMs);

  const re = /(\d+(?:\.\d+)?)\s*([a-z]+)\s*/y;
  let total = 0;
  let pos = 0;
  while (pos < s.length) {
    re.lastIndex = pos;
    const m = re.exec(s);
    const unit = m ? UNIT_MS[m[2]] : undefined;
    if (!m || unit === undefined) {
      throw new Error(`Invalid duration "${v}": expected e.g. "30s", "5m", "1h30m", "24h", "7d"`);
    }
    total += Number(m[1]) * unit;
    pos = re.lastIndex;
  }
  return Math.round(total);
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

type Obj = Record<string, unknown>;

function fail(path: string, msg: string): never {
  throw new Error(`Invalid config: ${path} ${msg}`);
}

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function optNumber(v: unknown, path: string, opts: { min?: number; max?: number } = {}): number | undefined {
  if (v === undefined || v === null) return undefined;
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) fail(path, `must be a number (got ${JSON.stringify(v)})`);
  if (opts.min !== undefined && n < opts.min) fail(path, `must be >= ${opts.min} (got ${n})`);
  if (opts.max !== undefined && n > opts.max) fail(path, `must be <= ${opts.max} (got ${n})`);
  return n;
}

function optString(v: unknown, path: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') fail(path, `must be a string (got ${JSON.stringify(v)})`);
  const t = v.trim();
  return t === '' ? undefined : t;
}

/** Like optString, but YAML numbers (`name: 2024`) are accepted and stringified. */
function optText(v: unknown, path: string): string | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? String(v) : optString(v, path);
}

function optBool(v: unknown, path: string): boolean | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'boolean') fail(path, `must be true or false (got ${JSON.stringify(v)})`);
  return v;
}

function optEnum<T extends string>(v: unknown, allowed: readonly T[], path: string): T | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) {
    fail(path, `must be one of ${allowed.join(', ')} (got ${JSON.stringify(v)})`);
  }
  return v as T;
}

function duration(v: unknown, path: string, bareUnitMs: number): number {
  if (typeof v !== 'string' && typeof v !== 'number') fail(path, `must be a duration like "30s", "5m", "24h" (got ${JSON.stringify(v)})`);
  try {
    return parseDuration(v, bareUnitMs);
  } catch (e) {
    fail(path, (e as Error).message.replace(/^Invalid duration /, 'is an invalid duration: '));
  }
}

/** `domain.object_id` or external statistic `source:statistic_id`. */
const ENTITY_ID_RE = /^[a-z0-9_]+[.:][a-z0-9_.-]+$/i;

// ---------------------------------------------------------------------------
// Section normalizers
// ---------------------------------------------------------------------------

function normalizeGroupBy(v: unknown, path: string): NormalizedGroupBy | null {
  if (v === undefined || v === null || v === false) return null;
  if (typeof v === 'string' || typeof v === 'number') {
    const durationMs = duration(v, path, SECOND);
    if (durationMs <= 0) fail(path, 'duration must be > 0');
    return { func: 'avg', durationMs };
  }
  if (!isObj(v)) fail(path, 'must be a duration ("5m") or { func, duration }');
  const g = v as Partial<GroupByConfig>;
  const func = optEnum(g.func, GROUP_BY_FUNCS, `${path}.func`) ?? 'avg';
  if (g.duration === undefined) fail(`${path}.duration`, 'is required (e.g. "5m")');
  const durationMs = duration(g.duration, `${path}.duration`, SECOND);
  if (durationMs <= 0) fail(`${path}.duration`, 'must be > 0');
  return { func, durationMs };
}

function normalizeLine(v: unknown, path: string): NormalizedLine {
  if (v !== undefined && v !== null && !isObj(v)) fail(path, 'must be an object like { width: 2, smooth: true }');
  const l = (v ?? {}) as Obj;
  const width = optNumber(l.width, `${path}.width`, { min: 0 });

  let smooth: number = DEFAULTS.smooth;
  if (typeof l.smooth === 'boolean') smooth = l.smooth ? DEFAULTS.smooth : 0;
  else if (l.smooth !== undefined && l.smooth !== null) smooth = optNumber(l.smooth, `${path}.smooth`, { min: 0, max: 1 }) ?? DEFAULTS.smooth;

  let step: StepMode | 'auto' = 'auto';
  if (l.step === true) step = 'end';
  else if (l.step === false) step = false;
  else if (l.step !== undefined && l.step !== null) step = optEnum(l.step, ['start', 'middle', 'end'] as const, `${path}.step`) ?? 'auto';

  return {
    width: width ?? DEFAULTS.lineWidth,
    smooth,
    step,
    style: optEnum(l.style, LINE_STYLES, `${path}.style`) ?? 'solid',
  };
}

function normalizeColorThresholds(v: unknown, path: string): ColorThreshold[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) fail(path, 'must be a list of { value, color }');
  return v
    .map((t, i) => {
      if (!isObj(t)) fail(`${path}[${i}]`, 'must be { value, color }');
      const value = optNumber(t.value, `${path}[${i}].value`);
      const color = optString(t.color, `${path}[${i}].color`);
      if (value === undefined) fail(`${path}[${i}].value`, 'is required');
      if (color === undefined) fail(`${path}[${i}].color`, 'is required');
      return { value, color };
    })
    .sort((a, b) => a.value - b.value);
}

function normalizeYAxes(v: unknown): NormalizedYAxis[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) fail('y_axes', 'must be a list of axes');
  const seen = new Set<string>();
  return v.map((a, i) => {
    const path = `y_axes[${i}]`;
    if (!isObj(a)) fail(path, 'must be an object with an id');
    const id = optString(a.id, `${path}.id`);
    if (id === undefined) fail(`${path}.id`, 'is required');
    if (seen.has(id)) fail(`${path}.id`, `"${id}" is used more than once`);
    seen.add(id);
    const bound = (b: unknown, p: string): number | undefined => (b === 'auto' ? undefined : optNumber(b, p));
    const min = bound(a.min, `${path}.min`);
    const max = bound(a.max, `${path}.max`);
    if (min !== undefined && max !== undefined && min >= max) fail(path, `min (${min}) must be < max (${max})`);
    const defaultPosition: AxisPosition = i % 2 === 0 ? 'left' : 'right';
    return {
      id,
      unit: optText(a.unit, `${path}.unit`),
      name: optText(a.name, `${path}.name`),
      min,
      max,
      softMin: optNumber(a.soft_min, `${path}.soft_min`),
      softMax: optNumber(a.soft_max, `${path}.soft_max`),
      position: optEnum(a.position, ['left', 'right'] as const, `${path}.position`) ?? defaultPosition,
      precision: optNumber(a.precision, `${path}.precision`, { min: 0, max: 10 }),
      show: optBool(a.show, `${path}.show`) ?? true,
    };
  });
}

function checkAxisRef(id: string | undefined, axes: NormalizedYAxis[], path: string): string | null {
  if (id === undefined) return null;
  if (!axes.some((a) => a.id === id)) {
    const known = axes.map((a) => a.id);
    fail(path, `references unknown y-axis "${id}"${known.length ? ` (known: ${known.join(', ')})` : ' (no y_axes configured)'}`);
  }
  return id;
}

function normalizeThresholds(v: unknown, axes: NormalizedYAxis[]): NormalizedThreshold[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) fail('thresholds', 'must be a list');
  return v.map((t, i) => {
    const path = `thresholds[${i}]`;
    if (!isObj(t)) fail(path, 'must be { value } or { from, to }');
    const value = optNumber(t.value, `${path}.value`);
    const from = optNumber(t.from, `${path}.from`);
    const to = optNumber(t.to, `${path}.to`);
    const isArea = from !== undefined || to !== undefined;
    if (value === undefined && !isArea) fail(path, 'needs either value (line) or from/to (band)');
    if (value !== undefined && isArea) fail(path, 'cannot have both value and from/to');
    if (from !== undefined && to !== undefined && from >= to) fail(path, `from (${from}) must be < to (${to})`);
    const kind = isArea ? 'area' : 'line';
    return {
      kind,
      value,
      from,
      to,
      color: optString(t.color, `${path}.color`),
      style: optEnum(t.style, LINE_STYLES, `${path}.style`) ?? 'dashed',
      width: optNumber(t.width, `${path}.width`, { min: 0 }) ?? 1,
      opacity:
        optNumber(t.opacity, `${path}.opacity`, { min: 0, max: 1 }) ??
        (kind === 'area' ? DEFAULTS.thresholdAreaOpacity : DEFAULTS.thresholdLineOpacity),
      label: optText(t.label, `${path}.label`),
      yAxis: checkAxisRef(optString(t.y_axis, `${path}.y_axis`), axes, `${path}.y_axis`),
    };
  });
}

function normalizeSeries(
  rawList: Array<SeriesConfig | string>,
  axes: NormalizedYAxis[],
  cardGroupBy: NormalizedGroupBy | null,
): NormalizedSeries[] {
  const count = rawList.length;
  return rawList.map((entry, index) => {
    const path = `series[${index}]`;
    const s: Obj = typeof entry === 'string' ? { entity: entry } : isObj(entry) ? entry : fail(path, 'must be an entity id or { entity: ... }');
    const entity = optString(s.entity, `${path}.entity`);
    if (entity === undefined) fail(`${path}.entity`, 'is required (e.g. sensor.living_room_temperature)');
    if (!ENTITY_ID_RE.test(entity)) fail(`${path}.entity`, `"${entity}" is not a valid entity id`);
    const attribute = optString(s.attribute, `${path}.attribute`);
    const unit = optText(s.unit, `${path}.unit`);

    let yAxis = checkAxisRef(optString(s.y_axis, `${path}.y_axis`), axes, `${path}.y_axis`);
    if (yAxis === null && unit !== undefined) yAxis = axes.find((a) => a.unit === unit)?.id ?? null;

    const line = normalizeLine(s.line, `${path}.line`);
    const rawLine = isObj(s.line) ? s.line : {};
    if (!attribute && BINARY_DOMAINS.includes(entity.split('.')[0])) {
      // on/off entities: thinner, straight (they render as step lines).
      if (rawLine.width === undefined || rawLine.width === null) line.width = DEFAULTS.binaryLineWidth;
      if (rawLine.smooth === undefined || rawLine.smooth === null) line.smooth = 0;
    }

    const colorThresholds = normalizeColorThresholds(s.color_thresholds, `${path}.color_thresholds`);
    // Value-coloured lines (>= 2 stops) default to no fill: an area would inherit the stops as
    // horizontal colour bands, which reads like threshold bands and muddies the chart.
    const autoFill = count <= DEFAULTS.autoFillMaxSeries && colorThresholds.length < 2;
    const fill = optEnum(s.fill, FILL_MODES, `${path}.fill`) ?? (autoFill ? 'gradient' : 'none');
    const fillOpacity =
      optNumber(s.fill_opacity, `${path}.fill_opacity`, { min: 0, max: 1 }) ??
      (fill === 'solid' ? DEFAULTS.solidOpacity : fill === 'gradient' ? DEFAULTS.gradientOpacity : 0);

    const groupBy = s.group_by === undefined ? cardGroupBy : normalizeGroupBy(s.group_by, `${path}.group_by`);

    if (s.transform !== undefined && s.transform !== null && !isObj(s.transform)) fail(`${path}.transform`, 'must be { multiply, offset }');
    const tr = (s.transform ?? {}) as Obj;

    return {
      index,
      key: `${index}:${entity}${attribute ? `#${attribute}` : ''}`,
      entity,
      attribute,
      name: optText(s.name, `${path}.name`),
      color: optString(s.color, `${path}.color`) ?? DEFAULT_PALETTE[index % DEFAULT_PALETTE.length],
      unit,
      yAxis,
      line,
      fill,
      fillOpacity,
      groupBy,
      transform: {
        multiply: optNumber(tr.multiply, `${path}.transform.multiply`) ?? 1,
        offset: optNumber(tr.offset, `${path}.transform.offset`) ?? 0,
      },
      colorThresholds,
      statistic: optEnum(s.statistic, STATISTIC_TYPES, `${path}.statistic`) ?? 'auto',
      precision: optNumber(s.precision, `${path}.precision`, { min: 0, max: 10 }),
      showInHeader: optBool(s.show_in_header, `${path}.show_in_header`) ?? true,
      hidden: optBool(s.hidden, `${path}.hidden`) ?? false,
    };
  });
}

function normalizeUpdate(v: unknown): NormalizedUpdate {
  if (v === undefined || v === null || v === 'live') return { mode: 'live', intervalMs: DEFAULTS.liveRefreshMs };
  if (v === 'none' || v === false) return { mode: 'none', intervalMs: 0 };
  const raw = isObj(v) ? v.interval : v;
  const path = isObj(v) ? 'update.interval' : 'update';
  if (raw === undefined) fail(path, 'is required');
  const intervalMs = duration(raw, path, SECOND);
  if (intervalMs < 5 * SECOND) fail(path, 'must be at least 5s');
  return { mode: 'interval', intervalMs };
}

function normalizeShow(v: unknown, seriesCount: number): NormalizedShow {
  if (v !== undefined && v !== null && !isObj(v)) fail('show', 'must be an object like { legend: true }');
  const s = (v ?? {}) as Obj;
  const headerStates = optBool(s.header_states, 'show.header_states') ?? true;
  return {
    legend: optBool(s.legend, 'show.legend') ?? (seriesCount > 1 && !headerStates),
    tooltip: optBool(s.tooltip, 'show.tooltip') ?? true,
    headerStates,
    zoom: optBool(s.zoom, 'show.zoom') ?? false,
    extrema: optBool(s.extrema, 'show.extrema') ?? false,
    points: optBool(s.points, 'show.points') ?? false,
    xAxis: optBool(s.x_axis, 'show.x_axis') ?? true,
    yAxis: optBool(s.y_axis, 'show.y_axis') ?? true,
  };
}

function normalizeHeight(v: unknown): string {
  if (v === undefined || v === null) return DEFAULTS.height;
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v <= 0) fail('height', `must be a positive number of px or a CSS length (got ${v})`);
    return `${v}px`;
  }
  if (typeof v !== 'string' || v.trim() === '') fail('height', `must be a CSS length like "250px" (got ${JSON.stringify(v)})`);
  const t = v.trim();
  return /^\d+(\.\d+)?$/.test(t) ? `${t}px` : t;
}

function defaultStatisticsPeriod(spanMs: number): StatisticsPeriod {
  if (spanMs <= 2 * DAY) return '5minute';
  if (spanMs <= 31 * DAY) return 'hour';
  return 'day';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate the raw YAML config and resolve every default.
 *
 * - `series` (or alias `entities`) must be a non-empty list; bare strings become `{ entity }`.
 * - Window: `span` wins over `hours_to_show`; default 24h. Both accept a number of HOURS or a
 *   duration string (`"36h"`, `"7d"`). Duration rule everywhere: strings carry their unit;
 *   bare numbers are hours for `span`/`hours_to_show` and seconds for `group_by`/`update`.
 * - `data_source: auto` -> `history` when spanMs <= 72h, else `statistics` (dataSourceAuto = true).
 * - `statistics_period` default: span <= 2d -> 5minute, <= 31d -> hour, else day.
 * - Colors default to DEFAULT_PALETTE[index]; fill defaults to gradient for <= 2 series, else none
 *   (and none for series with >= 2 color_thresholds stops).
 * - Line: width 2, smooth 0.35, step auto; entities of BINARY_DOMAINS (state series) default to
 *   width 1.5 and no smoothing.
 * - `series[].y_axis` / `thresholds[].y_axis` must reference `y_axes[].id`; a series without
 *   `y_axis` but with `unit` binds to the configured axis with that unit, otherwise `yAxis: null`
 *   (auto-assigned at render time by unit).
 * - `group_by`: series-level wins, card-level is the default, `false` opts out.
 * - `update`: live (default, 5 min refetch) | none | duration (>= 5s) | { interval }.
 *
 * Unknown keys are ignored. Throws `Error("Invalid config: <path> <problem>")` on invalid input;
 * HA shows the message in an error card when thrown from setConfig().
 */
export function normalizeConfig(raw: CardConfig): NormalizedConfig {
  if (!isObj(raw)) throw new Error('Invalid config: expected an object');
  const cfg = raw as unknown as Obj;

  const seriesRaw = cfg.series ?? cfg.entities;
  const seriesKey = cfg.series === undefined && cfg.entities !== undefined ? 'entities' : 'series';
  if (!Array.isArray(seriesRaw) || seriesRaw.length === 0) {
    fail(seriesKey, 'must be a non-empty list, e.g.\nseries:\n  - entity: sensor.temperature');
  }

  let spanMs: number;
  if (cfg.span !== undefined && cfg.span !== null) spanMs = duration(cfg.span, 'span', HOUR);
  else if (cfg.hours_to_show !== undefined && cfg.hours_to_show !== null) spanMs = duration(cfg.hours_to_show, 'hours_to_show', HOUR);
  else spanMs = DEFAULTS.spanMs;
  if (spanMs <= 0) fail(cfg.span !== undefined ? 'span' : 'hours_to_show', 'must be > 0');
  spanMs = Math.round(spanMs);

  const ds = optEnum(cfg.data_source, DATA_SOURCES, 'data_source') ?? 'auto';
  const dataSource = ds === 'auto' ? (spanMs <= DEFAULTS.autoHistoryMaxSpanMs ? 'history' : 'statistics') : ds;

  const yAxes = normalizeYAxes(cfg.y_axes);
  const cardGroupBy = normalizeGroupBy(cfg.group_by, 'group_by');
  const series = normalizeSeries(seriesRaw as Array<SeriesConfig | string>, yAxes, cardGroupBy);

  return {
    type: typeof cfg.type === 'string' ? cfg.type : 'custom:echart-graph-card',
    title: optText(cfg.title, 'title'),
    spanMs,
    height: normalizeHeight(cfg.height),
    dataSource,
    dataSourceAuto: ds === 'auto',
    statisticsPeriod: optEnum(cfg.statistics_period, STATISTICS_PERIODS, 'statistics_period') ?? defaultStatisticsPeriod(spanMs),
    update: normalizeUpdate(cfg.update),
    show: normalizeShow(cfg.show, series.length),
    yAxes,
    thresholds: normalizeThresholds(cfg.thresholds, yAxes),
    series,
    raw,
  };
}
