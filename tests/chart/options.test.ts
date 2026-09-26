/* eslint-disable @typescript-eslint/no-explicit-any -- tests probe the loosely typed ECharts option tree */
import { describe, expect, it } from 'vitest';
import { normalizeConfig, DAY, HOUR, MINUTE } from '../../src/config';
import { assignAxes, buildOptions, legendNames, valueAt, BINARY_AXIS_ID, THRESHOLD_SERIES_PREFIX } from '../../src/chart/options';
import type { BuildContext } from '../../src/chart/options';
import { browserTimeZone, makeTimeFormatter } from '../../src/chart/format';
import { DEFAULT_PALETTE, FALLBACK_THEME } from '../../src/chart/theme';
import type { CardConfig, HassLocale, HomeAssistant, NormalizedConfig, Point, SeriesConfig, SeriesData } from '../../src/types';

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const NOW = Date.UTC(2026, 8, 26, 12, 0, 0);
const THEME = FALLBACK_THEME.light;

function mockHass(locale: Partial<HassLocale> = {}, serverTz = 'Europe/Berlin', extra: Partial<HomeAssistant> = {}): HomeAssistant {
  return {
    states: {},
    callWS: async () => ({}) as never,
    connection: { subscribeMessage: async () => async () => undefined },
    locale: { language: 'en', time_zone: 'local', number_format: 'language', time_format: '24', ...locale },
    config: { time_zone: serverTz },
    themes: { darkMode: false },
    ...extra,
  };
}

function cfgOf(partial: Omit<CardConfig, 'type'>): NormalizedConfig {
  return normalizeConfig({ type: 'custom:echart-graph-card', ...partial });
}

/** `n` points evenly spread over the last 24h ending 5 minutes before NOW. */
function series(n: number, f: (i: number) => number | null, spanMs = DAY): Point[] {
  const start = NOW - spanMs;
  const step = (spanMs - 5 * MINUTE) / Math.max(1, n - 1);
  return Array.from({ length: n }, (_, i) => [Math.round(start + i * step), f(i)] as Point);
}

function dataFor(cfg: NormalizedConfig, per: Array<Partial<SeriesData>>): SeriesData[] {
  return cfg.series.map((s, i) => ({
    series: s,
    points: [],
    name: s.name ?? s.entity,
    isBinary: false,
    source: 'history' as const,
    ...per[i],
  }));
}

function build(cfg: NormalizedConfig, data: SeriesData[], ctx: Partial<BuildContext> = {}): Record<string, any> {
  return buildOptions(cfg, data, THEME, { hass: mockHass(), now: NOW, ...ctx }) as Record<string, any>;
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

describe('buildOptions: single temperature series (minimal config)', () => {
  const cfg = cfgOf({ series: ['sensor.living_room_temperature'] });
  const pts = series(50, (i) => 20 + Math.sin(i / 5));
  const data = dataFor(cfg, [{ points: pts, unit: '°C', name: 'Living room' }]);
  const opt = build(cfg, data);
  const s = opt.series[0];

  it('produces one smooth line series without symbols and with a gradient fill', () => {
    expect(opt.series).toHaveLength(1);
    expect(s).toMatchObject({
      type: 'line',
      id: '0:sensor.living_room_temperature',
      name: 'Living room',
      color: DEFAULT_PALETTE[0],
      showSymbol: false,
      connectNulls: false,
      step: false,
      smooth: 0.35,
      smoothMonotone: 'x',
      yAxisIndex: 0,
      lineStyle: { width: 2, type: 'solid' },
    });
    expect(s.sampling).toBeUndefined();
    expect(s.areaStyle.opacity).toBe(0.35);
    const g = s.areaStyle.color;
    expect(g).toMatchObject({ type: 'linear', x: 0, y: 0, x2: 0, y2: 1 });
    expect(g.colorStops[0]).toEqual({ offset: 0, color: DEFAULT_PALETTE[0] });
    expect(g.colorStops[1].offset).toBe(1);
    expect(g.colorStops[1].color).toMatch(/rgba\(\d+, \d+, \d+, 0\)/);
  });

  it('extends history lines to now with the last value (sample-and-hold)', () => {
    expect(s.data).toHaveLength(pts.length + 1);
    expect(s.data[s.data.length - 1]).toEqual([NOW, pts[pts.length - 1][1]]);
    expect(data[0].points).toHaveLength(50); // input untouched
  });

  it('spans the x axis over the configured window with subtle styling', () => {
    expect(opt.xAxis).toMatchObject({ type: 'time', min: NOW - DAY, max: NOW, show: true });
    expect(opt.xAxis.axisLine.show).toBe(false);
    expect(opt.xAxis.splitLine.show).toBe(false);
    expect(opt.xAxis.axisLabel.color).toBe(THEME.secondaryText);
    expect(opt.xAxis.axisLabel.customValues).toBeUndefined();
    const tf = makeTimeFormatter(mockHass());
    const tick = NOW - 2 * HOUR;
    expect(opt.xAxis.axisLabel.formatter(tick)).toBe(tf.time(tick));
  });

  it('fits the y axis to the data with dashed divider split lines and unit labels', () => {
    expect(opt.yAxis).toHaveLength(1);
    expect(opt.yAxis[0]).toMatchObject({ type: 'value', scale: true, show: true, position: 'left', id: 'unit:°C' });
    expect(opt.yAxis[0].axisLine.show).toBe(false);
    expect(opt.yAxis[0].splitLine).toMatchObject({ show: true, lineStyle: { color: THEME.divider, type: [3, 3] } });
    expect(opt.yAxis[0].axisLabel.formatter(21.5)).toBe('21.5 °C');
    // Every label of the axis gets the decimals of the tick interval (data spans ~2 °C -> 0.5 steps).
    expect(opt.yAxis[0].axisLabel.formatter(20)).toBe('20.0 °C');
  });

  it('uses an axis tooltip appended to the body with theme colors', () => {
    expect(opt.tooltip).toMatchObject({
      show: true,
      trigger: 'axis',
      appendTo: 'body',
      backgroundColor: THEME.tooltipBackground,
      borderColor: THEME.tooltipBorder,
    });
    expect(opt.tooltip.axisPointer).toMatchObject({ type: 'line', label: { show: false } });
    expect(typeof opt.tooltip.formatter).toBe('function');
  });

  it('keeps a hidden legend (header chips act as legend), transparent bg, short animation', () => {
    expect(opt.legend).toMatchObject({ show: false, icon: 'roundRect', data: ['Living room'], selected: { 'Living room': true } });
    expect(opt.backgroundColor).toBe('transparent');
    expect(opt.textStyle.fontFamily).toBe(THEME.fontFamily);
    expect(opt.animation).toBe(true);
    expect(opt.animationDuration).toBe(300);
    expect(opt.grid).toMatchObject({ outerBoundsMode: 'same', outerBoundsContain: 'all' });
    expect(opt.dataZoom).toBeUndefined();
    expect(opt.visualMap).toBeUndefined();
  });
});

describe('buildOptions: tooltip formatter', () => {
  it('renders a time header in the HA zone and one escaped row per visible series', () => {
    const cfg = cfgOf({
      series: [{ entity: 'sensor.t', name: 'Kitchen <b>' }, { entity: 'sensor.h', precision: 0 }, { entity: 'sensor.x', hidden: true }],
    });
    const data = dataFor(cfg, [
      { points: series(10, () => 21.53), unit: '°C', name: 'Kitchen <b>' },
      { points: series(7, () => 48.6), unit: '%', name: 'Humidity' },
      { points: series(7, () => 5), unit: 'W', name: 'Hidden' },
    ]);
    const hass = mockHass({ time_zone: 'server', language: 'en-GB' }, 'Europe/Berlin');
    const opt = build(cfg, data, { hass });
    // ECharts only passes the series nearest to the cursor; the formatter must still list all.
    const html: string = opt.tooltip.formatter([{ seriesId: '0:sensor.t', value: [NOW, 21.53], axisValue: NOW }]);
    expect(html).toContain('14:00'); // 12:00 UTC in Berlin (CEST)
    expect(html).toContain('Kitchen &lt;b&gt;');
    expect(html).not.toContain('<b>');
    expect(html).toContain('21.5 °C');
    expect(html).toContain('49%');
    expect(html).not.toContain('Hidden');
    expect(html).toContain(`background:${DEFAULT_PALETTE[0]}`);
    expect(opt.tooltip.formatter([])).toBe('');
    expect(opt.tooltip.axisPointer.snap).toBe(true);
  });

  it('looks values up sample-and-hold, with gaps as a dash and nothing before the first point', () => {
    const cfg = cfgOf({ series: ['sensor.p'] });
    const pts: Point[] = [
      [NOW - 3 * HOUR, 1234.5],
      [NOW - 2 * HOUR, null],
      [NOW - HOUR, 10],
    ];
    const hass = mockHass({}, 'UTC', { entities: { 'sensor.p': { entity_id: 'sensor.p', display_precision: 2 } } });
    const opt = build(cfg, dataFor(cfg, [{ points: pts, unit: 'W' }]), { hass });
    const at = (t: number): string => opt.tooltip.formatter([{ axisValue: t }]);
    expect(at(NOW - 150 * MINUTE)).toContain('1,234.50 W');
    expect(at(NOW - 90 * MINUTE)).toContain('—');
    expect(at(NOW - 30 * MINUTE)).toContain('10.00 W');
    expect(at(NOW - 4 * HOUR)).toBe('');
  });

  it('only shows statistics rows inside their bucket and colors dots by color_thresholds', () => {
    const cfg = cfgOf({
      span: '7d',
      series: [{ entity: 'sensor.co2', color_thresholds: [{ value: 0, color: '#00ff00' }, { value: 1000, color: '#ff0000' }] }],
    });
    const pts: Point[] = [
      [NOW - 3 * HOUR, 800],
      [NOW - 2 * HOUR, 1200],
    ];
    const opt = build(cfg, dataFor(cfg, [{ points: pts, source: 'statistics', unit: 'ppm' }]));
    expect(cfg.statisticsPeriod).toBe('hour');
    const at = (t: number): string => opt.tooltip.formatter([{ axisValue: t }]);
    expect(at(NOW - 3 * HOUR)).toContain('background:#00ff00');
    expect(at(NOW - 2 * HOUR + 30 * MINUTE)).toContain('background:#ff0000');
    expect(at(NOW - 30 * MINUTE)).toBe(''); // past the last bucket
    expect(at(NOW - 3 * HOUR)).not.toMatch(/\d:\d\d:\d\d/); // no seconds for hourly data
  });
});

describe('valueAt', () => {
  const pts: Point[] = [
    [100, 1],
    [200, null],
    [300, 3],
  ];
  it('returns the last value at or before t', () => {
    expect(valueAt(pts, 99)).toBeUndefined();
    expect(valueAt(pts, 100)).toBe(1);
    expect(valueAt(pts, 250)).toBeNull();
    expect(valueAt(pts, 1e9)).toBe(3);
    expect(valueAt(pts, 350, 40)).toBeUndefined();
    expect(valueAt([], 5)).toBeUndefined();
  });
});

describe('buildOptions: dual axis power + battery SoC', () => {
  const cfg = cfgOf({
    y_axes: [
      { id: 'power', unit: 'W', soft_min: -3000, soft_max: 5000 },
      { id: 'soc', unit: '%', min: 0, max: 100, position: 'right' },
    ],
    series: [
      { entity: 'sensor.grid_power', name: 'Grid' },
      { entity: 'sensor.battery_soc', name: 'SoC' },
    ],
  });
  const data = dataFor(cfg, [
    { points: series(100, (i) => Math.sin(i / 10) * 1500), unit: 'W', name: 'Grid' },
    { points: series(100, (i) => 40 + i / 5), unit: '%', name: 'SoC' },
  ]);
  const opt = build(cfg, data);

  it('maps series to configured axes by unit', () => {
    expect(opt.yAxis.map((a: any) => [a.id, a.position])).toEqual([
      ['power', 'left'],
      ['soc', 'right'],
    ]);
    expect(opt.series[0].yAxisIndex).toBe(0);
    expect(opt.series[1].yAxisIndex).toBe(1);
  });

  it('draws split lines only on the first axis; fixed axes get an even interval', () => {
    expect(opt.yAxis[0].splitLine.show).toBe(true);
    expect(opt.yAxis[1].splitLine.show).toBe(false);
    expect(opt.yAxis[1].alignTicks).toBeUndefined(); // min+max fixed
    expect(opt.yAxis[1]).toMatchObject({ min: 0, max: 100, interval: 25 }); // power axis is not fixed -> own split
    expect(opt.yAxis[1].axisLabel.formatter(50)).toBe('50%');
    expect(opt.yAxis[0].axisLabel.formatter(-1500)).toBe('-1,500 W');
  });

  it('applies soft bounds while the data stays inside them, auto beyond', () => {
    expect(opt.yAxis[0]).toMatchObject({ min: -3000, max: 5000 });
    expect(opt.yAxis[0].interval).toBeUndefined(); // no nice step lands on both -3000 and 5000
    const beyond = dataFor(cfg, [
      { points: series(10, (i) => i * 700), unit: 'W', name: 'Grid' },
      { points: series(10, () => 50), unit: '%', name: 'SoC' },
    ]);
    const o = build(cfg, beyond);
    expect(o.yAxis[0].min).toBe(-3000);
    expect(o.yAxis[0].max).toBeUndefined();
    expect(o.yAxis[0].alignTicks).toBeUndefined(); // split owner
    const symmetric = cfgOf({ y_axes: [{ id: 'p', unit: 'W', soft_min: -3000, soft_max: 3000 }], series: ['sensor.p'] });
    const s = build(symmetric, dataFor(symmetric, [{ points: series(10, () => 100), unit: 'W' }]));
    expect(s.yAxis[0]).toMatchObject({ min: -3000, max: 3000, interval: 1000 });
  });

  it('shares one split count between fully fixed axes so labels sit on the same grid lines', () => {
    const mk = (softMin: number, softMax: number): Record<string, any> => {
      const c = cfgOf({
        y_axes: [
          { id: 'p', unit: 'W', soft_min: softMin, soft_max: softMax },
          { id: 'soc', unit: '%', min: 0, max: 100 },
        ],
        series: ['sensor.p', 'sensor.soc'],
      });
      return build(c, dataFor(c, [{ points: series(10, () => 100), unit: 'W' }, { points: series(10, () => 50), unit: '%' }]));
    };
    const shared = mk(0, 5000);
    expect(shared.yAxis[0]).toMatchObject({ min: 0, max: 5000, interval: 1000 });
    expect(shared.yAxis[1]).toMatchObject({ min: 0, max: 100, interval: 20 });
    // No common split count near the target (4 at 220px): each axis keeps its own even interval.
    const own = mk(-3000, 3000);
    expect(own.yAxis[0].interval).toBe(1000);
    expect(own.yAxis[1].interval).toBe(25);
  });

  it('fits an auto owner axis to a fixed secondary so every label sits on a grid line', () => {
    const c = cfgOf({
      y_axes: [
        { id: 'p', unit: 'W' },
        { id: 'soc', unit: '%', min: 0, max: 100, position: 'right' },
      ],
      series: ['sensor.p', 'sensor.soc'],
    });
    const o = build(c, dataFor(c, [{ points: series(10, (i) => -1700 + i * 500), unit: 'W' }, { points: series(10, () => 50), unit: '%' }]));
    // -1700..2800 W -> -2000..3000 in 1000 W steps (5 segments); 0..100 % in 20 % steps matches.
    expect(o.yAxis[0]).toMatchObject({ min: -2000, max: 3000, interval: 1000 });
    expect(o.yAxis[1]).toMatchObject({ min: 0, max: 100, interval: 20 });
    expect(o.yAxis[1].alignTicks).toBeUndefined();
    expect(o.yAxis[1].axisLabel.formatter(40)).toBe('40%');
  });

  it('aligns an auto secondary axis to the grid owner', () => {
    const c = cfgOf({ series: ['sensor.p', 'sensor.t'] });
    const o = build(c, dataFor(c, [{ points: series(10, (i) => i * 300), unit: 'W' }, { points: series(10, (i) => 20 + i / 4), unit: '°C' }]));
    expect(o.yAxis[0].alignTicks).toBeUndefined();
    expect(o.yAxis[1]).toMatchObject({ alignTicks: true, position: 'right' });
  });

  it('ignores hidden series when resolving soft bounds', () => {
    const c = cfgOf({
      y_axes: [{ id: 'p', unit: 'W', soft_max: 1000 }],
      series: [{ entity: 'sensor.a' }, { entity: 'sensor.b', hidden: true }],
    });
    const d = dataFor(c, [
      { points: series(5, () => 500), unit: 'W' },
      { points: series(5, () => 9000), unit: 'W' },
    ]);
    expect(build(c, d).yAxis[0].max).toBe(1000);
    expect(build(c, d, { hiddenKeys: new Set() }).yAxis[0].max).toBeUndefined();
  });

  it('fades mixed-sign gradients towards the zero line', () => {
    const stops = opt.series[0].areaStyle.color.colorStops;
    expect(stops).toHaveLength(3);
    expect(stops[1].offset).toBeCloseTo(0.5, 1);
    expect(stops[1].color).toMatch(/, 0\)$/);
  });

  it('creates auto axes per unit when no y_axes are configured (left, right, then offset)', () => {
    const c = cfgOf({ series: ['sensor.a', 'sensor.b', 'sensor.c', 'sensor.d'] });
    const d = dataFor(c, [{ unit: 'W' }, { unit: '%' }, { unit: '°C' }, { unit: 'W' }]);
    const { axes, seriesAxis } = assignAxes(c, d);
    expect(axes.map((a) => [a.id, a.position, a.auto])).toEqual([
      ['unit:W', 'left', true],
      ['unit:%', 'right', true],
      ['unit:°C', 'left', true],
    ]);
    expect(seriesAxis).toEqual([0, 1, 2, 0]);
    const o = build(c, d);
    expect(o.yAxis.map((a: any) => a.offset)).toEqual([0, 0, 52]);
    expect(o.yAxis[1].alignTicks).toBe(true);
    expect(o.yAxis[2].alignTicks).toBe(true);
  });

  it('returns a single unitless axis when there is no data', () => {
    const c = cfgOf({ series: ['sensor.a'] });
    expect(assignAxes(c, []).axes).toEqual([{ id: 'unit:', position: 'left', auto: true }]);
    const o = build(c, []);
    expect(o.series).toEqual([]);
    expect(o.yAxis).toHaveLength(1);
  });
});

describe('buildOptions: binary step series', () => {
  const cfg = cfgOf({ series: ['sensor.indoor_temperature', 'binary_sensor.heating'] });
  const data = dataFor(cfg, [
    { points: series(20, (i) => 20 + i / 10), unit: '°C', name: 'Indoor' },
    { points: series(20, (i) => (i % 4 < 2 ? 1 : 0)), isBinary: true, name: 'Heating' },
  ]);
  const opt = build(cfg, data);
  const b = opt.series[1];

  it('renders binary series as end-stepped, non-smooth lines on a hidden 0..1 axis', () => {
    expect(b).toMatchObject({ step: 'end', smooth: false, lineStyle: { width: 1.5 } });
    expect(opt.yAxis).toHaveLength(2);
    expect(opt.yAxis[b.yAxisIndex]).toMatchObject({ id: BINARY_AXIS_ID, show: false, min: 0, max: 1 });
    expect(opt.series[0].yAxisIndex).toBe(0);
    expect(opt.yAxis[0].splitLine.show).toBe(true);
  });

  it('draws binary series next to real values as light flat bands', () => {
    expect(b.lineStyle.opacity).toBe(0.75);
    expect(b.areaStyle.color).toBe(DEFAULT_PALETTE[1]);
    expect(b.areaStyle.opacity).toBeCloseTo(0.1575);
    expect(opt.series[0].lineStyle.opacity).toBeUndefined();
    expect(opt.series[0].areaStyle.color.type).toBe('linear');
  });

  it('never samples stepped series and extends them to now', () => {
    const many = dataFor(cfg, [
      { points: series(5, () => 20), unit: '°C' },
      { points: series(3000, (i) => i % 2), isBinary: true },
    ]);
    const o = build(cfg, many);
    expect(o.series[1].sampling).toBeUndefined();
    expect(o.series[1].data[o.series[1].data.length - 1][0]).toBe(NOW);
    expect(o.animation).toBe(false); // > 2000 points
  });

  it('shows On/Off in the tooltip', () => {
    const onAt = data[1].points[0][0]; // value 1
    const offAt = data[1].points[2][0]; // value 0
    expect(opt.tooltip.formatter([{ axisValue: onAt }])).toContain('>On<');
    expect(opt.tooltip.formatter([{ axisValue: offAt }])).toContain('>Off<');
    const localized = build(cfg, data, {
      hass: { ...mockHass(), localize: (k: string) => (k.endsWith('.on') ? 'An' : 'Aus') } as unknown as HomeAssistant,
    });
    expect(localized.tooltip.formatter([{ axisValue: offAt }])).toContain('>Aus<');
  });

  it('uses the entity\'s translated states when hass.formatEntityState exists', () => {
    const door = cfgOf({ series: ['binary_sensor.door'] });
    const st = { entity_id: 'binary_sensor.door', state: 'off', attributes: { device_class: 'door' }, last_changed: '', last_updated: '' };
    const hass = {
      ...mockHass(),
      states: { 'binary_sensor.door': st },
      formatEntityState: (_s: unknown, state?: string) => (state === 'on' ? 'Open' : 'Closed'),
    } as unknown as HomeAssistant;
    const pts = series(4, (i) => i % 2);
    const o = build(door, dataFor(door, [{ points: pts, isBinary: true }]), { hass });
    expect(o.tooltip.formatter([{ axisValue: pts[1][0] }])).toContain('>Open<');
    expect(o.tooltip.formatter([{ axisValue: pts[0][0] }])).toContain('>Closed<');
  });

  it('honours an explicit step and smoothing off', () => {
    const c = cfgOf({ series: [{ entity: 'sensor.price', line: { step: true } }, { entity: 'sensor.x', line: { smooth: false } }] });
    const o = build(c, dataFor(c, [{ points: series(5, () => 1) }, { points: series(5, () => 1) }]));
    expect(o.series[0]).toMatchObject({ step: 'end', smooth: false });
    expect(o.series[1]).toMatchObject({ step: false, smooth: false });
  });
});

describe('buildOptions: thresholds', () => {
  const cfg = cfgOf({
    y_axes: [{ id: 'power', unit: 'W' }, { id: 'limit' }],
    thresholds: [
      { value: 0, label: 'zero' },
      { from: 20, to: 25, color: '#ff0000' },
      { from: 3000, y_axis: 'limit' },
    ],
    series: [{ entity: 'sensor.grid', y_axis: 'power' }],
  });
  const data = dataFor(cfg, [{ points: series(10, () => 100), unit: 'W', name: 'Grid' }]);
  const opt = build(cfg, data);

  it('renders a configured axis referenced only by a threshold', () => {
    expect(opt.yAxis.map((a: any) => a.id)).toEqual(['power', 'limit']);
  });

  it('puts markLine/markArea on invisible carrier series (after data series, not in the legend)', () => {
    expect(opt.series).toHaveLength(3);
    const [power, limit] = opt.series.slice(1);
    // Invisible points at the threshold extent (0 .. 25) make the auto axis include them.
    expect(power).toMatchObject({
      id: `${THRESHOLD_SERIES_PREFIX}power`,
      data: [
        [NOW - DAY, 0],
        [NOW - DAY, 25],
      ],
      yAxisIndex: 0,
      silent: true,
      tooltip: { show: false },
      showSymbol: false,
      lineStyle: { opacity: 0 },
    });
    expect(limit.data).toEqual([]); // open-ended bands do not stretch the axis
    expect(limit).toMatchObject({ id: `${THRESHOLD_SERIES_PREFIX}limit`, yAxisIndex: 1 });
    expect(opt.legend.data).toEqual(['Grid']);

    const line = power.markLine;
    expect(line.silent).toBe(true);
    expect(line.symbol).toEqual(['none', 'none']);
    expect(line.data).toHaveLength(1);
    expect(line.data[0]).toMatchObject({ yAxis: 0, lineStyle: { color: THEME.secondaryText, type: 'dashed', width: 1, opacity: 0.8 } });
    expect(line.data[0].label.show).toBe(true);
    expect(line.data[0].label.formatter()).toBe('zero');

    const area = power.markArea.data[0];
    expect(area[0]).toMatchObject({ yAxis: 20, itemStyle: { color: '#ff0000', opacity: 0.12 } });
    expect(area[1]).toEqual({ yAxis: 25 });
    expect(area[0].label.show).toBe(false);

    const open = limit.markArea.data[0];
    expect(open[0].yAxis).toBe(3000);
    expect(open[1]).toEqual({}); // open-ended band -> axis max
  });
});

describe('buildOptions: color_thresholds', () => {
  it('adds a hidden piecewise visualMap per series and lets the line inherit it', () => {
    const cfg = cfgOf({
      series: [
        { entity: 'sensor.plain' },
        {
          entity: 'sensor.co2',
          fill: 'gradient',
          color_thresholds: [
            { value: 1000, color: '#ff9800' },
            { value: 0, color: '#4caf50' },
            { value: 1500, color: '#f44336' },
          ],
        },
      ],
    });
    const data = dataFor(cfg, [{ points: series(10, () => 1) }, { points: series(10, (i) => 400 + i * 150), unit: 'ppm' }]);
    const opt = build(cfg, data);
    expect(opt.visualMap).toEqual([
      {
        type: 'piecewise',
        show: false,
        seriesIndex: 1,
        dimension: 1,
        pieces: [
          { lt: 1000, color: '#4caf50' },
          { gte: 1000, lt: 1500, color: '#ff9800' },
          { gte: 1500, color: '#f44336' },
        ],
        outOfRange: { color: DEFAULT_PALETTE[1] },
      },
    ]);
    const s = opt.series[1];
    expect(s.lineStyle.color).toBeUndefined();
    expect(s.areaStyle.color).toBeUndefined(); // area takes the visualMap colors
    expect(s.areaStyle.opacity).toBeCloseTo(0.21);
  });

  it('uses a single stop as the plain line color', () => {
    const cfg = cfgOf({ series: [{ entity: 'sensor.a', color_thresholds: [{ value: 5, color: '#123456' }] }] });
    const opt = build(cfg, dataFor(cfg, [{ points: series(5, () => 1) }]));
    expect(opt.visualMap).toBeUndefined();
    expect(opt.series[0].color).toBe('#123456');
  });
});

describe('buildOptions: hidden series, legend, colors', () => {
  const raw: SeriesConfig[] = [
    { entity: 'sensor.a', name: 'Same' },
    { entity: 'sensor.b', name: 'Same', hidden: true, color: 'var(--accent)' },
    { entity: 'sensor.c', fill: 'solid' },
  ];
  const cfg = cfgOf({ show: { legend: true }, series: raw });
  const data = dataFor(cfg, [{ name: 'Same' }, { name: 'Same' }, { name: 'C' }].map((d) => ({ ...d, points: series(5, () => 1) })));

  it('makes names unique and hides `hidden: true` series via legend.selected', () => {
    const opt = build(cfg, data);
    expect(opt.series.map((s: any) => s.name)).toEqual(['Same', 'Same (2)', 'C']);
    expect(opt.legend).toMatchObject({ show: true, bottom: 2, icon: 'roundRect', data: ['Same', 'Same (2)', 'C'] });
    expect(opt.legend.selected).toEqual({ Same: true, 'Same (2)': false, C: true });
    expect(legendNames(data)).toEqual(['Same', 'Same (2)', 'C']);
    expect(opt.grid.bottom).toBeGreaterThanOrEqual(30);
  });

  it('lets ctx.hiddenKeys override the configured hidden flags', () => {
    const opt = build(cfg, data, { hiddenKeys: new Set(['0:sensor.a']) });
    expect(opt.legend.selected).toEqual({ Same: false, 'Same (2)': true, C: true });
  });

  it('resolves colors through ctx.resolveColor and supports solid fills', () => {
    const opt = build(cfg, data, { resolveColor: (c) => (c === 'var(--accent)' ? '#abcdef' : c) });
    expect(opt.series[1].color).toBe('#abcdef');
    expect(opt.series[2].areaStyle).toEqual({ opacity: 0.2, color: DEFAULT_PALETTE[2] });
    expect(opt.series[0].areaStyle).toBeUndefined(); // 3 series -> fill none by default
  });
});

describe('buildOptions: toggles', () => {
  const pts = series(1500, (i) => Math.sin(i / 50) * 10);

  it('uses lttb sampling above 1000 points and respects ctx.animate', () => {
    const cfg = cfgOf({ series: ['sensor.a'] });
    const opt = build(cfg, dataFor(cfg, [{ points: pts }]), { animate: false });
    expect(opt.series[0].sampling).toBe('lttb');
    expect(opt.animation).toBe(false);
  });

  it('show.points / zoom / extrema / tooltip / axes', () => {
    const cfg = cfgOf({
      show: { points: true, zoom: true, extrema: true, tooltip: false, x_axis: false, y_axis: false },
      series: ['sensor.a'],
    });
    const opt = build(cfg, dataFor(cfg, [{ points: series(20, (i) => i), unit: 'W' }]));
    expect(opt.series[0].showSymbol).toBe(true);
    expect(opt.dataZoom).toEqual([expect.objectContaining({ type: 'inside', xAxisIndex: 0, filterMode: 'none', zoomOnMouseWheel: 'ctrl' })]);
    // The header shows min / max / avg; chart markers only replace it when the header is off.
    expect(opt.series[0].markPoint).toBeUndefined();
    const noHeader = cfgOf({ show: { extrema: true, header_states: false }, series: ['sensor.a'] });
    const mp = build(noHeader, dataFor(noHeader, [{ points: series(20, (i) => i), unit: 'W' }])).series[0].markPoint;
    expect(mp.data.map((d: any) => d.type)).toEqual(['max', 'min']);
    expect(mp.data[0].label.formatter({ value: 1234 })).toBe('1,234 W');
    expect(opt.tooltip).toEqual({ show: false });
    expect(opt.xAxis.show).toBe(false);
    expect(opt.yAxis[0].show).toBe(false);
    expect(opt.grid).toMatchObject({ left: 0, right: 0, bottom: 0 }); // sparkline: full bleed
  });

  it('extends a stepped statistics series to the end of its last bucket (not past now)', () => {
    const cfg = cfgOf({ span: '48h', data_source: 'statistics', statistics_period: 'hour', series: [{ entity: 'sensor.water', line: { step: true } }] });
    const rows: Point[] = [
      [NOW - 3 * HOUR, 10],
      [NOW - 2 * HOUR, 20],
    ];
    const opt = build(cfg, dataFor(cfg, [{ points: rows, source: 'statistics', unit: 'L' }]));
    expect(opt.series[0].data).toEqual([...rows, [NOW - HOUR, 20]]);
    // The tooltip still treats the last row as one bucket: nothing after its end.
    expect(opt.tooltip.formatter([{ axisValue: NOW - 90 * MINUTE }])).toContain('20 L');
    expect(opt.tooltip.formatter([{ axisValue: NOW - 30 * MINUTE }])).toBe('');
    const open = build(cfg, dataFor(cfg, [{ points: [[NOW - 30 * MINUTE, 5]], source: 'statistics', unit: 'L' }]));
    expect(open.series[0].data).toEqual([
      [NOW - 30 * MINUTE, 5],
      [NOW, 5],
    ]);
  });

  it('keeps statistics series unextended', () => {
    const cfg = cfgOf({ span: '7d', series: ['sensor.energy'] });
    const pts7 = series(10, (i) => i, 7 * DAY);
    const opt = build(cfg, dataFor(cfg, [{ points: pts7, source: 'statistics', unit: 'kWh' }]));
    expect(opt.series[0].data).toHaveLength(10);
    expect(opt.xAxis.min).toBe(NOW - 7 * DAY);
  });
});

describe('buildOptions: time zones', () => {
  const OTHER_TZ = browserTimeZone() === 'Asia/Kolkata' ? 'America/St_Johns' : 'Asia/Kolkata';
  const cfg = cfgOf({ series: ['sensor.a'] });
  const data = dataFor(cfg, [{ points: series(10, () => 1) }]);

  it('computes zone-aligned ticks when the server zone differs from the browser', () => {
    const hass = mockHass({ time_zone: 'server' }, OTHER_TZ);
    const opt = build(cfg, data, { hass });
    const ticks: number[] = opt.xAxis.axisLabel.customValues;
    expect(Array.isArray(ticks)).toBe(true);
    expect(ticks.length).toBeGreaterThan(2);
    const tf = makeTimeFormatter(hass);
    for (const t of ticks) expect((t + tf.offset(t)) % HOUR).toBe(0);
    expect(opt.xAxis.axisTick.customValues).toEqual(ticks);
  });

  it('emphasises local midnight with rich text', () => {
    const hass = mockHass({ time_zone: 'server', language: 'en-GB' }, 'Europe/Berlin');
    const opt = build(cfg, data, { hass });
    const midnight = Date.UTC(2026, 8, 25, 22);
    expect(opt.xAxis.axisLabel.formatter(midnight)).toBe('{day|Sat}');
    expect(opt.xAxis.axisLabel.rich.day.color).toBe(THEME.text);
  });
});

// ---------------------------------------------------------------------------
// review fixes
// ---------------------------------------------------------------------------

describe('buildOptions: thresholds outside the data range', () => {
  it('extends the auto axis so reference lines and closed bands are drawn (real ECharts)', async () => {
    const echarts = await import('echarts');
    const cfg = cfgOf({ thresholds: [{ value: 25, label: 'Too warm' }, { from: 10, to: 12, label: 'Cold' }], series: ['sensor.t'] });
    const opt = build(cfg, dataFor(cfg, [{ points: series(50, (i) => 19 + (4 * i) / 49), unit: '°C' }]), { animate: false });
    const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width: 400, height: 220 });
    chart.setOption(opt as never);
    const extent = (chart as any).getModel().getComponent('yAxis', 0).axis.scale.getExtent();
    expect(extent[0]).toBeLessThanOrEqual(10);
    expect(extent[1]).toBeGreaterThanOrEqual(25);
    const svg = chart.renderToSVGString();
    expect(svg).toContain('Too warm');
    expect(svg).toContain('Cold');
    chart.dispose();
  });

  it('folds threshold values into soft bounds / label precision, but not open bands', () => {
    const cfg = cfgOf({
      y_axes: [{ id: 't', unit: '°C', soft_max: 24 }],
      thresholds: [{ value: 30 }, { from: 40 }],
      series: ['sensor.t'],
    });
    const opt = build(cfg, dataFor(cfg, [{ points: series(10, () => 20), unit: '°C' }]));
    // soft_max 24 no longer holds (30 is above it) -> auto; the carrier carries only 30.
    expect(opt.yAxis[0].max).toBeUndefined();
    expect(opt.series[1].data).toEqual([[NOW - DAY, 30]]);
  });

  it('draws band labels above the data lines on a subtle background', () => {
    const cfg = cfgOf({ thresholds: [{ from: 40, to: 60, color: '#10B981', label: 'Comfort' }], series: ['sensor.h'] });
    const opt = build(cfg, dataFor(cfg, [{ points: series(10, () => 50), unit: '%' }]));
    const [, area, labels] = opt.series;
    expect(area.markArea.data[0][0].label.show).toBe(false);
    expect(labels.id).toBe(`${THRESHOLD_SERIES_PREFIX}unit:%:labels`);
    expect(labels.markArea.z).toBeGreaterThan(opt.series[0].z);
    expect(labels.markArea.data[0][0]).toMatchObject({ yAxis: 40, itemStyle: { color: 'rgba(0, 0, 0, 0)' } });
    expect(labels.markArea.data[0][0].label).toMatchObject({ show: true, position: 'insideTopLeft', color: '#10B981' });
    expect(labels.markArea.data[0][0].label.backgroundColor).toMatch(/rgba\(255, 255, 255, 0\.75\)/);
    expect(labels.markArea.data[0][0].label.formatter()).toBe('Comfort');
    expect(opt.legend.data).toEqual(['sensor.h']);
  });
});

describe('buildOptions: binary labels per domain', () => {
  const fmt = (_s: unknown, state?: string): string => `<${state}>`;
  it.each([
    ['cover.garage', 'open', ['closed', 'open']],
    ['lock.front', 'locked', ['locked', 'unlocked']],
    ['person.bob', 'Work', ['not_home', 'home']],
    ['binary_sensor.door', 'on', ['off', 'on']],
  ])('%s uses its native states %j', (entity, state, [zero, one]) => {
    const cfg = cfgOf({ series: [entity] });
    const st = { entity_id: entity, state, attributes: {}, last_changed: '', last_updated: '' };
    const hass = { ...mockHass(), states: { [entity]: st }, formatEntityState: fmt } as unknown as HomeAssistant;
    const pts = series(4, (i) => i % 2);
    const o = build(cfg, dataFor(cfg, [{ points: pts, isBinary: true }]), { hass });
    expect(o.tooltip.formatter([{ axisValue: pts[0][0] }])).toContain(escape(`<${zero}>`));
    expect(o.tooltip.formatter([{ axisValue: pts[1][0] }])).toContain(escape(`<${one}>`));
  });

  it('falls back to domain translations, then humanized states', () => {
    const cfg = cfgOf({ series: ['cover.garage'] });
    const pts = series(4, (i) => i % 2);
    const localize = (k: string): string => (k === 'component.cover.entity_component._.state.open' ? 'Offen' : '');
    const o = build(cfg, dataFor(cfg, [{ points: pts, isBinary: true }]), { hass: { ...mockHass(), localize } as unknown as HomeAssistant });
    expect(o.tooltip.formatter([{ axisValue: pts[1][0] }])).toContain('>Offen<');
    expect(o.tooltip.formatter([{ axisValue: pts[0][0] }])).toContain('>Closed<');
  });

  const escape = (s: string): string => s.replace(/</g, '&lt;').replace(/>/g, '&gt;');
});

describe('buildOptions: statistics with group_by', () => {
  it('uses the group_by bucket (not the statistics period) for extension and tooltip', () => {
    const cfg = cfgOf({
      span: '10d',
      statistics_period: 'hour',
      series: [{ entity: 'sensor.water', statistic: 'change', group_by: { func: 'sum', duration: '1d' }, line: { step: true }, fill: 'solid' }],
    });
    const today = NOW - 12 * HOUR; // 00:00 UTC of the current day
    const rows: Point[] = [
      [today - DAY, 300],
      [today, 120],
    ];
    const opt = build(cfg, dataFor(cfg, [{ points: rows, source: 'statistics', unit: 'L' }]));
    // Today's bar reaches now (bucket = 1 day), not just 01:00.
    expect(opt.series[0].data[opt.series[0].data.length - 1]).toEqual([NOW, 120]);
    expect(opt.tooltip.formatter([{ axisValue: NOW - HOUR }])).toContain('120 L');
  });
});

describe('buildOptions: sparse sample-and-hold history', () => {
  it('holds the value across long gaps instead of drawing a ramp', () => {
    const cfg = cfgOf({ series: ['sensor.plug_power'] });
    const six = NOW - 6 * HOUR;
    const eleven = NOW - HOUR;
    const opt = build(cfg, dataFor(cfg, [{ points: [[six, 0], [eleven, 2000]], unit: 'W' }]));
    expect(opt.series[0].data).toEqual([
      [six, 0],
      [six + 1, 0],
      [eleven - 2, 0],
      [eleven - 1, 0],
      [eleven, 2000],
      [NOW, 2000],
    ]);
    // Tooltip half way reads the held value.
    expect(opt.tooltip.formatter([{ axisValue: NOW - 3.5 * HOUR }])).toContain('>0 W<');
  });

  it('keeps dense data, equal values, stepped and grouped series untouched', () => {
    const dense = series(500, (i) => Math.sin(i / 10));
    const cfg = cfgOf({ series: ['sensor.a', { entity: 'sensor.b', line: { step: true } }, { entity: 'sensor.c', group_by: '1h' }] });
    const sparse: Point[] = [
      [NOW - 6 * HOUR, 0],
      [NOW - HOUR, 5],
    ];
    const opt = build(cfg, dataFor(cfg, [{ points: dense }, { points: sparse }, { points: sparse }]));
    expect(opt.series[0].data).toHaveLength(dense.length + 1);
    expect(opt.series[1].data).toHaveLength(3);
    expect(opt.series[2].data).toHaveLength(3);
    const flat = build(cfgOf({ series: ['sensor.a'] }), dataFor(cfgOf({ series: ['sensor.a'] }), [{ points: [[NOW - 6 * HOUR, 1], [NOW - HOUR, 1]] }]));
    expect(flat.series[0].data).toHaveLength(3);
  });

  it('keeps small quantization steps smooth (only jumps of 10 % of the range are held)', () => {
    const cfg = cfgOf({ series: ['sensor.t'] });
    const pts: Point[] = [
      [NOW - 10 * HOUR, 20],
      [NOW - 8.5 * HOUR, 22], // big jump after a long gap -> held
      [NOW - 7 * HOUR, 21.9], // 0.1 step after 2 h -> ramp
      [NOW - 6 * HOUR, 21.8],
    ];
    const data = build(cfg, dataFor(cfg, [{ points: pts }])).series[0].data;
    expect(data).toEqual([
      pts[0],
      [pts[0][0] + 1, 20],
      [pts[1][0] - 2, 20],
      [pts[1][0] - 1, 20],
      pts[1],
      pts[2],
      pts[3],
      [NOW, 21.8],
    ]);
  });
});

describe('buildOptions: point reduction', () => {
  const pts = series(86_400, (i) => 1000 + 500 * Math.sin(i / 3000) + (i % 17) * 10);

  it('reduces large series to a few points per px when the width is known (no LTTB)', () => {
    const cfg = cfgOf({ series: ['sensor.power', { entity: 'binary_sensor.pump' }] });
    const opt = build(cfg, dataFor(cfg, [{ points: pts }, { points: series(86_400, (i) => (i % 600 < 300 ? 1 : 0)), isBinary: true }]), { width: 400 });
    for (const s of opt.series.slice(0, 2)) {
      expect(s.data.length).toBeLessThan(5 * 400);
      expect(s.sampling).toBeUndefined();
    }
    // The true extremes survive the reduction.
    const values = opt.series[0].data.map((p: Point) => p[1]);
    expect(Math.max(...values)).toBe(Math.max(...pts.map((p) => p[1] as number)));
    // Without a width (tests, unmeasured element) ECharts' LTTB is used for non-stepped series.
    expect(build(cfg, dataFor(cfg, [{ points: pts }, { points: [] }])).series[0].sampling).toBe('lttb');
  });

  it('re-reduces the zoomed range at its own resolution and keeps the zoom window', () => {
    const cfg = cfgOf({ show: { zoom: true }, series: ['sensor.power'] });
    const zoom = { start: 50, end: 54.1667 }; // one hour
    const full = build(cfg, dataFor(cfg, [{ points: pts }]), { width: 400 });
    const zoomed = build(cfg, dataFor(cfg, [{ points: pts }]), { width: 400, zoom });
    const from = NOW - DAY + DAY * 0.5;
    const to = NOW - DAY + DAY * 0.541667;
    const inRange = (o: any) => o.series[0].data.filter((p: Point) => p[0] >= from && p[0] < to).length;
    expect(inRange(zoomed)).toBeGreaterThan(4 * inRange(full));
    expect(zoomed.dataZoom[0]).toMatchObject({ start: 50, end: 54.1667 });
    expect(full.dataZoom[0]).toMatchObject({ start: 0, end: 100 });
  });
});

describe('buildOptions: zoom gestures', () => {
  const cfg = cfgOf({ show: { zoom: true }, series: ['sensor.a'] });
  const data = dataFor(cfg, [{ points: series(20, (i) => i) }]);

  it('touch: page scrolling wins until zoomed in; pinch always zooms', () => {
    const idle = build(cfg, data, { touch: true }).dataZoom[0];
    expect(idle).toMatchObject({ moveOnMouseMove: false, preventDefaultMouseMove: false, zoomLock: false });
    const zoomed = build(cfg, data, { touch: true, zoom: { start: 20, end: 40 } }).dataZoom[0];
    expect(zoomed).toMatchObject({ moveOnMouseMove: true, preventDefaultMouseMove: true });
  });

  it('mouse: drag pans; the wheel only zooms while Ctrl is held (page scroll otherwise)', () => {
    expect(build(cfg, data).dataZoom[0]).toMatchObject({ moveOnMouseMove: true, zoomLock: true, zoomOnMouseWheel: 'ctrl' });
    expect(build(cfg, data, { zoomModifier: true }).dataZoom[0]).toMatchObject({ zoomLock: false });
  });
});

describe('buildOptions: legend and height', () => {
  it('lists only the series the header cannot toggle', () => {
    const cfg = cfgOf({ series: ['sensor.a', 'sensor.b', { entity: 'climate.x', attribute: 'temperature', name: 'Setpoint', show_in_header: false }] });
    const opt = build(cfg, dataFor(cfg, [{ name: 'A' }, { name: 'B' }, { name: 'Setpoint' }]));
    expect(opt.legend).toMatchObject({ show: true, data: ['Setpoint'] });
    expect(Object.keys(opt.legend.selected)).toEqual(['A', 'B', 'Setpoint']);
  });

  it('derives the y tick count from the measured chart height (sections layout)', () => {
    const cfg = cfgOf({ height: 120, series: ['sensor.a'] });
    const data = dataFor(cfg, [{ points: series(10, (i) => i) }]);
    expect(build(cfg, data).yAxis[0].splitNumber).toBe(2);
    expect(build(cfg, data, { height: 440 }).yAxis[0].splitNumber).toBe(8);
  });
});
