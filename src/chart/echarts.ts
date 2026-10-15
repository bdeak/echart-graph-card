/**
 * Tree-shaken ECharts build: only what a time-series line card needs.
 * Import `echarts` from here (never from 'echarts' directly) so the bundle stays small.
 *
 * Registered: LineChart, BarChart (`type: bar` series), Grid (value/time axes), Tooltip (+ AxisPointer), Legend (plain +
 * scroll), DataZoom *inside* only (no slider), MarkLine, MarkArea, MarkPoint (show.extrema),
 * VisualMap *piecewise* only (use piecewise pieces for color_thresholds), CanvasRenderer.
 * Deliberately NOT registered (bundle cost): DataZoom slider, continuous VisualMap,
 * SVG renderer, Dataset, Title, Toolbox. Using an option for an unregistered component is
 * silently ignored by ECharts, so extend `use([...])` here if one is ever needed.
 *
 * Named imports (not `import * as`) keep unused echarts/core exports out of the bundle.
 * Measured (Vite 8/rolldown, minified): ~600 kB / ~200 kB gzip for echarts alone.
 */
import { dispose, getInstanceByDom, graphic, init, use } from 'echarts/core';
import type { ComposeOption, ECharts, EChartsCoreOption, SetOptionOpts } from 'echarts/core';
import { BarChart, LineChart } from 'echarts/charts';
import type { BarSeriesOption, LineSeriesOption } from 'echarts/charts';
import {
  DataZoomInsideComponent,
  GridComponent,
  LegendComponent,
  MarkAreaComponent,
  MarkLineComponent,
  MarkPointComponent,
  TooltipComponent,
  VisualMapPiecewiseComponent,
} from 'echarts/components';
import type {
  DataZoomComponentOption,
  GridComponentOption,
  LegendComponentOption,
  MarkAreaComponentOption,
  MarkLineComponentOption,
  MarkPointComponentOption,
  TooltipComponentOption,
  VisualMapComponentOption,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

use([
  LineChart,
  BarChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomInsideComponent,
  MarkLineComponent,
  MarkAreaComponent,
  MarkPointComponent,
  VisualMapPiecewiseComponent,
  CanvasRenderer,
]);

/** Type-safe option composed from exactly the registered parts (assignable to EChartsCoreOption). */
export type ECOption = ComposeOption<
  | LineSeriesOption
  | BarSeriesOption
  | GridComponentOption
  | TooltipComponentOption
  | LegendComponentOption
  | DataZoomComponentOption
  | MarkLineComponentOption
  | MarkAreaComponentOption
  | MarkPointComponentOption
  | VisualMapComponentOption
>;

export type EChartsInstance = ECharts;
export type { BarSeriesOption, EChartsCoreOption, LineSeriesOption, SetOptionOpts };

/** The registered ECharts runtime API used by the card. */
export const echarts = { init, dispose, getInstanceByDom, graphic } as const;
