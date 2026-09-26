import { describe, expect, it } from 'vitest';
import { DAY, DEFAULTS, HOUR, MINUTE, SECOND, WEEK, normalizeConfig, parseDuration } from '../src/config';
import { DEFAULT_PALETTE } from '../src/chart/theme';
import type { CardConfig } from '../src/types';

const TYPE = 'custom:echart-graph-card';
const cfg = (c: Partial<CardConfig>) => normalizeConfig({ type: TYPE, series: ['sensor.a'], ...c } as CardConfig);
const bad = (c: Record<string, unknown>) => () => normalizeConfig({ type: TYPE, ...c } as unknown as CardConfig);

describe('parseDuration', () => {
  it.each([
    ['30s', 30 * SECOND],
    ['5m', 5 * MINUTE],
    ['24h', DAY],
    ['7d', WEEK],
    ['1w', WEEK],
    ['2w', 2 * WEEK],
    ['1h30m', 90 * MINUTE],
    ['1.5h', 90 * MINUTE],
    ['500ms', 500],
    ['10 minutes', 10 * MINUTE],
    ['  2 Hours ', 2 * HOUR],
    ['1d 12h', 36 * HOUR],
    ['0s', 0],
  ])('%s', (input, expected) => {
    expect(parseDuration(input)).toBe(expected);
  });

  it('interprets bare numbers in the given unit (default seconds)', () => {
    expect(parseDuration(90)).toBe(90 * SECOND);
    expect(parseDuration('90')).toBe(90 * SECOND);
    expect(parseDuration(48, HOUR)).toBe(48 * HOUR);
    expect(parseDuration('1.5', HOUR)).toBe(90 * MINUTE);
  });

  it.each([['soon'], ['5x'], ['-5m'], ['h'], [''], ['5m garbage']])('rejects %j', (input) => {
    expect(() => parseDuration(input)).toThrow(/Invalid duration/);
  });

  it('rejects negative and non-finite numbers', () => {
    expect(() => parseDuration(-1)).toThrow(/non-negative/);
    expect(() => parseDuration(Number.NaN)).toThrow(/non-negative/);
    expect(() => parseDuration({} as unknown as string)).toThrow(/Invalid duration/);
  });
});

describe('normalizeConfig: defaults', () => {
  it('turns a minimal config into a complete one', () => {
    const c = normalizeConfig({ type: TYPE, series: ['sensor.temp'] });
    expect(c).toMatchObject({
      type: TYPE,
      title: undefined,
      spanMs: DAY,
      height: DEFAULTS.height,
      dataSource: 'history',
      dataSourceAuto: true,
      statisticsPeriod: '5minute',
      update: { mode: 'live', intervalMs: 5 * MINUTE },
      show: { legend: false, tooltip: true, headerStates: true, zoom: false, extrema: false, points: false, xAxis: true, yAxis: true },
      yAxes: [],
      thresholds: [],
    });
    expect(c.series).toHaveLength(1);
    expect(c.series[0]).toEqual({
      index: 0,
      key: '0:sensor.temp',
      entity: 'sensor.temp',
      attribute: undefined,
      name: undefined,
      color: DEFAULT_PALETTE[0],
      unit: undefined,
      yAxis: null,
      line: { width: 2, smooth: DEFAULTS.smooth, step: 'auto', style: 'solid' },
      fill: 'gradient',
      fillOpacity: DEFAULTS.gradientOpacity,
      groupBy: null,
      transform: { multiply: 1, offset: 0 },
      colorThresholds: [],
      statistic: 'auto',
      precision: undefined,
      showInHeader: true,
      hidden: false,
    });
  });

  it('keeps the raw config', () => {
    const raw: CardConfig = { type: TYPE, series: ['sensor.a'] };
    expect(normalizeConfig(raw).raw).toBe(raw);
  });

  it('accepts `entities` as an alias of `series` and bare strings', () => {
    const c = normalizeConfig({ type: TYPE, entities: ['sensor.a', { entity: 'sensor.b', name: 'B' }] });
    expect(c.series.map((s) => [s.entity, s.name])).toEqual([
      ['sensor.a', undefined],
      ['sensor.b', 'B'],
    ]);
    // series wins when both are present
    expect(normalizeConfig({ type: TYPE, series: ['sensor.x'], entities: ['sensor.y'] }).series[0].entity).toBe('sensor.x');
  });

  it('assigns palette colors by index and wraps around', () => {
    const series = Array.from({ length: 12 }, (_, i) => `sensor.s${i}`);
    const c = cfg({ series });
    expect(c.series[0].color).toBe(DEFAULT_PALETTE[0]);
    expect(c.series[3].color).toBe(DEFAULT_PALETTE[3]);
    expect(c.series[10].color).toBe(DEFAULT_PALETTE[0]);
    expect(cfg({ series: [{ entity: 'sensor.a', color: 'var(--accent-color)' }] }).series[0].color).toBe('var(--accent-color)');
  });

  it('does not auto-fill value-coloured series (>= 2 color_thresholds stops)', () => {
    const stops = [
      { value: 0, color: 'red' },
      { value: 50, color: 'green' },
    ];
    const series = cfg({
      series: [
        { entity: 'sensor.a', color_thresholds: stops },
        { entity: 'sensor.b', color_thresholds: [{ value: 0, color: 'red' }] },
        { entity: 'sensor.c', color_thresholds: stops, fill: 'solid' },
      ],
    }).series;
    expect(series.map((s) => s.fill)).toEqual(['none', 'none', 'solid']);
    const two = cfg({ series: [{ entity: 'sensor.a', color_thresholds: stops }, { entity: 'sensor.b', color_thresholds: [{ value: 0, color: 'red' }] }] }).series;
    expect(two.map((s) => s.fill)).toEqual(['none', 'gradient']);
  });

  it('fills with a gradient for up to 2 series, none above; explicit fill wins', () => {
    expect(cfg({ series: ['sensor.a', 'sensor.b'] }).series.map((s) => s.fill)).toEqual(['gradient', 'gradient']);
    const three = cfg({ series: ['sensor.a', 'sensor.b', { entity: 'sensor.c', fill: 'solid' }] }).series;
    expect(three.map((s) => [s.fill, s.fillOpacity])).toEqual([
      ['none', 0],
      ['none', 0],
      ['solid', DEFAULTS.solidOpacity],
    ]);
    expect(cfg({ series: [{ entity: 'sensor.a', fill_opacity: 0.6 }] }).series[0].fillOpacity).toBe(0.6);
  });

  it('shows the legend by default only for multi-series cards without header states', () => {
    expect(cfg({ series: ['sensor.a', 'sensor.b'] }).show.legend).toBe(false);
    expect(cfg({ series: ['sensor.a', 'sensor.b'], show: { header_states: false } }).show).toMatchObject({
      legend: true,
      legendKeys: ['0:sensor.a', '1:sensor.b'],
    });
    expect(cfg({ series: ['sensor.a'], show: { header_states: false } }).show.legend).toBe(false);
    expect(cfg({ series: ['sensor.a'], show: { legend: true } }).show.legend).toBe(true);
  });

  it('lists series the header cannot toggle in the legend by default', () => {
    // Setpoint has no chip: legend with just the setpoint.
    const chips2 = cfg({ series: ['sensor.a', 'sensor.b', { entity: 'sensor.c', show_in_header: false }] }).show;
    expect(chips2).toMatchObject({ legend: true, legendKeys: ['2:sensor.c'] });
    // A single hero chip has no toggle: once a legend is needed it lists the hero series too.
    const hero = cfg({ series: ['sensor.a', { entity: 'sensor.b', show_in_header: false }] }).show;
    expect(hero).toMatchObject({ legend: true, legendKeys: ['0:sensor.a', '1:sensor.b'] });
    // A hidden hero series could never be shown otherwise.
    expect(cfg({ series: [{ entity: 'sensor.a', hidden: true }] }).show).toMatchObject({ legend: true, legendKeys: ['0:sensor.a'] });
    // A lone chip-less series needs no legend (nothing to toggle), unless it starts hidden.
    expect(cfg({ series: [{ entity: 'sensor.a', show_in_header: false }] }).show.legend).toBe(false);
    expect(cfg({ series: [{ entity: 'sensor.a', show_in_header: false, hidden: true }] }).show.legend).toBe(true);
    // Explicit settings win; an explicit legend lists every series.
    expect(cfg({ series: ['sensor.a', { entity: 'sensor.c', show_in_header: false }], show: { legend: false } }).show.legend).toBe(false);
    expect(cfg({ series: ['sensor.a', 'sensor.b'], show: { legend: true } }).show.legendKeys).toEqual(['0:sensor.a', '1:sensor.b']);
  });

  it('gives binary entities thin, straight lines unless configured', () => {
    const [door, sw, attr, custom] = cfg({
      series: [
        'binary_sensor.door',
        'switch.pump',
        { entity: 'binary_sensor.door', attribute: 'battery' },
        { entity: 'binary_sensor.door', line: { width: 3, smooth: true } },
      ],
    }).series;
    expect(door.line).toMatchObject({ width: DEFAULTS.binaryLineWidth, smooth: 0, step: 'auto' });
    expect(sw.line).toMatchObject({ width: DEFAULTS.binaryLineWidth, smooth: 0 });
    expect(attr.line).toMatchObject({ width: 2, smooth: DEFAULTS.smooth });
    expect(custom.line).toMatchObject({ width: 3, smooth: DEFAULTS.smooth });
  });

  it('builds unique keys including the attribute', () => {
    const c = cfg({ series: ['sensor.a', { entity: 'sensor.a', attribute: 'voltage' }] });
    expect(c.series.map((s) => s.key)).toEqual(['0:sensor.a', '1:sensor.a#voltage']);
  });

  it('accepts external statistic ids', () => {
    expect(cfg({ series: ['tibber:energy_consumption_home'] }).series[0].entity).toBe('tibber:energy_consumption_home');
    expect(cfg({ series: ['sensor.a_1', 'binary_sensor.door_2'] }).series).toHaveLength(2);
  });

  it('warns about unknown options, with hints for apexcharts / mini-graph-card keys', () => {
    const c = cfg({
      graph_span: '2h',
      grid_options: { rows: 4 },
      visibility: [],
      card_mod: {},
      view_layout: {},
      show: { labels: true },
      y_axes: [{ id: 'p', opposite: true }],
      thresholds: [{ value: 1, y: 2 }],
      group_by: { func: 'avg', duration: '5m', fill: 'last' },
      update: { interval: '60s', every: 1 },
      series: [
        { entity: 'sensor.a', stroke_width: 3, yaxis_id: 'p', line: { width: 2, dash: 'x' }, transform: { multiply: 2, divide: 3 }, foo: 1 },
        { entity: 'sensor.b', color_thresholds: [{ value: 1, color: 'red', opacity: 1 }] },
      ],
    } as unknown as Omit<CardConfig, 'type'>);
    expect(c.warnings).toEqual([
      'Unknown option "graph_span" is ignored (use span)',
      'Unknown option "y_axes[0].opposite" is ignored (use position: right)',
      'Unknown option "group_by.fill" is ignored (not needed, empty buckets repeat the held value)',
      'Unknown option "series[0].stroke_width" is ignored (use line.width)',
      'Unknown option "series[0].yaxis_id" is ignored (use y_axis)',
      'Unknown option "series[0].foo" is ignored',
      'Unknown option "series[0].line.dash" is ignored (use style)',
      'Unknown option "series[0].transform.divide" is ignored',
      'Unknown option "series[1].color_thresholds[0].opacity" is ignored',
      'Unknown option "update.every" is ignored',
      'Unknown option "show.labels" is ignored (use show.y_axis)',
      'Unknown option "thresholds[0].y" is ignored (use value)',
    ]);
    expect(cfg({ series: ['sensor.a'] }).warnings).toEqual([]);
  });

  it('stringifies numeric names/titles/units', () => {
    const c = cfg({ title: 2026, series: [{ entity: 'sensor.a', name: 42, unit: 1 }] } as unknown as CardConfig);
    expect(c.title).toBe('2026');
    expect(c.series[0]).toMatchObject({ name: '42', unit: '1' });
  });
});

describe('normalizeConfig: window and data source', () => {
  it('span wins over hours_to_show; bare numbers are hours', () => {
    expect(cfg({ hours_to_show: 48 }).spanMs).toBe(48 * HOUR);
    expect(cfg({ span: '7d', hours_to_show: 48 }).spanMs).toBe(WEEK);
    expect(cfg({ span: 12 }).spanMs).toBe(12 * HOUR);
    expect(cfg({ span: '90m' }).spanMs).toBe(90 * MINUTE);
    expect(cfg({ hours_to_show: '36h' } as unknown as CardConfig).spanMs).toBe(36 * HOUR);
    expect(cfg({ hours_to_show: '6' } as unknown as CardConfig).spanMs).toBe(6 * HOUR);
  });

  it('auto source: history up to and including 72h, statistics above', () => {
    expect(cfg({ span: '72h' })).toMatchObject({ dataSource: 'history', dataSourceAuto: true });
    expect(cfg({ span: '73h' })).toMatchObject({ dataSource: 'statistics', dataSourceAuto: true });
    expect(cfg({ span: '30d', data_source: 'history' })).toMatchObject({ dataSource: 'history', dataSourceAuto: false });
    expect(cfg({ span: '1h', data_source: 'statistics' })).toMatchObject({ dataSource: 'statistics', dataSourceAuto: false });
  });

  it('picks the statistics period from the span unless configured', () => {
    expect(cfg({ span: '2d' }).statisticsPeriod).toBe('5minute');
    expect(cfg({ span: '7d' }).statisticsPeriod).toBe('hour');
    expect(cfg({ span: '31d' }).statisticsPeriod).toBe('hour');
    expect(cfg({ span: '90d' }).statisticsPeriod).toBe('day');
    expect(cfg({ span: '90d', statistics_period: 'week' }).statisticsPeriod).toBe('week');
  });

  it('normalizes height', () => {
    expect(cfg({ height: 300 }).height).toBe('300px');
    expect(cfg({ height: '300' }).height).toBe('300px');
    expect(cfg({ height: ' 20vh ' }).height).toBe('20vh');
    expect(cfg({ height: '15rem' }).height).toBe('15rem');
    expect(cfg({ height: '180PX' }).height).toBe('180px');
    expect(cfg({ height: '12.5em' }).height).toBe('12.5em');
  });

  it('an explicit statistics_period makes auto use statistics; ignored options are reported', () => {
    expect(cfg({ span: '24h', statistics_period: 'hour' })).toMatchObject({ dataSource: 'statistics', dataSourceAuto: true, statisticsPeriod: 'hour' });
    expect(cfg({ span: '24h' }).dataSource).toBe('history');
    expect(cfg({ data_source: 'history', statistics_period: 'hour' }).warnings).toEqual(['statistics_period is ignored with data_source: history']);
    // ...unless a series uses statistics anyway (explicit column / external statistic).
    expect(cfg({ data_source: 'history', statistics_period: 'hour', series: [{ entity: 'sensor.w', statistic: 'change' }] }).warnings).toEqual([]);
  });

  it('normalizes update modes', () => {
    expect(cfg({ update: 'live' }).update).toEqual({ mode: 'live', intervalMs: DEFAULTS.liveRefreshMs });
    expect(cfg({ update: 'none' }).update).toEqual({ mode: 'none', intervalMs: 0 });
    expect(cfg({ update: '60s' }).update).toEqual({ mode: 'interval', intervalMs: 60 * SECOND });
    expect(cfg({ update: 30 }).update).toEqual({ mode: 'interval', intervalMs: 30 * SECOND });
    expect(cfg({ update: { interval: '2m' } }).update).toEqual({ mode: 'interval', intervalMs: 2 * MINUTE });
  });
});

describe('normalizeConfig: group_by / transform / thresholds / axes', () => {
  it('resolves group_by: series wins, card default, false opts out, shorthand = avg', () => {
    const c = cfg({
      group_by: '10m',
      series: ['sensor.a', { entity: 'sensor.b', group_by: false }, { entity: 'sensor.c', group_by: { func: 'max', duration: '1h' } }, { entity: 'sensor.d', group_by: 300 }],
    });
    expect(c.series.map((s) => s.groupBy)).toEqual([
      { func: 'avg', durationMs: 10 * MINUTE },
      null,
      { func: 'max', durationMs: HOUR },
      { func: 'avg', durationMs: 5 * MINUTE },
    ]);
    expect(cfg({ series: [{ entity: 'sensor.a', group_by: { duration: '1d' } }] }).series[0].groupBy).toEqual({ func: 'avg', durationMs: DAY });
  });

  it('normalizes transform, color thresholds (sorted), statistic, precision, flags', () => {
    const [s] = cfg({
      series: [
        {
          entity: 'sensor.a',
          transform: { multiply: 0.001, offset: '2' as unknown as number },
          color_thresholds: [
            { value: 20, color: 'orange' },
            { value: 0, color: 'green' },
          ],
          statistic: 'change',
          precision: 1,
          show_in_header: false,
          hidden: true,
        },
      ],
    }).series;
    expect(s.transform).toEqual({ multiply: 0.001, offset: 2 });
    expect(s.colorThresholds.map((t) => t.value)).toEqual([0, 20]);
    expect(s).toMatchObject({ statistic: 'change', precision: 1, showInHeader: false, hidden: true });
  });

  it('normalizes line options', () => {
    const l = (line: unknown) => cfg({ series: [{ entity: 'sensor.a', line } as never] }).series[0].line;
    expect(l({ smooth: false })).toMatchObject({ smooth: 0 });
    expect(l({ smooth: 0.8 })).toMatchObject({ smooth: 0.8 });
    expect(l({ step: true })).toMatchObject({ step: 'end' });
    expect(l({ step: false })).toMatchObject({ step: false });
    expect(l({ step: 'start', style: 'dashed', width: 1 })).toMatchObject({ step: 'start', style: 'dashed', width: 1 });
  });

  it('validates and positions y_axes, binds series by explicit id or unit', () => {
    const c = cfg({
      y_axes: [
        { id: 'power', unit: 'W', min: 'auto', max: 5000, soft_min: -3000 },
        { id: 'pct', unit: '%', min: 0, max: 100 },
        { id: 'third', position: 'left', show: false },
      ],
      series: [{ entity: 'sensor.a', y_axis: 'pct' }, { entity: 'sensor.b', unit: 'W' }, { entity: 'sensor.c', unit: 'kWh' }, 'sensor.d'],
    });
    expect(c.yAxes.map((a) => [a.id, a.position, a.show])).toEqual([
      ['power', 'left', true],
      ['pct', 'right', true],
      ['third', 'left', false],
    ]);
    expect(c.yAxes[0]).toMatchObject({ min: undefined, max: 5000, softMin: -3000 });
    expect(c.series.map((s) => s.yAxis)).toEqual(['pct', 'power', null, null]);
  });

  it('normalizes thresholds (lines and bands)', () => {
    const c = cfg({
      y_axes: [{ id: 'p' }],
      thresholds: [{ value: 0 }, { from: 10, to: 20, color: 'red', label: 'comfort', y_axis: 'p' }, { to: 5 }],
    });
    expect(c.thresholds[0]).toMatchObject({ kind: 'line', value: 0, style: 'dashed', width: 1, opacity: DEFAULTS.thresholdLineOpacity, yAxis: null });
    expect(c.thresholds[1]).toMatchObject({ kind: 'area', from: 10, to: 20, color: 'red', label: 'comfort', opacity: DEFAULTS.thresholdAreaOpacity, yAxis: 'p' });
    expect(c.thresholds[2]).toMatchObject({ kind: 'area', from: undefined, to: 5 });
  });
});

describe('normalizeConfig: friendly errors', () => {
  it.each([
    [{}, /Invalid config: series must be a non-empty list/],
    [{ series: [] }, /series must be a non-empty list/],
    [{ entities: 'sensor.a' }, /entities must be a non-empty list/],
    [{ series: [{}] }, /series\[0\]\.entity is required/],
    [{ series: [42] }, /series\[0\] must be an entity id/],
    [{ series: ['not an entity'] }, /series\[0\]\.entity "not an entity" is not a valid entity id/],
    [{ series: [{ entity: 'sensor.a', y_axis: 'nope' }] }, /series\[0\]\.y_axis references unknown y-axis "nope" \(no y_axes configured\)/],
    [{ series: ['sensor.a'], y_axes: [{ id: 'a' }], thresholds: [{ value: 1, y_axis: 'b' }] }, /thresholds\[0\]\.y_axis references unknown y-axis "b" \(known: a\)/],
    [{ series: ['sensor.a'], span: 'soon' }, /Invalid config: span is an invalid duration/],
    [{ series: ['sensor.a'], span: 0 }, /span must be > 0/],
    [{ series: ['sensor.a'], hours_to_show: -3 }, /hours_to_show/],
    [{ series: ['sensor.a'], data_source: 'cloud' }, /data_source must be one of auto, history, statistics \(got "cloud"\)/],
    [{ series: ['sensor.a'], statistics_period: 'year' }, /statistics_period must be one of/],
    [{ series: ['sensor.a'], update: '1s' }, /update must be at least 5s/],
    [{ series: ['sensor.a'], update: true }, /update must be live, none or a refresh interval like "60s" \(got true\)/],
    [{ series: ['sensor.a'], update: 'always' }, /update must be live, none or a refresh interval like "60s" \(got "always"\)/],
    [{ series: ['sensor.a'], update: { interval: 'soon' } }, /update\.interval must be a duration like "60s" \(got "soon"\)/],
    [{ series: ['sensor.Living_Room'] }, /series\[0\]\.entity "sensor\.Living_Room" is not a valid entity id \(did you mean "sensor\.living_room"\?\)/],
    [{ series: ['sensor.living-room'] }, /did you mean "sensor\.living_room"/],
    [{ series: ['sensor.a.b'] }, /"sensor\.a\.b" is not a valid entity id/],
    [{ series: ['sensor._a'] }, /"sensor\._a" is not a valid entity id \(did you mean "sensor\.a"\?\)/],
    [{ entities: ['Sensor.A'] }, /entities\[0\]\.entity "Sensor\.A" is not a valid entity id/],
    [{ series: [{ entity: 'tibber:consumption', attribute: 'x' }] }, /series\[0\]\.attribute cannot be used with the external statistic/],
    [{ series: [{ entity: 'climate.a', attribute: 'temperature', statistic: 'mean' }] }, /series\[0\]\.statistic cannot be combined with attribute/],
    [{ series: ['sensor.a'], y_axes: [{ id: 'p', min: '~-3000' }] }, /y_axes\[0\]\.min must be a number \(got "~-3000"\); for a soft bound use soft_min: -3000/],
    [{ series: ['sensor.a'], y_axes: [{ id: 'p', max: '~5000' }] }, /for a soft bound use soft_max: 5000/],
    [{ series: ['sensor.a'], height: '250 px' }, /height must be a CSS length like "250px", "15rem" or "30vh" \(got "250 px"\); % and auto are not supported/],
    [{ series: ['sensor.a'], height: '50%' }, /height must be a CSS length/],
    [{ series: ['sensor.a'], height: 'auto' }, /height must be a CSS length/],
    [{ series: ['sensor.a'], height: 'big' }, /height must be a CSS length/],
    [{ series: ['sensor.a'], height: '0px' }, /height must be a CSS length/],
    [{ series: ['sensor.a'], height: '0' }, /height must be a positive number/],
    [{ series: ['sensor.a'], height: -5 }, /height must be a positive number/],
    [{ series: ['sensor.a'], show: 'yes' }, /show must be an object/],
    [{ series: ['sensor.a'], show: { zoom: 'yes' } }, /show\.zoom must be true or false/],
    [{ series: ['sensor.a'], group_by: { func: 'mean', duration: '5m' } }, /group_by\.func must be one of avg, min, max/],
    [{ series: ['sensor.a'], group_by: { func: 'avg' } }, /group_by\.duration is required/],
    [{ series: ['sensor.a'], group_by: '0s' }, /group_by duration must be > 0/],
    [{ series: [{ entity: 'sensor.a', fill: 'full' }] }, /series\[0\]\.fill must be one of none, solid, gradient/],
    [{ series: [{ entity: 'sensor.a', fill_opacity: 2 }] }, /fill_opacity must be <= 1/],
    [{ series: [{ entity: 'sensor.a', line: { smooth: 3 } }] }, /line\.smooth must be <= 1/],
    [{ series: [{ entity: 'sensor.a', line: 'thick' }] }, /line must be an object/],
    [{ series: [{ entity: 'sensor.a', transform: 2 }] }, /transform must be \{ multiply, offset \}/],
    [{ series: [{ entity: 'sensor.a', transform: { multiply: 'x' } }] }, /transform\.multiply must be a number/],
    [{ series: [{ entity: 'sensor.a', color_thresholds: [{ value: 1 }] }] }, /color_thresholds\[0\]\.color is required/],
    [{ series: [{ entity: 'sensor.a', statistic: 'avg' }] }, /statistic must be one of mean, min, max, sum, state, change/],
    [{ series: ['sensor.a'], y_axes: [{ id: 'a' }, { id: 'a' }] }, /y_axes\[1\]\.id "a" is used more than once/],
    [{ series: ['sensor.a'], y_axes: [{ id: 'a', min: 10, max: 5 }] }, /y_axes\[0\] min \(10\) must be < max \(5\)/],
    [{ series: ['sensor.a'], y_axes: [{ unit: 'W' }] }, /y_axes\[0\]\.id is required/],
    [{ series: ['sensor.a'], thresholds: [{ color: 'red' }] }, /thresholds\[0\] needs either value \(line\) or from\/to \(band\)/],
    [{ series: ['sensor.a'], thresholds: [{ value: 1, from: 0 }] }, /cannot have both value and from\/to/],
    [{ series: ['sensor.a'], thresholds: [{ from: 5, to: 1 }] }, /from \(5\) must be < to \(1\)/],
  ])('%j', (c, message) => {
    expect(bad(c as Record<string, unknown>)).toThrow(message);
  });

  it('rejects non-object configs', () => {
    expect(() => normalizeConfig(null as unknown as CardConfig)).toThrow(/Invalid config: expected an object/);
  });
});
