/**
 * THE CONTRACT for echart-graph-card.
 *
 * Three groups of types live here:
 *  1. Raw YAML config (`CardConfig` and friends) - exactly what the user writes, all optional
 *     except `type` and `series`/`entities`. snake_case keys, durations as strings/numbers.
 *  2. Normalized config (`NormalizedConfig` / `NormalizedSeries`) - produced by
 *     `normalizeConfig()` in src/config.ts. camelCase, every default resolved, durations in ms,
 *     explicit y-axis references validated. Everything downstream consumes ONLY this.
 *  3. Runtime data (`Point`, `SeriesData`, `ThemeColors`) plus the minimal Home Assistant
 *     surface we depend on (`HomeAssistant`, `HassEntityState`, WS message/response shapes).
 *
 * This file must stay free of runtime code (types only) so every module can import it.
 */

// ---------------------------------------------------------------------------
// Shared enums / primitives
// ---------------------------------------------------------------------------

/**
 * A duration as written in YAML.
 * - string: one or more `<number><unit>` groups, e.g. `"30s"`, `"5m"`, `"1h30m"`, `"1.5h"`,
 *   `"7d"`, `"2w"`, `"500ms"`, `"10 minutes"`. Units: ms, s/sec/second(s), m/min/minute(s),
 *   h/hr/hour(s), d/day(s), w/week(s). Case-insensitive, whitespace tolerated.
 * - number (or purely numeric string): interpreted in the field's default unit
 *   (documented per field; seconds unless stated otherwise).
 */
export type DurationInput = string | number;

/** Where series data comes from. `auto` = history for spans <= 72h, statistics above. */
export type DataSource = 'auto' | 'history' | 'statistics';

/** Long-term statistics bucket size (recorder/statistics_during_period `period`). */
export type StatisticsPeriod = '5minute' | 'hour' | 'day' | 'week' | 'month';

/** Which column of a long-term statistics row to plot. */
export type StatisticType = 'mean' | 'min' | 'max' | 'sum' | 'state' | 'change';

/** Aggregation used by `group_by`. `delta` = last - first within the bucket. */
export type GroupByFunc = 'avg' | 'min' | 'max' | 'first' | 'last' | 'sum' | 'delta' | 'median';

/** Area fill under a line. `gradient` fades from `fill_opacity` at the line to 0 at the axis. */
export type FillMode = 'none' | 'solid' | 'gradient';

/** Stroke dash style for lines and threshold lines. */
export type LineStyle = 'solid' | 'dashed' | 'dotted';

/**
 * ECharts step mode. `false` = no stepping. For sample-and-hold sensor data `'end'` is the
 * correct choice (value holds until the next point, then jumps).
 */
export type StepMode = false | 'start' | 'middle' | 'end';

export type AxisPosition = 'left' | 'right';

export type UpdateMode = 'live' | 'interval' | 'none';

/** How a series is drawn. `bar`: one bar per bucket (statistics row, group_by bucket or list item). */
export type SeriesType = 'line' | 'bar';

/** `span.start`: align the window start to this calendar boundary (HA display time zone). */
export type SpanStart = 'day';

// ---------------------------------------------------------------------------
// 1. Raw YAML config
// ---------------------------------------------------------------------------

/** `series[].line` */
export interface LineConfig {
  /** Stroke width in px. Default 2 (binary series: 1.5). */
  width?: number;
  /** `true`/`false`, or a smoothness factor 0..1. Default true (= 0.35) for non-binary series. */
  smooth?: boolean | number;
  /** `true` = `'end'`. Default: auto (`'end'` for binary series, off otherwise). */
  step?: boolean | 'start' | 'middle' | 'end';
  /** Default `solid`. */
  style?: LineStyle;
}

/** `group_by` - bucket raw points into fixed windows. */
export interface GroupByConfig {
  /** Default `avg`. */
  func?: GroupByFunc;
  /** Bucket size. Bare numbers are seconds. Must be > 0. */
  duration: DurationInput;
}

/** `series[].transform` - applied to every value: `v * multiply + offset`. */
export interface TransformConfig {
  /** Default 1. */
  multiply?: number;
  /** Default 0. */
  offset?: number;
}

/**
 * One stop of `series[].color_thresholds` (rendered via ECharts visualMap, per series).
 * A stop's color applies from `value` (inclusive) up to the next stop's value; values below
 * the lowest stop use the lowest stop's color.
 */
export interface ColorThreshold {
  value: number;
  /** Any CSS color: hex, rgb(a), hsl, named, or `var(--x)`. */
  color: string;
}

/** `show:` toggles. All optional; defaults noted per key. */
export interface ShowConfig {
  /** ECharts legend. Default: true only if >1 series AND `header_states` is false (header chips act as the legend otherwise). */
  legend?: boolean;
  /** Axis tooltip on hover/tap. Default true. */
  tooltip?: boolean;
  /** Header chips with name + current value per series (`show_in_header`). Default true. */
  header_states?: boolean;
  /** Mouse/touch zoom on the time axis (dataZoom inside; wheel zoom requires Ctrl). Default false. */
  zoom?: boolean;
  /**
   * Min / max / avg badges for header series over the visible window. With `header_states: false`
   * min / max markers are drawn on the chart instead. Default false.
   */
  extrema?: boolean;
  /** Draw a symbol at every data point. Default false. */
  points?: boolean;
  /** Show the time axis labels. Default true. */
  x_axis?: boolean;
  /** Show y-axis labels. Default true. */
  y_axis?: boolean;
}

/** `y_axes[]` - explicitly configured value axes. */
export interface YAxisConfig {
  /** Referenced by `series[].y_axis` and `thresholds[].y_axis`. Must be unique. */
  id: string;
  /** Series with this unit (and no explicit `y_axis`) are auto-assigned to this axis. */
  unit?: string;
  /** Axis title. Default: none (unit is shown in labels). */
  name?: string;
  /** Hard bound. Default `auto` (fit data). */
  min?: number | 'auto';
  /** Hard bound. Default `auto` (fit data). */
  max?: number | 'auto';
  /** Axis extends to at least this value, further if data goes below. */
  soft_min?: number;
  /** Axis extends to at least this value, further if data goes above. */
  soft_max?: number;
  /** Default: first configured axis `left`, second `right`, then alternating. */
  position?: AxisPosition;
  /** Decimals for axis labels. Default: auto from the value range. */
  precision?: number;
  /** Render labels/line for this axis. Default true. */
  show?: boolean;
}

/**
 * `thresholds[]` - horizontal reference lines (`value`) or bands (`from`/`to`).
 * Exactly one of: `value`, or at least one of `from`/`to`.
 */
export interface ThresholdConfig {
  /** Draws a markLine at this y value. */
  value?: number;
  /** Band lower bound (omit = axis minimum). */
  from?: number;
  /** Band upper bound (omit = axis maximum). */
  to?: number;
  /** Default: theme secondary text color. */
  color?: string;
  /** Line style. Default `dashed`. */
  style?: LineStyle;
  /** Line width px. Default 1. */
  width?: number;
  /** Line: default 0.8. Band: default 0.12. */
  opacity?: number;
  /** Optional text label drawn at the right end of the line / inside the band. */
  label?: string;
  /** Axis id. Default: the first y-axis in the chart. */
  y_axis?: string;
}

/**
 * `span` as an object: a window aligned to a calendar boundary instead of ending now, e.g.
 * `{ start: day }` = today 00:00 to 24:00 (the right part lies in the future until the day ends).
 */
export interface SpanConfig {
  /** Required. */
  start: SpanStart;
  /** Window length from the aligned start. Bare numbers are hours. Default: `hours_to_show`, else 24h. */
  duration?: DurationInput;
}

/** One entry of `series:` (a bare string is shorthand for `{ entity: <string> }`). */
export interface SeriesConfig {
  /** Entity id (`sensor.x`) or external statistic id (`source:stat_id`). Required. */
  entity: string;
  /** Display name. Default: entity friendly_name, then entity id. */
  name?: string;
  /** CSS color incl. `var(--x)`. Default: DEFAULT_PALETTE[index]. */
  color?: string;
  /**
   * Unit override. Default: entity `unit_of_measurement`; for `attribute` series only the
   * temperature / humidity attributes of climate-like entities have a default (set `unit` for
   * others, and whenever `transform` changes the unit).
   */
  unit?: string;
  /** Explicit `y_axes[].id`. Default: auto axis by unit. */
  y_axis?: string;
  /** Plot this attribute instead of the state. */
  attribute?: string;
  /**
   * Read the series from the CURRENT value of `attribute`, a list of objects (e.g. Solcast's
   * `detailedForecast`, energy price lists): this key of each item is the value. Requires
   * `attribute`; no history or statistics are fetched, and the series follows the entity live.
   */
  value_key?: string;
  /**
   * With `value_key`: the key holding each item's timestamp (ISO string, or epoch s / ms).
   * Default: the first of `period_start`, `start`, `start_time`, `startsAt`, `datetime`, `time`, `from`.
   */
  time_key?: string;
  /** `line` (default) or `bar` (`column` is accepted as an alias). */
  type?: SeriesType | 'column';
  line?: LineConfig;
  /** Default: `gradient` when the card has <= 2 series, else `none` (also `none` with >= 2 `color_thresholds`). */
  fill?: FillMode;
  /** 0..1. Default: gradient 0.35, solid 0.2. */
  fill_opacity?: number;
  /**
   * Per-series bucketing. A duration shorthand (`"5m"`) means `{ func: avg, duration }`.
   * `false` disables a card-level `group_by` for this series. Default: card-level `group_by`.
   */
  group_by?: GroupByConfig | DurationInput | false;
  transform?: TransformConfig;
  /** Color the line by value (per-series visualMap). */
  color_thresholds?: ColorThreshold[];
  /**
   * Statistics column. Setting it makes this series use long-term statistics regardless of the
   * window / `data_source`. Default: auto (see NormalizedSeries.statistic).
   */
  statistic?: StatisticType;
  /** Decimals for header/tooltip. Default: entity display_precision, else auto. */
  precision?: number;
  /** Show a chip for this series in the header. Default true. */
  show_in_header?: boolean;
  /**
   * Draw the series in the chart. `false` makes a value-only header chip: the entity's current
   * value, never fetched or drawn, no axis, legend or tooltip entry, and no show/hide toggle.
   * Default true.
   */
  show_in_chart?: boolean;
  /** Start with this series hidden (toggleable via header chip / legend). Default false. */
  hidden?: boolean;
}

/** The raw card config as written in YAML. */
export interface CardConfig {
  type: string;
  title?: string;
  /** Window length: a number of hours, or a duration string (`"36h"`). Default 24. Ignored when `span` is given. */
  hours_to_show?: number | string;
  /**
   * Window length as a duration (`"7d"`); bare numbers are hours. Takes precedence over
   * `hours_to_show`. An object (`{ start: day }`) aligns the window to the start of the day.
   */
  span?: DurationInput | SpanConfig;
  /**
   * Chart height. Number = px, string = an absolute or viewport CSS length (`250px`, `15rem`,
   * `30vh`). Default `220px`. In the sections layout the card fills its grid cell only when
   * `grid_options.rows` is a number; otherwise this height applies there too.
   */
  height?: string | number;
  /** Default `auto`. */
  data_source?: DataSource;
  /**
   * Default: span <= 2d -> `5minute`, <= 31d -> `hour`, else `day`. Setting it with
   * `data_source: auto` makes the card use long-term statistics for any window.
   */
  statistics_period?: StatisticsPeriod;
  /**
   * `live` (default): append points from hass.states changes, refetch every 5 min.
   * `none`: fetch once. A duration (`"60s"`, or `{ interval: "60s" }`; bare number = seconds):
   * refetch on that cadence and ignore hass.states changes.
   */
  update?: 'live' | 'none' | DurationInput | { interval: DurationInput };
  show?: ShowConfig;
  y_axes?: YAxisConfig[];
  thresholds?: ThresholdConfig[];
  /** Default `group_by` for every series (series-level wins). */
  group_by?: GroupByConfig | DurationInput;
  /** The series to plot. Required and non-empty (or use `entities`). */
  series?: Array<SeriesConfig | string>;
  /** Alias of `series` (mini-graph-card compatibility). Used only when `series` is absent. */
  entities?: Array<SeriesConfig | string>;
}

// ---------------------------------------------------------------------------
// 2. Normalized config (output of normalizeConfig)
// ---------------------------------------------------------------------------

export interface NormalizedLine {
  width: number;
  /** 0 = straight segments, otherwise ECharts smoothness 0..1. */
  smooth: number;
  /** `'auto'` = resolved at render time: `'end'` if SeriesData.isBinary, else `false`. */
  step: StepMode | 'auto';
  style: LineStyle;
}

export interface NormalizedGroupBy {
  func: GroupByFunc;
  durationMs: number;
}

export interface NormalizedTransform {
  multiply: number;
  offset: number;
}

export interface NormalizedSeries {
  /** Position in `series:` (0-based). SeriesData[] arrays are aligned to this. */
  index: number;
  /** Unique, stable key: `${index}:${entity}` plus `#${attribute}` when set. Used for maps / ECharts series ids. */
  key: string;
  entity: string;
  attribute?: string;
  /** List attribute series (see SeriesConfig.value_key): key of each item's value. */
  valueKey?: string;
  /** List attribute series: explicit time key, undefined = auto-detect (LIST_TIME_KEYS). */
  timeKey?: string;
  type: SeriesType;
  /** Explicit name only. The display name is resolved at load time into SeriesData.name. */
  name?: string;
  /** Explicit color or palette color by index. May be `var(--x)`; resolve with resolveColor() before handing to ECharts. */
  color: string;
  /** Explicit unit override only (entity unit is resolved into SeriesData.unit). */
  unit?: string;
  /**
   * Explicit y-axis id (validated to exist in NormalizedConfig.yAxes), or the id of the
   * configured axis whose `unit` equals `series.unit`, or `null` = auto-assign at render time
   * by SeriesData.unit (see assignAxes in src/chart/options.ts).
   */
  yAxis: string | null;
  line: NormalizedLine;
  /** Fully resolved (the `auto` default is decided by normalizeConfig). */
  fill: FillMode;
  /** 0..1 */
  fillOpacity: number;
  /** Resolved from series or card-level group_by; null = raw points. */
  groupBy: NormalizedGroupBy | null;
  /** Always present; identity is `{ multiply: 1, offset: 0 }`. */
  transform: NormalizedTransform;
  /** Sorted ascending by value. Empty = no visualMap. */
  colorThresholds: ColorThreshold[];
  /**
   * Statistics column. `'auto'` is resolved by the loader: `'mean'` for measurement-like
   * entities, `'state'` when the entity's `state_class` is `total` / `total_increasing`.
   */
  statistic: StatisticType | 'auto';
  /** Explicit decimals, undefined = entity display_precision or auto. */
  precision?: number;
  showInHeader: boolean;
  /** false = value-only header chip (in NormalizedConfig.valueSeries, never in `series`). */
  showInChart: boolean;
  hidden: boolean;
}

export interface NormalizedYAxis {
  id: string;
  unit?: string;
  name?: string;
  /** Hard bounds; undefined = auto. */
  min?: number;
  max?: number;
  softMin?: number;
  softMax?: number;
  position: AxisPosition;
  precision?: number;
  show: boolean;
}

export interface NormalizedThreshold {
  /** `line` when `value` was given, `area` for `from`/`to`. */
  kind: 'line' | 'area';
  value?: number;
  /** undefined = axis minimum */
  from?: number;
  /** undefined = axis maximum */
  to?: number;
  /** undefined = ThemeColors.secondaryText. May be `var(--x)`. */
  color?: string;
  style: LineStyle;
  width: number;
  opacity: number;
  label?: string;
  /** Validated axis id, or null = first y-axis of the chart. */
  yAxis: string | null;
}

export interface NormalizedUpdate {
  mode: UpdateMode;
  /**
   * `interval`: refetch period. `live`: 300000 (5 min, kept for reference; in live mode the card
   * refreshes statistics series right after each statistics period has been compiled and never
   * refetches history). `none`: 0.
   */
  intervalMs: number;
}

export interface NormalizedShow {
  legend: boolean;
  /**
   * Keys of the series listed in the legend. Default legend: only the series the header chips do
   * not cover (not in the header, or the single hero value, which has no toggle), so chips and
   * legend together make every series toggleable. `show.legend: true` or `header_states: false`:
   * every series.
   */
  legendKeys: string[];
  tooltip: boolean;
  headerStates: boolean;
  zoom: boolean;
  extrema: boolean;
  points: boolean;
  xAxis: boolean;
  yAxis: boolean;
}

export interface NormalizedConfig {
  type: string;
  title?: string;
  /**
   * Window length in ms. Without `spanStart` the window is [now - spanMs, now]; with it, it starts
   * at the aligned boundary (see chartWindow in src/data/transform.ts).
   */
  spanMs: number;
  /** `span.start`: calendar-aligned window start, null = the window ends now. */
  spanStart: SpanStart | null;
  /** CSS length, e.g. `'220px'`. */
  height: string;
  /**
   * Resolved card-level source (auto -> history if spanMs <= 72h and no statistics_period is
   * configured, else statistics). Series may still differ (see the loader's plannedSource).
   */
  dataSource: 'history' | 'statistics';
  /** True when the user did not force a source; the loader may then fall back statistics -> history per series. */
  dataSourceAuto: boolean;
  statisticsPeriod: StatisticsPeriod;
  update: NormalizedUpdate;
  show: NormalizedShow;
  /** Explicitly configured axes only (auto axes are created at render time). */
  yAxes: NormalizedYAxis[];
  thresholds: NormalizedThreshold[];
  /** Non-empty. */
  series: NormalizedSeries[];
  /**
   * Value-only header chips (`show_in_chart: false`): own index / key space ("v<i>:..."), never
   * loaded, drawn or toggled.
   */
  valueSeries: NormalizedSeries[];
  /** The header chips in config order: drawn series with show_in_header, then value-only ones in place. Empty with show.header_states false. */
  headerSeries: NormalizedSeries[];
  /** The original config object (for getCardSize/getGridOptions heuristics, debugging). */
  raw: CardConfig;
  /**
   * Non-fatal problems (unknown / ignored options, with hints for apexcharts-card and
   * mini-graph-card keys). Shown inside the card.
   */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// 3. Runtime data
// ---------------------------------------------------------------------------

/** `[timestamp in epoch ms, value]`. `null` value = gap (unavailable/unknown): the line breaks. */
export type Point = [number, number | null];

/** One fully loaded series, aligned with NormalizedConfig.series by index. */
export interface SeriesData {
  series: NormalizedSeries;
  /** Ascending by time, transform + group_by already applied. */
  points: Point[];
  /** series.unit ?? entity unit_of_measurement ?? statistics metadata unit. */
  unit?: string;
  /** series.name ?? friendly_name ?? entity id. */
  name: string;
  /** Plotted as 0/1 step line (binary_sensor, input_boolean, switch, ... or on/off states). */
  isBinary: boolean;
  /**
   * Current value from hass.states (transform applied, not grouped): number, `null` when
   * unavailable/unknown/non-numeric, `undefined` when the entity is not in hass.states.
   */
  latest?: number | null;
  /**
   * Which backend produced `points`. Live append only applies to `history`; `attribute` series
   * (list attributes, `value_key`) are re-read from hass.states whenever the entity changes.
   */
  source: 'history' | 'statistics' | 'attribute';
  /**
   * Grouped history series only: the transformed, ungrouped points of the last (open) bucket,
   * preceded by the last point before it (the value carried into the bucket), so LiveBuffer can
   * re-aggregate that bucket incrementally.
   */
  rawTail?: Point[];
  /** Non-fatal per-series problem (e.g. unknown entity); shown in the card. */
  error?: string;
}

/** Colors (and font) read from the HA theme, already resolved to concrete CSS values. */
export interface ThemeColors {
  dark: boolean;
  /** --primary-text-color */
  text: string;
  /** --secondary-text-color */
  secondaryText: string;
  /** --divider-color (grid lines, axis lines) */
  divider: string;
  /** --ha-card-background / --card-background-color */
  background: string;
  /** --primary-color */
  primary: string;
  tooltipBackground: string;
  tooltipText: string;
  tooltipBorder: string;
  /** Font family string for ECharts textStyle. */
  fontFamily: string;
}

// ---------------------------------------------------------------------------
// Home Assistant surface (minimal, structural)
// ---------------------------------------------------------------------------

export interface HassEntityAttributes {
  friendly_name?: string;
  unit_of_measurement?: string;
  device_class?: string;
  /** `measurement` | `total` | `total_increasing` */
  state_class?: string;
  icon?: string;
  [key: string]: unknown;
}

export interface HassEntityState {
  entity_id: string;
  state: string;
  attributes: HassEntityAttributes;
  /** ISO 8601 */
  last_changed: string;
  /** ISO 8601 */
  last_updated: string;
  context?: { id: string; parent_id?: string | null; user_id?: string | null };
}

export interface HassMessage {
  type: string;
  [key: string]: unknown;
}

export interface HassConnection {
  subscribeMessage<T>(callback: (msg: T) => void, msg: HassMessage): Promise<() => Promise<void>>;
}

/** `language` | `system` | `comma_decimal` | `decimal_comma` | `space_comma` | `none` */
export type NumberFormat = 'language' | 'system' | 'comma_decimal' | 'decimal_comma' | 'space_comma' | 'none';

/** `language` | `system` | `12` | `24` */
export type TimeFormat = 'language' | 'system' | '12' | '24';

export interface HassLocale {
  language: string;
  /** `local` = browser zone, `server` = hass.config.time_zone. */
  time_zone: 'local' | 'server' | string;
  number_format: NumberFormat;
  time_format?: TimeFormat;
}

export interface HassEntityRegistryDisplayEntry {
  entity_id: string;
  display_precision?: number;
  [key: string]: unknown;
}

export interface HomeAssistant {
  states: Record<string, HassEntityState>;
  callWS<T>(msg: HassMessage): Promise<T>;
  connection: HassConnection;
  locale: HassLocale;
  config: { time_zone: string; [key: string]: unknown };
  themes: { darkMode: boolean; [key: string]: unknown };
  /** Entity registry display entries (present in modern HA). */
  entities?: Record<string, HassEntityRegistryDisplayEntry>;
  language?: string;
}

// ---------------------------------------------------------------------------
// HA WebSocket message / response shapes
// ---------------------------------------------------------------------------

export interface HistoryDuringPeriodMessage extends HassMessage {
  type: 'history/history_during_period';
  /** ISO 8601 */
  start_time: string;
  /** ISO 8601 */
  end_time: string;
  entity_ids: string[];
  minimal_response: boolean;
  no_attributes: boolean;
  significant_changes_only: boolean;
}

/**
 * Compressed history state. The first entry per entity is a full state (`a` present unless
 * `no_attributes`), later entries are minimal (`{ s, lu }`) when `minimal_response` is set.
 * Timestamps are epoch SECONDS (float). `lc` (last_changed) is omitted when equal to `lu`.
 */
export interface HistoryState {
  s: string;
  a?: Record<string, unknown>;
  lu: number;
  lc?: number;
}

export type HistoryResponse = Record<string, HistoryState[]>;

export interface StatisticsDuringPeriodMessage extends HassMessage {
  type: 'recorder/statistics_during_period';
  start_time: string;
  end_time: string;
  statistic_ids: string[];
  period: StatisticsPeriod;
  types: StatisticType[];
  units?: Record<string, string>;
}

/** One statistics row. `start`/`end` are epoch ms (older HA: ISO strings). */
export interface StatisticValue {
  start: number | string;
  end: number | string;
  mean?: number | null;
  min?: number | null;
  max?: number | null;
  sum?: number | null;
  state?: number | null;
  change?: number | null;
  last_reset?: number | string | null;
}

export type StatisticsResponse = Record<string, StatisticValue[]>;
