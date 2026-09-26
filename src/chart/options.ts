import { DAY, HOUR, MINUTE, SECOND, WEEK } from '../config';
import type { ECOption, EChartsCoreOption, LineSeriesOption } from './echarts';
import { formatAxisValue, formatValue, makeTimeFormatter, timeTicks, zoneMatchesBrowser } from './format';
import type { TimeFormatter } from './format';
import { scaleAlpha, withAlpha } from './theme';
import type {
  AxisPosition,
  ColorThreshold,
  HassEntityState,
  HassLocale,
  HomeAssistant,
  NormalizedConfig,
  NormalizedSeries,
  NormalizedThreshold,
  NormalizedYAxis,
  Point,
  SeriesData,
  StatisticsPeriod,
  StepMode,
  ThemeColors,
} from '../types';

/** Extra inputs to buildOptions (kept explicit so buildOptions stays pure). */
export interface BuildContext {
  hass: HomeAssistant;
  /** Epoch ms; x-axis spans [now - cfg.spanMs, now]. */
  now: number;
  /** Maps user colors (`var(--x)`) to concrete colors; the card passes `c => resolveColor(this, c)`. Default identity. */
  resolveColor?: (c: string) => string;
  /** Series keys currently toggled off by the user (header chip / legend). Default: series with `hidden: true`. */
  hiddenKeys?: ReadonlySet<string>;
  /**
   * Short (300 ms) entry/update animation. Default true; pass false for live redraws so appended
   * points do not slide. Always off above 2000 total points.
   */
  animate?: boolean;
  /**
   * Chart width in px, optional. Only used to choose the tick density when the display time zone
   * differs from the browser's (then ticks are computed here instead of by ECharts).
   */
  width?: number;
}

/** One y-axis actually rendered (configured or auto-created). */
export interface ResolvedAxis {
  /**
   * Configured id, or `unit:<unit>` / `unit:` (unitless) for auto axes. Binary (0/1) series
   * without a configured axis share the hidden auto axis `binary` (fixed 0..1, always last).
   */
  id: string;
  unit?: string;
  position: AxisPosition;
  /** true = created from a series unit, not from cfg.yAxes. */
  auto: boolean;
}

export interface AxisAssignment {
  axes: ResolvedAxis[];
  /** For each SeriesData (same index), the index into `axes`. */
  seriesAxis: number[];
}

/** Id of the hidden auto axis that carries binary (0/1) series. */
export const BINARY_AXIS_ID = 'binary';
/** ECharts series id prefix of the empty carrier series that hold threshold markLine/markArea. */
export const THRESHOLD_SERIES_PREFIX = '__thresholds:';

const AXIS_OFFSET_PX = 52;
const SAMPLING_MIN_POINTS = 1000;
const NO_ANIMATION_POINTS = 2000;
const ANIMATION_MS = 300;
const FONT_SIZE = 11;

const PERIOD_MS: Record<StatisticsPeriod, number> = {
  '5minute': 5 * MINUTE,
  hour: HOUR,
  day: DAY,
  week: WEEK,
  month: 30 * DAY,
};

/**
 * Decide which y-axis each series uses.
 * 1. `series.yAxis` set -> that configured axis.
 * 2. else a configured axis whose `unit` equals SeriesData.unit.
 * 3. else an auto axis per distinct unit (`unit:<unit>`), placed on the side with fewer visible
 *    axes (first left, second right, ...; several axes on one side are offset outwards).
 *    Binary series share the hidden auto axis `binary` instead.
 * Configured axes that no series uses are still rendered if a threshold references them.
 * Order: configured axes (config order), then auto unit axes, then the binary axis.
 * With zero series data, returns a single unitless auto axis.
 */
export function assignAxes(cfg: NormalizedConfig, data: SeriesData[]): AxisAssignment {
  const configured = new Map(cfg.yAxes.map((a) => [a.id, a]));
  const targets = data.map((d) => {
    if (d.series.yAxis !== null && configured.has(d.series.yAxis)) return d.series.yAxis;
    if (d.unit !== undefined) {
      const byUnit = cfg.yAxes.find((a) => a.unit !== undefined && a.unit === d.unit);
      if (byUnit) return byUnit.id;
    }
    return d.isBinary ? BINARY_AXIS_ID : `unit:${d.unit ?? ''}`;
  });

  const used = new Set(targets);
  for (const t of cfg.thresholds) if (t.yAxis !== null) used.add(t.yAxis);

  const axes: ResolvedAxis[] = [];
  const index = new Map<string, number>();
  const sides = { left: 0, right: 0 };
  const add = (a: ResolvedAxis, visible: boolean): void => {
    index.set(a.id, axes.length);
    axes.push(a);
    if (visible) sides[a.position]++;
  };

  for (const a of cfg.yAxes) {
    if (!used.has(a.id)) continue;
    const unit = a.unit ?? data.find((_, i) => targets[i] === a.id)?.unit;
    add({ id: a.id, unit, position: a.position, auto: false }, a.show);
  }
  targets.forEach((id, i) => {
    if (index.has(id) || id === BINARY_AXIS_ID) return;
    const position: AxisPosition = sides.left <= sides.right ? 'left' : 'right';
    add({ id, unit: data[i].unit, position, auto: true }, true);
  });
  if (targets.includes(BINARY_AXIS_ID)) add({ id: BINARY_AXIS_ID, position: 'right', auto: true }, false);
  if (axes.length === 0) add({ id: 'unit:', position: 'left', auto: true }, true);

  return { axes, seriesAxis: targets.map((id) => index.get(id) ?? 0) };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

type YAxisOption = Extract<NonNullable<ECOption['yAxis']>, unknown[]>[number];
type VisualMapOption = Extract<NonNullable<ECOption['visualMap']>, unknown[]>[number];
type ValueExtent = { min: number; max: number };

interface TooltipParam {
  value?: unknown;
  data?: unknown;
  axisValue?: unknown;
}

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] as string);

/**
 * Resolve a hard bound, or a soft bound against the data: the soft bound applies while the data
 * stays inside it; beyond it the side is left to ECharts (auto, nicely rounded).
 */
function resolveBound(hard: number | undefined, soft: number | undefined, dataValue: number, side: 'min' | 'max'): number | undefined {
  if (hard !== undefined) return hard;
  if (soft === undefined) return undefined;
  if (!Number.isFinite(dataValue)) return soft;
  return (side === 'min' ? dataValue >= soft : dataValue <= soft) ? soft : undefined;
}

const isMultiple = (v: number, step: number): boolean => Math.abs(v / step - Math.round(v / step)) < 1e-9;

/** Fraction digits of a (float-noisy) step, e.g. 2.5 -> 1, 0.05 -> 2, 500 -> 0. */
function stepDecimals(step: number): number {
  for (let d = 0; d <= 4; d++) if (Math.abs(step * 10 ** d - Math.round(step * 10 ** d)) < 1e-6) return d;
  return 4;
}

/**
 * Decimals every tick label of an axis spanning [lo, hi] with about `splits` intervals needs, so
 * all labels share them (`21.5`, `22.0`). ECharts' nice interval (1/2/3/5 x 10^e) is never finer
 * than 10^floor(log10(span / splits)); a tick needing more decimals still shows them (formatAxisValue).
 */
function labelDecimals(lo: number, hi: number, splits: number): number {
  const span = hi - lo;
  if (!(span > 0) || !Number.isFinite(span)) return 0;
  return Math.max(0, Math.min(4, -Math.floor(Math.log10(span / splits))));
}

/**
 * For an axis with both ends fixed: split counts n -> nice step (1/2/2.5/3/5 x 10^n) whose ticks
 * land exactly on both ends (and on 0). ECharts would otherwise pick an interval that leaves an
 * odd gap next to the fixed min/max labels.
 */
function evenSplits(min: number, max: number, maxSplits: number): Map<number, number> {
  const out = new Map<number, number>();
  const range = max - min;
  if (!(range > 0) || !Number.isFinite(range)) return out;
  const e0 = Math.floor(Math.log10(range)) - 2;
  for (let e = e0; e <= e0 + 3; e++) {
    for (const m of [1, 2, 2.5, 3, 5]) {
      const step = e >= 0 ? m * 10 ** e : m / 10 ** -e;
      const n = Math.round(range / step);
      if (n >= 2 && n <= maxSplits && isMultiple(min, step) && isMultiple(max, step)) out.set(n, step);
    }
  }
  return out;
}

/**
 * Nice ticks for an auto (not fully fixed) axis whose segment count every fully fixed secondary
 * axis can match with an even interval (`wanted`: their possible split counts), so e.g. a W axis
 * and a fixed 0..100 % axis share grid lines. A fixed end must itself be a tick. Undefined when
 * there is no data or no fitting step (the secondaries then use ECharts' alignTicks).
 */
function fitAutoAxis(
  bound: { min?: number; max?: number; dataMin: number; dataMax: number },
  target: number,
  maxSplits: number,
  wanted: ReadonlyArray<ReadonlyMap<number, number>>,
): { min: number; max: number; interval: number; splits: number } | undefined {
  const dMin = Math.min(bound.min ?? bound.dataMin, bound.dataMin);
  const dMax = Math.max(bound.max ?? bound.dataMax, bound.dataMax);
  if (!Number.isFinite(dMin) || !Number.isFinite(dMax) || !(dMax > dMin)) return undefined;
  const e0 = Math.floor(Math.log10((dMax - dMin) / target)) - 1;
  let best: { min: number; max: number; interval: number; splits: number; score: number } | undefined;
  for (let e = e0; e <= e0 + 2; e++) {
    for (const m of [1, 2, 2.5, 5]) {
      const step = e >= 0 ? m * 10 ** e : m / 10 ** -e;
      if (bound.min !== undefined && !isMultiple(bound.min, step)) continue;
      if (bound.max !== undefined && !isMultiple(bound.max, step)) continue;
      const lo = bound.min ?? Math.floor(dMin / step + 1e-9) * step;
      const hi = bound.max ?? Math.ceil(dMax / step - 1e-9) * step;
      const n = Math.round((hi - lo) / step);
      if (n < 2 || n > maxSplits || !wanted.every((w) => w.has(n))) continue;
      // Closest to the target density; slight preference for 1/2/5 steps over 2.5.
      const score = Math.abs(n - target) + (m === 2.5 ? 0.25 : 0);
      if (!best || score < best.score) best = { min: lo, max: hi, interval: step, splits: n, score };
    }
  }
  return best && { min: best.min, max: best.max, interval: best.interval, splits: best.splits };
}

/** Split count closest to `target` (ties -> denser). */
function pickSplits(counts: Iterable<number>, target: number): number | undefined {
  let best: number | undefined;
  for (const n of counts) {
    if (best === undefined || Math.abs(n - target) < Math.abs(best - target) || (Math.abs(n - target) === Math.abs(best - target) && n > best)) {
      best = n;
    }
  }
  return best;
}

function resolveStep(step: StepMode | 'auto', isBinary: boolean): StepMode {
  if (step === 'auto') return isBinary ? 'end' : false;
  return step;
}

/** Repeat the last known value at `until` so the line reaches it (sample-and-hold / open bucket). */
function extendTo(points: Point[], until: number): Point[] {
  const last = points[points.length - 1];
  if (!last || last[1] === null || last[0] >= until) return points;
  const out = points.slice();
  out.push([until, last[1]]);
  return out;
}

/**
 * Points handed to ECharts. History is sample-and-hold, so the last value is extended to `now`
 * (the line reaches the right edge). Stepped statistics rows cover [start, start + period): the
 * last row is extended to its end so its step has a width (like every other bucket).
 */
function plotPoints(d: SeriesData, now: number, bucketMs: number): Point[] {
  if (d.source === 'history') return extendTo(d.points, now);
  if (bucketMs > 0 && resolveStep(d.series.line.step, d.isBinary) === 'end') {
    const last = d.points[d.points.length - 1];
    if (last) return extendTo(d.points, Math.min(last[0] + bucketMs, now));
  }
  return d.points;
}

function valueExtent(points: Point[]): ValueExtent {
  let min = Infinity;
  let max = -Infinity;
  for (const p of points) {
    const v = p[1];
    if (v === null || !Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { min, max };
}

/**
 * Vertical gradient (object-bounding-box coords) that is opaque at the line and fades out towards
 * the zero/axis baseline: positive data fades downwards, negative data upwards, mixed data fades
 * towards the zero crossing from both sides.
 */
function fillGradient(color: string, extent: ValueExtent): object {
  const clear = withAlpha(color, 0) ?? 'transparent';
  const stops =
    extent.max <= 0 && extent.min < 0
      ? [
          { offset: 0, color: clear },
          { offset: 1, color },
        ]
      : extent.min < 0 && extent.max > 0
        ? [
            { offset: 0, color },
            { offset: extent.max / (extent.max - extent.min), color: clear },
            { offset: 1, color },
          ]
        : [
            { offset: 0, color },
            { offset: 1, color: clear },
          ];
  return { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: stops, global: false };
}

/** Piecewise visualMap pieces: each stop's color from its value (inclusive) to the next stop; below the first uses the first. */
function visualPieces(stops: ColorThreshold[]): Array<{ gte?: number; lt?: number; color: string }> {
  return stops.map((t, k) => {
    const p: { gte?: number; lt?: number; color: string } = { color: t.color };
    if (k > 0) p.gte = t.value;
    if (k < stops.length - 1) p.lt = stops[k + 1].value;
    return p;
  });
}

/**
 * ECharts series / legend names for `data` (SeriesData.name, de-duplicated with ` (2)`, ` (3)`
 * suffixes). Legend events (`legendselectchanged`, `legendSelect`) use these names, so map them
 * back to series keys by index with this helper rather than by SeriesData.name.
 */
export function legendNames(data: SeriesData[]): string[] {
  return uniqueNames(data.map((d) => d.name));
}

function uniqueNames(names: string[]): string[] {
  const used = new Set<string>();
  return names.map((n) => {
    let name = n;
    for (let k = 2; used.has(name); k++) name = `${n} (${k})`;
    used.add(name);
    return name;
  });
}

function displayPrecision(hass: HomeAssistant, s: NormalizedSeries): number | undefined {
  if (s.precision !== undefined) return s.precision;
  if (s.attribute) return undefined;
  const p = hass.entities?.[s.entity]?.display_precision;
  return typeof p === 'number' && Number.isFinite(p) ? p : undefined;
}

/**
 * Tooltip texts for 0/1 of a binary series: the entity's own translated states when the frontend
 * offers `formatEntityState` (door -> Closed / Open), else the generic binary_sensor On / Off.
 */
function binaryLabels(hass: HomeAssistant, s?: NormalizedSeries): [string, string] {
  const format = (hass as unknown as { formatEntityState?: (st: HassEntityState, state?: string) => string }).formatEntityState;
  const st = s && !s.attribute ? hass.states?.[s.entity] : undefined;
  if (st && typeof format === 'function') {
    try {
      const off = format(st, 'off');
      const on = format(st, 'on');
      if (off && on) return [off, on];
    } catch {
      // fall through to the generic labels
    }
  }
  const localize = (hass as unknown as { localize?: (key: string) => string }).localize;
  const t = (key: string, fallback: string): string => {
    try {
      const v = typeof localize === 'function' ? localize(key) : '';
      return v || fallback;
    } catch {
      return fallback;
    }
  };
  return [
    t('component.binary_sensor.entity_component._.state.off', 'Off'),
    t('component.binary_sensor.entity_component._.state.on', 'On'),
  ];
}

/** Finest data resolution across series (drives seconds / date-only in the tooltip header). */
function tooltipResolution(cfg: NormalizedConfig, data: SeriesData[]): number {
  let res = Infinity;
  for (const d of data) {
    let r: number;
    if (d.source === 'statistics') r = PERIOD_MS[cfg.statisticsPeriod] ?? HOUR;
    else if (d.series.groupBy) r = d.series.groupBy.durationMs;
    else r = cfg.spanMs <= 6 * HOUR ? SECOND : MINUTE;
    res = Math.min(res, r);
  }
  return Number.isFinite(res) ? res : MINUTE;
}

interface SeriesInfo {
  data: SeriesData;
  /** The points handed to ECharts (incl. the synthetic trailing point). */
  points: Point[];
  name: string;
  color: string;
  /** Resolved color stops (color_thresholds), for the tooltip dot. */
  stops: ColorThreshold[];
  unit?: string;
  precision?: number;
  hidden: boolean;
  /** Statistics bucket length (value valid for [start, start + bucketMs)); 0 = sample-and-hold. */
  bucketMs: number;
  /** Texts for 0 / 1 (binary series). */
  onOff: [string, string];
}

/**
 * Value of a series at time `t`: the last point at or before `t` (HA states are sample-and-hold;
 * statistics rows only cover their bucket). `undefined` = no data at `t` (before the first point
 * or after a bucket), `null` = gap (unavailable).
 */
export function valueAt(points: Point[], t: number, bucketMs = 0): number | null | undefined {
  let lo = 0;
  let hi = points.length - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid][0] <= t) {
      idx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (idx < 0) return undefined;
  const [time, v] = points[idx];
  if (bucketMs > 0 && t >= time + bucketMs) return undefined;
  return v;
}

function stopColor(stops: ColorThreshold[], v: number | null | undefined, fallback: string): string {
  if (!stops.length || typeof v !== 'number') return fallback;
  let c = stops[0].color;
  for (const s of stops) if (v >= s.value) c = s.color;
  return c;
}

/**
 * Axis tooltip. ECharts' axis trigger only passes the series whose point is nearest to the
 * cursor (HA entities never share timestamps), so the formatter only takes the snapped time
 * from its params and looks every visible series up itself (sample-and-hold).
 */
function tooltipFormatter(
  info: SeriesInfo[],
  tf: TimeFormatter,
  locale: HassLocale,
  theme: ThemeColors,
  resolution: number,
): (raw: unknown) => string {
  return (raw: unknown): string => {
    const list = (Array.isArray(raw) ? raw : [raw]) as TooltipParam[];
    let time: number | undefined;
    for (const p of list) {
      if (!p) continue;
      const tuple = Array.isArray(p.value) ? p.value : Array.isArray(p.data) ? p.data : undefined;
      const t = Number(p.axisValue ?? (tuple ? tuple[0] : NaN));
      if (Number.isFinite(t)) {
        time = t;
        break;
      }
    }
    if (time === undefined) return '';
    const rows: string[] = [];
    for (const si of info) {
      if (si.hidden) continue;
      const v = valueAt(si.points, time, si.bucketMs);
      if (v === undefined) continue;
      const text =
        si.data.isBinary && typeof v === 'number' ? si.onOff[v >= 0.5 ? 1 : 0] : formatValue(v, si.unit, si.precision, locale);
      const dot = stopColor(si.stops, v, si.color);
      rows.push(
        `<div style="display:flex;align-items:center;gap:8px;line-height:20px">` +
          `<span style="flex:none;width:8px;height:8px;border-radius:50%;background:${escapeHtml(dot)}"></span>` +
          `<span style="flex:1 1 auto;color:${escapeHtml(theme.secondaryText)};white-space:nowrap">${escapeHtml(si.name)}</span>` +
          `<span style="margin-left:16px;font-weight:600;white-space:nowrap;font-variant-numeric:tabular-nums">${escapeHtml(text)}</span>` +
          `</div>`,
      );
    }
    if (!rows.length) return '';
    const header = `<div style="font-size:11px;color:${escapeHtml(theme.secondaryText)};margin-bottom:4px;white-space:nowrap">${escapeHtml(tf.tooltip(time, resolution))}</div>`;
    return header + rows.join('');
  };
}

function thresholdCarrier(
  axis: ResolvedAxis,
  axisIndex: number,
  list: NormalizedThreshold[],
  theme: ThemeColors,
  resolve: (c: string) => string,
): LineSeriesOption {
  const lines = list.filter((t) => t.kind === 'line' && t.value !== undefined);
  const areas = list.filter((t) => t.kind === 'area');
  const colorOf = (t: NormalizedThreshold): string => (t.color ? resolve(t.color) : theme.secondaryText);
  const carrier: LineSeriesOption = {
    type: 'line',
    id: `${THRESHOLD_SERIES_PREFIX}${axis.id}`,
    name: '',
    xAxisIndex: 0,
    yAxisIndex: axisIndex,
    data: [],
    silent: true,
    animation: false,
    legendHoverLink: false,
    tooltip: { show: false },
    z: 1,
  };
  if (lines.length) {
    carrier.markLine = {
      silent: true,
      animation: false,
      symbol: ['none', 'none'],
      precision: 10,
      emphasis: { disabled: true },
      data: lines.map((t) => {
        const color = colorOf(t);
        const label = t.label;
        return {
          name: label ?? '',
          yAxis: t.value as number,
          lineStyle: { color, type: t.style, width: t.width, opacity: t.opacity },
          label: label
            ? { show: true, position: 'insideEndTop', formatter: () => label, color, fontSize: 10, distance: 3 }
            : { show: false },
        };
      }),
    };
  }
  if (areas.length) {
    carrier.markArea = {
      silent: true,
      animation: false,
      emphasis: { disabled: true },
      data: areas.map((t) => {
        const color = colorOf(t);
        const label = t.label;
        const from: { yAxis?: number } = t.from !== undefined ? { yAxis: t.from } : {};
        const to: { yAxis?: number } = t.to !== undefined ? { yAxis: t.to } : {};
        return [
          {
            name: label ?? '',
            ...from,
            itemStyle: { color, opacity: t.opacity },
            label: label
              ? { show: true, position: 'insideTopLeft', formatter: () => label, color, fontSize: 10, opacity: 0.9 }
              : { show: false },
          },
          to,
        ];
      }) as NonNullable<LineSeriesOption['markArea']>['data'],
    };
  }
  return carrier;
}

// ---------------------------------------------------------------------------
// buildOptions
// ---------------------------------------------------------------------------

/**
 * Pure: config + loaded data + theme -> full ECharts option (used with `notMerge: true` on
 * config/theme change, `lazyUpdate` for live redraws).
 *
 * Behavior contract:
 * - xAxis `type: 'time'`, min `now - spanMs`, max `now`; labels via makeTimeFormatter(ctx.hass).axis
 *   (day ticks emphasised); hidden when !cfg.show.xAxis. No axis lines/ticks; text uses
 *   theme.secondaryText. When the display zone differs from the browser's, ticks are computed
 *   in that zone (axisLabel.customValues) so they land on wall-clock hours / local midnight.
 * - yAxes from assignAxes; `scale: true` (fit data), ~1 split per 55px of card height. min/max
 *   hard; soft_min/soft_max resolved against the visible data here (soft bound while the data
 *   stays inside, auto/nice beyond). Axes with both ends fixed get an interval that lands on
 *   both ends when a nice one exists. Labels via formatAxisValue (unit on every label); only the
 *   first visible axis draws the dashed split lines (theme.divider); other non-fixed axes use
 *   alignTicks and are offset outwards when several share a side. Hidden when !cfg.show.yAxis or
 *   axis.show false. Binary series use a hidden fixed 0..1 axis (their lines are drawn lighter
 *   and their fills flat when mixed with non-binary series).
 * - One `type: 'line'` series per SeriesData, `id: series.key`, `name: data.name` (made unique
 *   with ` (2)` suffixes so legend toggling is unambiguous), `data: points` (history series
 *   additionally get a synthetic trailing `[now, lastValue]` so sample-and-hold lines reach the
 *   right edge), `connectNulls: false`, `showSymbol: cfg.show.points` (a ringed symbol appears on
 *   hover), `sampling: 'lttb'` when points.length > 1000 (not for stepped series); `step` =
 *   line.step, `'auto'` -> `'end'` when isBinary else false; `smooth` = line.smooth (0 -> false;
 *   forced off when stepped; smoothMonotone 'x'); lineStyle width/type; series `color` via
 *   ctx.resolveColor (series-level so a visualMap can recolor the line).
 * - fill: gradient -> vertical LinearGradient from fillOpacity at the line to 0 at the baseline
 *   (direction aware for negative/mixed data); solid -> areaStyle opacity fillOpacity; none -> no
 *   areaStyle.
 * - colorThresholds: 1 stop -> the line simply uses that color; >= 2 stops -> one piecewise
 *   visualMap per series (`seriesIndex`, `dimension: 1`, `show: false`, outOfRange = series
 *   color); the area then takes the same colors (flat, at fillOpacity x 0.6 for gradients).
 * - thresholds -> markLine (kind line) / markArea (kind area) on an empty carrier series per
 *   y-axis (`__thresholds:<axisId>`, appended after the data series, never hidden by legend
 *   toggles), `silent: true`, color default theme.secondaryText, optional label.
 * - show.extrema -> min/max markPoints (small ringed dot + value label) on non-binary series, only
 *   when the header is off (otherwise the header chips show min / max / avg).
 * - tooltip (when cfg.show.tooltip): `trigger: 'axis'`, `appendTo: 'body'` (escapes shadow-DOM
 *   clipping), theme tooltip colors, dashed crosshair, header via TimeFormatter.tooltip, rows
 *   `● name  value` (formatValue with series precision / entity display_precision; binary On/Off).
 * - legend (component always present so `selected` applies; visible when cfg.show.legend) at
 *   bottom, scrollable, roundRect icons; `selected` from ctx.hiddenKeys.
 * - dataZoom `type: 'inside'` on xAxis when cfg.show.zoom (`zoomOnMouseWheel: 'ctrl'`, drag pans,
 *   `filterMode: 'none'`).
 * - animation 300 ms cubicOut unless ctx.animate === false or > 2000 total points.
 * - textStyle.fontFamily = theme.fontFamily; backgroundColor transparent; compact grid (labels
 *   contained via outerBounds) so a minimal config looks good at 220px; full-bleed when both
 *   axes are hidden (sparkline).
 */
export function buildOptions(cfg: NormalizedConfig, data: SeriesData[], theme: ThemeColors, ctx: BuildContext): EChartsCoreOption {
  const hass = ctx.hass;
  const locale: HassLocale = hass.locale ?? { language: 'en', number_format: 'language', time_zone: 'local' };
  const resolve = ctx.resolveColor ?? ((c: string): string => c);
  const hidden = ctx.hiddenKeys ?? new Set(cfg.series.filter((s) => s.hidden).map((s) => s.key));
  const now = ctx.now;
  const start = now - cfg.spanMs;
  const spanMs = cfg.spanMs;
  const tf = makeTimeFormatter(hass);
  const { axes, seriesAxis } = assignAxes(cfg, data);
  const names = legendNames(data);
  const totalPoints = data.reduce((n, d) => n + d.points.length, 0);
  const animate = ctx.animate !== false && totalPoints <= NO_ANIMATION_POINTS;
  const bucketList = data.map((d) => (d.source === 'statistics' ? (PERIOD_MS[cfg.statisticsPeriod] ?? 0) : 0));
  const pointsList = data.map((d, i) => plotPoints(d, now, bucketList[i]));
  // Chart min/max markers only when the header does not already show min / max / avg.
  const markExtrema = cfg.show.extrema && !cfg.show.headerStates;
  const extents = pointsList.map(valueExtent);
  const mixedBinary = data.some((d) => d.isBinary) && data.some((d) => !d.isBinary);

  // ---- y axes -------------------------------------------------------------
  const confById = new Map<string, NormalizedYAxis>(cfg.yAxes.map((a) => [a.id, a]));
  const isBinaryAxis = axes.map((a) => a.id === BINARY_AXIS_ID);
  const visible = axes.map((a, i) => cfg.show.yAxis && !isBinaryAxis[i] && (confById.get(a.id)?.show ?? true));
  const splitOwner = visible.indexOf(true);
  const sideCount: Record<AxisPosition, number> = { left: 0, right: 0 };
  let hasAxisName = false;
  // ~1 y tick per 55px keeps small cards airy (220px -> 4 intervals).
  const heightPx = /^\s*(\d+(?:\.\d+)?)px\s*$/.exec(cfg.height);
  const splitNumber = Math.max(2, Math.min(8, Math.round((heightPx ? Number(heightPx[1]) : 220) / 55)));

  // Bounds per axis: hard, or soft against the extent of its visible series (hidden ones do not stretch it).
  const bounds = axes.map((a, i) => {
    const conf = confById.get(a.id);
    let dataMin = Infinity;
    let dataMax = -Infinity;
    data.forEach((d, j) => {
      if (seriesAxis[j] !== i || hidden.has(d.series.key)) return;
      dataMin = Math.min(dataMin, extents[j].min);
      dataMax = Math.max(dataMax, extents[j].max);
    });
    return {
      min: resolveBound(conf?.min, conf?.softMin, dataMin, 'min'),
      max: resolveBound(conf?.max, conf?.softMax, dataMax, 'max'),
      dataMin,
      dataMax,
    };
  });
  // Fully fixed visible axes: even intervals, sharing one split count when a common one is close to
  // the target so labels of every axis sit on the same grid lines (0..5000 W with 0..100 %).
  const maxSplits = Math.max(3, Math.round(splitNumber * 1.5));
  const splitOptions = axes.map((_, i) => {
    const { min, max } = bounds[i];
    return !isBinaryAxis[i] && min !== undefined && max !== undefined ? evenSplits(min, max, maxSplits) : undefined;
  });
  const fixedVisible = splitOptions.filter((o, i): o is Map<number, number> => o !== undefined && visible[i]);
  let sharedSplits: number | undefined;
  if (fixedVisible.length > 1) {
    const common = [...fixedVisible[0].keys()].filter((n) => fixedVisible.every((o) => o.has(n)));
    const n = pickSplits(common, splitNumber);
    if (n !== undefined && Math.abs(n - splitNumber) <= 1) sharedSplits = n;
  }
  // Auto grid-owner axis next to fully fixed secondaries (W next to 0..100 %): choose the owner's
  // ticks ourselves so their count suits the secondaries (alignTicks would give 16.67 % steps).
  const ownerFixed = splitOwner >= 0 && splitOptions[splitOwner] !== undefined;
  const fixedSecondaries = splitOptions.filter((o, i): o is Map<number, number> => o !== undefined && visible[i] && i !== splitOwner);
  const ownerFit =
    splitOwner >= 0 && !ownerFixed && !markExtrema && fixedSecondaries.length
      ? fitAutoAxis(bounds[splitOwner], splitNumber, maxSplits, fixedSecondaries)
      : undefined;

  const yAxis: YAxisOption[] = axes.map((a, i) => {
    if (isBinaryAxis[i]) {
      return { type: 'value', id: a.id, show: false, position: a.position, min: 0, max: 1, interval: 1 };
    }
    const conf = confById.get(a.id);
    const offset = visible[i] ? sideCount[a.position]++ * AXIS_OFFSET_PX : 0;
    const unit = a.unit;
    const precision = conf?.precision;
    let { min, max } = bounds[i];
    const splits = splitOptions[i];
    // Fully fixed axes get an interval that lands on both ends. The first visible axis owns the
    // grid lines; the others match its segment count (shared split count / fitted owner ticks) or
    // align their ticks to it (alignTicks), so every label sits on a grid line.
    let interval: number | undefined;
    if (ownerFit && i === splitOwner) {
      ({ min, max, interval } = ownerFit);
    } else if (splits) {
      let n: number | undefined;
      if (visible[i] && ownerFit) n = ownerFit.splits;
      else if (visible[i] && sharedSplits !== undefined) n = sharedSplits;
      else if (i === splitOwner || !visible[i] || ownerFixed) n = pickSplits(splits.keys(), splitNumber);
      if (n !== undefined) interval = splits.get(n);
    }
    const aligned = interval === undefined && i !== splitOwner && splitOwner >= 0;
    const lo = min ?? bounds[i].dataMin;
    const hi = max ?? bounds[i].dataMax;
    const minDecimals =
      interval !== undefined ? stepDecimals(interval) : labelDecimals(lo, hi, aligned ? splitNumber * 2 : splitNumber);
    if (visible[i] && conf?.name) hasAxisName = true;
    const axis: YAxisOption = {
      type: 'value',
      id: a.id,
      show: visible[i],
      position: a.position,
      offset,
      scale: true,
      min,
      max,
      splitNumber,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: {
        color: theme.secondaryText,
        fontSize: FONT_SIZE,
        margin: 8,
        hideOverlap: true,
        formatter: (v: number): string => formatAxisValue(v, unit, precision, locale, minDecimals),
      },
      splitLine: {
        show: i === splitOwner,
        lineStyle: { color: theme.divider, type: [3, 3], width: 1 },
      },
    };
    if (interval !== undefined) axis.interval = interval;
    else if (aligned) axis.alignTicks = true;
    // Headroom so min/max labels do not collide with the plot edges / x-axis labels.
    if (markExtrema) axis.boundaryGap = ['10%', '10%'];
    if (conf?.name) {
      axis.name = conf.name;
      axis.nameLocation = 'end';
      axis.nameGap = 10;
      axis.nameTextStyle = { color: theme.secondaryText, fontSize: FONT_SIZE, align: a.position === 'left' ? 'left' : 'right' };
    }
    return axis;
  });

  // ---- series -------------------------------------------------------------
  const info: SeriesInfo[] = [];
  const visualMap: VisualMapOption[] = [];
  const legendSelected: Record<string, boolean> = {};

  const series: LineSeriesOption[] = data.map((d, i) => {
    const s = d.series;
    const name = names[i];
    const stops = s.colorThresholds.map((t) => ({ value: t.value, color: resolve(t.color) }));
    const baseColor = resolve(s.color);
    const color = stops.length === 1 ? stops[0].color : baseColor;
    const useVisualMap = stops.length > 1;
    const step = resolveStep(s.line.step, d.isBinary);
    const points = pointsList[i];
    const precision = displayPrecision(hass, s);
    const width = s.line.width;

    info.push({
      data: d,
      // Statistics rows are looked up by bucket (the synthetic end-of-bucket point would extend the last one).
      points: bucketList[i] > 0 ? d.points : points,
      name,
      color,
      stops: useVisualMap ? stops : [],
      unit: d.unit,
      precision,
      hidden: hidden.has(s.key),
      bucketMs: bucketList[i],
      onOff: d.isBinary ? binaryLabels(hass, s) : ['0', '1'],
    });
    legendSelected[name] = !hidden.has(s.key);

    const opt: LineSeriesOption = {
      type: 'line',
      id: s.key,
      name,
      color,
      data: points,
      xAxisIndex: 0,
      yAxisIndex: seriesAxis[i],
      showSymbol: cfg.show.points,
      showAllSymbol: 'auto',
      symbol: 'circle',
      symbolSize: cfg.show.points ? Math.max(4, width + 2) : Math.max(7, width + 5),
      itemStyle: cfg.show.points ? { borderWidth: 0 } : { borderColor: theme.background, borderWidth: 2 },
      // Binary lines next to real values are drawn a bit lighter so the "on" bands stay background.
      lineStyle: { width, type: s.line.style, cap: 'round', join: 'round', ...(mixedBinary && d.isBinary ? { opacity: 0.75 } : {}) },
      emphasis: { focus: 'none', scale: cfg.show.points ? 1.6 : false, lineStyle: { width } },
      step,
      smooth: step || s.line.smooth <= 0 ? false : s.line.smooth,
      smoothMonotone: 'x',
      connectNulls: false,
      clip: true,
      legendHoverLink: false,
      z: 2,
    };
    if (points.length > SAMPLING_MIN_POINTS && !step) opt.sampling = 'lttb';

    if (s.fill !== 'none' && s.fillOpacity > 0) {
      if (d.isBinary && !useVisualMap) {
        // A fading full-height 0/1 column looks muddy: binary areas are flat, light "on" bands.
        opt.areaStyle = { opacity: s.fill === 'gradient' ? Math.min(s.fillOpacity, 0.35) * 0.45 : s.fillOpacity, color };
      } else if (useVisualMap) {
        // Let the area inherit the visualMap colors (flat; a value gradient cannot also fade).
        opt.areaStyle = { opacity: s.fill === 'gradient' ? s.fillOpacity * 0.6 : s.fillOpacity };
      } else if (s.fill === 'gradient') {
        opt.areaStyle = { opacity: s.fillOpacity, color: fillGradient(color, extents[i]) as never };
      } else {
        opt.areaStyle = { opacity: s.fillOpacity, color };
      }
    }

    if (useVisualMap) {
      visualMap.push({
        type: 'piecewise',
        show: false,
        seriesIndex: i,
        dimension: 1,
        pieces: visualPieces(stops),
        outOfRange: { color: baseColor },
      });
    }

    if (markExtrema && !d.isBinary && points.length > 1) {
      const label = (position: 'top' | 'bottom') => ({
        show: true,
        position,
        distance: 5,
        color: theme.text,
        fontSize: 10,
        fontWeight: 500 as const,
        formatter: (p: { value?: unknown }): string =>
          formatValue(typeof p.value === 'number' ? p.value : Number(p.value), d.unit, precision, locale),
      });
      opt.markPoint = {
        silent: true,
        animation: false,
        symbol: 'circle',
        symbolSize: 6,
        itemStyle: { color, borderColor: theme.background, borderWidth: 1.5 },
        emphasis: { disabled: true },
        data: [
          { type: 'max', name: 'max', label: label('top') },
          { type: 'min', name: 'min', label: label('bottom') },
        ],
      };
    }
    return opt;
  });

  // Thresholds: one empty carrier series per axis, so hiding a data series never hides them.
  const byAxis = new Map<number, NormalizedThreshold[]>();
  for (const t of cfg.thresholds) {
    const ai = t.yAxis !== null ? axes.findIndex((a) => a.id === t.yAxis) : 0;
    const key = ai < 0 ? 0 : ai;
    const list = byAxis.get(key) ?? [];
    list.push(t);
    byAxis.set(key, list);
  }
  for (const [ai, list] of byAxis) series.push(thresholdCarrier(axes[ai], ai, list, theme, resolve));

  // ---- x axis -------------------------------------------------------------
  const maxTicks = ctx.width && ctx.width > 0 ? Math.max(2, Math.min(12, Math.round(ctx.width / 90))) : 6;
  const customTicks = cfg.show.xAxis && !zoneMatchesBrowser(tf, start, now) ? timeTicks(tf, start, now, maxTicks) : undefined;
  const emphasiseDays = spanMs <= WEEK;
  const xAxis: NonNullable<ECOption['xAxis']> = {
    type: 'time',
    min: start,
    max: now,
    show: cfg.show.xAxis,
    axisLine: { show: false },
    axisTick: { show: false, ...(customTicks ? { customValues: customTicks } : {}) },
    splitLine: { show: false },
    axisLabel: {
      color: theme.secondaryText,
      fontSize: FONT_SIZE,
      margin: 8,
      hideOverlap: true,
      formatter: (v: number): string => {
        const text = tf.axis(v, spanMs);
        return emphasiseDays && tf.isDayStart(v) ? `{day|${text}}` : text;
      },
      rich: { day: { color: theme.text, fontWeight: 500, fontSize: FONT_SIZE } },
      ...(customTicks ? { customValues: customTicks } : {}),
    },
  };

  // ---- layout -------------------------------------------------------------
  const anyYAxisVisible = visible.some(Boolean);
  const bleed = !cfg.show.xAxis && !anyYAxisVisible;
  const grid = {
    left: bleed ? 0 : 12,
    right: bleed ? 0 : 12,
    top: hasAxisName ? 26 : 10,
    bottom: (cfg.show.legend ? 30 : 0) + (bleed ? 0 : cfg.show.xAxis ? 4 : 8),
    outerBoundsMode: 'same' as const,
    outerBoundsContain: 'all' as const,
  };

  // ---- tooltip / legend / zoom ----------------------------------------------
  const tooltip: ECOption['tooltip'] = cfg.show.tooltip
    ? {
        show: true,
        trigger: 'axis',
        appendTo: 'body',
        className: 'echart-graph-card-tooltip',
        confine: false,
        transitionDuration: 0.15,
        backgroundColor: theme.tooltipBackground,
        borderColor: theme.tooltipBorder,
        borderWidth: 1,
        padding: [8, 12],
        textStyle: { color: theme.tooltipText, fontSize: 12, fontFamily: theme.fontFamily },
        extraCssText: `border-radius:10px;box-shadow:0 6px 24px ${theme.dark ? 'rgba(0,0,0,0.45)' : 'rgba(0,0,0,0.12)'};`,
        axisPointer: {
          type: 'line',
          snap: true,
          animation: false,
          label: { show: false },
          lineStyle: { color: scaleAlpha(theme.secondaryText, 0.55), width: 1, type: [4, 3] },
        },
        formatter: tooltipFormatter(info, tf, locale, theme, tooltipResolution(cfg, data)) as never,
      }
    : { show: false };

  const legend: ECOption['legend'] = {
    show: cfg.show.legend,
    type: 'scroll',
    bottom: 2,
    left: 'center',
    icon: 'roundRect',
    itemWidth: 14,
    itemHeight: 6,
    itemGap: 16,
    textStyle: { color: theme.secondaryText, fontSize: 12 },
    inactiveColor: scaleAlpha(theme.secondaryText, 0.4),
    pageIconColor: theme.secondaryText,
    pageIconInactiveColor: scaleAlpha(theme.secondaryText, 0.3),
    pageIconSize: 10,
    pageTextStyle: { color: theme.secondaryText, fontSize: 11 },
    data: names,
    selected: legendSelected,
  };

  const option: ECOption = {
    backgroundColor: 'transparent',
    textStyle: { fontFamily: theme.fontFamily },
    animation: animate,
    animationDuration: ANIMATION_MS,
    animationDurationUpdate: ANIMATION_MS,
    animationEasing: 'cubicOut',
    animationEasingUpdate: 'cubicOut',
    grid,
    xAxis,
    yAxis,
    series,
    tooltip,
    legend,
  };
  if (visualMap.length) option.visualMap = visualMap;
  if (cfg.show.zoom) {
    option.dataZoom = [
      {
        type: 'inside',
        xAxisIndex: 0,
        filterMode: 'none',
        zoomOnMouseWheel: 'ctrl',
        moveOnMouseWheel: false,
        moveOnMouseMove: true,
        preventDefaultMouseMove: true,
        minValueSpan: MINUTE,
      },
    ];
  }
  return option as EChartsCoreOption;
}
