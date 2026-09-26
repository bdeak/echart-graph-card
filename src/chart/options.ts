import { notImplemented } from '../stub';
import type { EChartsCoreOption } from './echarts';
import type { AxisPosition, HomeAssistant, NormalizedConfig, SeriesData, ThemeColors } from '../types';

/** Extra inputs to buildOptions (kept explicit so buildOptions stays pure). */
export interface BuildContext {
  hass: HomeAssistant;
  /** Epoch ms; x-axis spans [now - cfg.spanMs, now]. */
  now: number;
  /** Maps user colors (`var(--x)`) to concrete colors; the card passes `c => resolveColor(this, c)`. Default identity. */
  resolveColor?: (c: string) => string;
  /** Series keys currently toggled off by the user (header chip / legend). Default: series with `hidden: true`. */
  hiddenKeys?: ReadonlySet<string>;
}

/** One y-axis actually rendered (configured or auto-created). */
export interface ResolvedAxis {
  /** Configured id, or `unit:<unit>` / `unit:` (unitless) for auto axes. */
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

/**
 * Decide which y-axis each series uses.
 * 1. `series.yAxis` set -> that configured axis.
 * 2. else a configured axis whose `unit` equals SeriesData.unit.
 * 3. else an auto axis per distinct unit (first unit left, second right; further units share
 *    the axis of the same side alternately). Configured axes that no series uses are still
 *    rendered if a threshold references them. Order: configured axes first, then auto axes.
 * With zero series data, returns a single unitless auto axis.
 */
export function assignAxes(cfg: NormalizedConfig, data: SeriesData[]): AxisAssignment {
  return notImplemented('assignAxes', cfg, data);
}

/**
 * Pure: config + loaded data + theme -> full ECharts option (used with `notMerge: true` on
 * config/theme change, `lazyUpdate` for live redraws).
 *
 * Behavior contract:
 * - xAxis `type: 'time'`, min `now - spanMs`, max `now`; labels via makeTimeFormatter(ctx.hass).axis;
 *   hidden when !cfg.show.xAxis. Grid lines use theme.divider; text uses theme.secondaryText.
 * - yAxes from assignAxes; min/max/softMin/softMax honored; labels via formatValue (unit shown
 *   once per axis); hidden when !cfg.show.yAxis or axis.show false.
 * - One `type: 'line'` series per SeriesData, `id: series.key`, `name: data.name`,
 *   `data: points` (history series additionally get a synthetic trailing `[now, lastValue]`
 *   so sample-and-hold lines reach the right edge), `connectNulls: false`,
 *   `showSymbol: cfg.show.points`, `sampling: 'lttb'` when points.length > 1000,
 *   `animation: false` for > 2000 total points; `step` = line.step, `'auto'` -> `'end'` when
 *   isBinary else false; `smooth` = line.smooth (0 -> false; forced off when stepped);
 *   lineStyle width/type from NormalizedLine; color via ctx.resolveColor.
 * - fill: gradient -> LinearGradient color @ fillOpacity -> 0 towards the axis; solid ->
 *   areaStyle opacity fillOpacity; none -> no areaStyle.
 * - colorThresholds -> one piecewise visualMap per such series (`seriesIndex`, `dimension: 1`,
 *   `show: false`), pieces per ColorThreshold semantics.
 * - thresholds -> markLine (kind line) / markArea (kind area) attached to the first series on
 *   the threshold's axis (`silent: true`), color default theme.secondaryText.
 * - tooltip (when cfg.show.tooltip): `trigger: 'axis'`, `appendToBody: true`, theme tooltip
 *   colors, header via TimeFormatter.tooltip, rows `● name  formatValue(v, unit, precision)`.
 * - legend (when cfg.show.legend) at bottom; `selected` from ctx.hiddenKeys.
 * - dataZoom `type: 'inside'` on xAxis when cfg.show.zoom (`zoomOnMouseWheel: 'ctrl'`).
 * - textStyle.fontFamily = theme.fontFamily; backgroundColor transparent; compact grid
 *   (containLabel) so a minimal config looks good at 220px.
 */
export function buildOptions(cfg: NormalizedConfig, data: SeriesData[], theme: ThemeColors, ctx: BuildContext): EChartsCoreOption {
  return notImplemented('buildOptions', cfg, data, theme, ctx);
}
