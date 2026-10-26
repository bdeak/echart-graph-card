import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CardConfig, HassEntityState, HomeAssistant, NormalizedConfig, Point, SeriesData } from '../src/types';
import type * as FormatModule from '../src/chart/format';
import type * as OptionsModule from '../src/chart/options';

// ---------------------------------------------------------------------------
// Mocks: ECharts (no canvas in happy-dom), the WS loader, option building and number
// formatting (owned by other modules; keeps these tests about the card lifecycle).
// ---------------------------------------------------------------------------

interface FakeChart {
  el: HTMLElement;
  setOption: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  dispatchAction: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
  isDisposed: () => boolean;
  handlers: Map<string, (e: unknown) => void>;
}

const h = vi.hoisted(() => {
  const charts: FakeChart[] = [];
  const makeChart = (el: HTMLElement): FakeChart => {
    let disposed = false;
    const handlers = new Map<string, (e: unknown) => void>();
    const chart: FakeChart = {
      el,
      setOption: vi.fn(),
      resize: vi.fn(),
      clear: vi.fn(),
      dispose: vi.fn(() => {
        disposed = true;
      }),
      dispatchAction: vi.fn(),
      on: vi.fn((name: string, fn: (e: unknown) => void) => handlers.set(name, fn)),
      off: vi.fn((name: string) => handlers.delete(name)),
      isDisposed: () => disposed,
      handlers,
    };
    charts.push(chart);
    return chart;
  };
  return { charts, makeChart };
});

vi.mock('../src/chart/echarts', () => ({
  echarts: {
    init: vi.fn((el: HTMLElement) => h.makeChart(el)),
    dispose: vi.fn(),
    getInstanceByDom: vi.fn(),
    graphic: {},
  },
}));

vi.mock('../src/data/loader', () => ({ loadSeriesData: vi.fn(), loadHistoryRange: vi.fn() }));

vi.mock('../src/chart/options', async (importOriginal) => ({
  ...(await importOriginal<typeof OptionsModule>()),
  buildOptions: vi.fn(() => ({ series: [] })),
  assignAxes: vi.fn(),
}));

vi.mock('../src/chart/format', async (importOriginal) => ({
  ...(await importOriginal<typeof FormatModule>()),
  formatValue: (v: number | null | undefined, unit?: string, precision?: number) =>
    v === null || v === undefined || Number.isNaN(v)
      ? '—'
      : `${precision === undefined ? String(v) : v.toFixed(precision)}${unit ? ` ${unit}` : ''}`,
}));

import { echarts } from '../src/chart/echarts';
import { buildOptions } from '../src/chart/options';
import { loadHistoryRange, loadSeriesData } from '../src/data/loader';
import { normalizeConfig } from '../src/config';
import { CARD_NAME } from '../src/const';
import { EchartGraphCard } from '../src/card';
import { computeExtrema, thresholdColor } from '../src/header';
import '../src/index';

const loadMock = vi.mocked(loadSeriesData);
const rangeMock = vi.mocked(loadHistoryRange);
const MERGE = { replaceMerge: ['series', 'yAxis', 'visualMap'], lazyUpdate: true, silent: true };
const buildMock = vi.mocked(buildOptions);
const initMock = vi.mocked(echarts.init);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const T0 = Date.parse('2026-09-26T12:00:00Z');

function entity(id: string, state: string, attributes: Record<string, unknown> = {}, at = T0): HassEntityState {
  const iso = new Date(at).toISOString();
  return { entity_id: id, state, attributes, last_changed: iso, last_updated: iso };
}

function makeHass(states: HassEntityState[], extra: Partial<HomeAssistant> = {}): HomeAssistant {
  return {
    states: Object.fromEntries(states.map((s) => [s.entity_id, s])),
    callWS: vi.fn(),
    connection: { subscribeMessage: vi.fn() },
    locale: { language: 'en', time_zone: 'local', number_format: 'language' },
    config: { time_zone: 'Europe/Berlin' },
    themes: { darkMode: false },
    ...extra,
  } as HomeAssistant;
}

/** New hass object with some states replaced (like HA does on state_changed). */
function withStates(hass: HomeAssistant, ...states: HassEntityState[]): HomeAssistant {
  const next = { ...hass.states };
  for (const s of states) next[s.entity_id] = s;
  return { ...hass, states: next };
}

function fakeData(cfg: NormalizedConfig, now: number, extra: Partial<SeriesData> = {}): SeriesData[] {
  return cfg.series.map((s) => ({
    series: s,
    points: [
      [now - 2 * 3_600_000, 20],
      [now - 3_600_000, 21.5],
    ] as Point[],
    unit: s.entity === HUM ? '%' : '°C',
    name: s.name ?? s.entity,
    isBinary: false,
    latest: 21.5,
    source: 'history' as const,
    ...extra,
  }));
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function settle(el: EchartGraphCard): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await el.updateComplete;
    await Promise.resolve();
  }
}

function create(config: CardConfig, hass?: HomeAssistant): EchartGraphCard {
  const el = document.createElement(CARD_NAME) as EchartGraphCard;
  el.setConfig(config);
  if (hass) el.hass = hass;
  return el;
}

async function mount(config: CardConfig, hass?: HomeAssistant): Promise<EchartGraphCard> {
  const el = create(config, hass);
  document.body.appendChild(el);
  await settle(el);
  return el;
}

const q = <T extends Element = HTMLElement>(el: EchartGraphCard, sel: string): T | null => el.shadowRoot!.querySelector<T>(sel);
const qa = (el: EchartGraphCard, sel: string): HTMLElement[] => [...el.shadowRoot!.querySelectorAll<HTMLElement>(sel)];
const lastChart = (): FakeChart => h.charts[h.charts.length - 1];
const lastCall = (fn: ReturnType<typeof vi.fn>): unknown[] | undefined => fn.mock.calls[fn.mock.calls.length - 1];

let hidden = false;
Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });

const TEMP = 'sensor.living_room_temperature';
const HUM = 'sensor.living_room_humidity';

beforeEach(() => {
  hidden = false;
  h.charts.length = 0;
  vi.clearAllMocks();
  loadMock.mockImplementation(async (_hass, cfg, now) => fakeData(cfg, now.getTime()));
  rangeMock.mockImplementation(async () => ({}));
  buildMock.mockImplementation(() => ({ series: [] }));
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Registration / static API
// ---------------------------------------------------------------------------

describe('registration', () => {
  it('defines the custom element and a card picker entry', () => {
    expect(customElements.get(CARD_NAME)).toBe(EchartGraphCard);
    const entry = window.customCards?.find((c) => c.type === CARD_NAME);
    expect(entry).toMatchObject({ name: 'ECharts Graph Card', preview: true });
    expect(entry?.description).toBeTruthy();
    expect(entry?.documentationURL).toMatch(/^https:\/\//);
    expect(window.customCards?.filter((c) => c.type === CARD_NAME)).toHaveLength(1);
  });

  it('importing the entry point twice does not redefine or duplicate', async () => {
    vi.resetModules();
    await expect(import('../src/index')).resolves.toBeDefined();
    expect(window.customCards?.filter((c) => c.type === CARD_NAME)).toHaveLength(1);
  });
});

describe('setConfig', () => {
  it('throws on invalid config (HA renders its error card)', () => {
    const el = document.createElement(CARD_NAME) as EchartGraphCard;
    expect(() => el.setConfig({ type: 'custom:echart-graph-card' })).toThrow(/Invalid config: series/);
    expect(() => el.setConfig({ type: 'custom:echart-graph-card', series: [] })).toThrow(/non-empty/);
    expect(() => el.setConfig({ type: 'custom:echart-graph-card', series: ['not an entity'] })).toThrow(/not a valid entity id/);
    expect(() => el.setConfig({ type: 'custom:echart-graph-card', span: 'soon', series: [TEMP] })).toThrow(/span/);
    expect(() => el.setConfig({ type: 'custom:echart-graph-card', update: '1s', series: [TEMP] })).toThrow(/at least 5s/);
  });

  it('accepts minimal configs', () => {
    const el = document.createElement(CARD_NAME) as EchartGraphCard;
    expect(() => el.setConfig({ type: 'custom:echart-graph-card', series: [TEMP] })).not.toThrow();
    expect(() => el.setConfig({ type: 'custom:echart-graph-card', entities: [{ entity: TEMP }] })).not.toThrow();
  });
});

describe('static helpers', () => {
  it('getStubConfig picks the first numeric sensor with a unit', () => {
    const hass = makeHass([
      entity('light.kitchen', 'on'),
      entity('sensor.status', 'ok'),
      entity('sensor.broken', 'unavailable', { unit_of_measurement: 'W' }),
      entity('sensor.power', '230', { unit_of_measurement: 'W' }),
      entity('sensor.temp', '21.5', { unit_of_measurement: '°C' }),
    ]);
    const stub = EchartGraphCard.getStubConfig(hass);
    expect(stub).toEqual({ type: 'custom:echart-graph-card', series: [{ entity: 'sensor.power' }] });
    expect(() => normalizeConfig(stub)).not.toThrow();
  });

  it('getStubConfig falls back gracefully', () => {
    const onlyUnavailable = makeHass([entity('sensor.broken', 'unavailable', { unit_of_measurement: 'W' })]);
    expect(EchartGraphCard.getStubConfig(onlyUnavailable).series).toEqual([{ entity: 'sensor.broken' }]);
    expect(EchartGraphCard.getStubConfig().series).toEqual([{ entity: 'sensor.temperature' }]);
    expect(EchartGraphCard.getStubConfig(makeHass([])).type).toBe('custom:echart-graph-card');
  });

  it('getGridOptions / getCardSize', () => {
    const el = create({ type: 'custom:echart-graph-card', series: [TEMP] });
    expect(el.getGridOptions()).toEqual({ columns: 12, min_columns: 4, min_rows: 2 }); // rows: auto (content height)
    expect(el.getCardSize()).toBe(6); // 220px -> 5 units + hero header
    el.setConfig({ type: 'custom:echart-graph-card', title: 'T', height: 100, show: { header_states: false }, series: [TEMP] });
    expect(el.getCardSize()).toBe(3);
    el.setConfig({ type: 'custom:echart-graph-card', title: 'T', height: '30vh', series: [TEMP, HUM] });
    expect(el.getCardSize()).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe('lifecycle', () => {
  const hass = (): HomeAssistant =>
    makeHass([
      entity(TEMP, '21.5', { unit_of_measurement: '°C', friendly_name: 'Living room' }),
      entity(HUM, '48', { unit_of_measurement: '%', friendly_name: 'Humidity' }),
      entity('sensor.unrelated', '1'),
    ]);

  it('renders the shell without hass and without creating a chart', async () => {
    const el = await mount({ type: 'custom:echart-graph-card', title: 'Hello', height: 180, series: [TEMP] });
    expect(q(el, '.title')?.textContent).toBe('Hello');
    expect(q(el, '.chart')?.style.height).toBe('180px');
    expect(q(el, '.shimmer')).not.toBeNull();
    expect(initMock).not.toHaveBeenCalled();
    expect(loadMock).not.toHaveBeenCalled();
  });

  it('loads once on first hass, inits the chart and draws with notMerge', async () => {
    const pending = deferred<SeriesData[]>();
    loadMock.mockImplementationOnce(() => pending.promise);
    const hs = hass();
    const el = await mount({ type: 'custom:echart-graph-card', series: [TEMP] }, hs);

    expect(loadMock).toHaveBeenCalledTimes(1);
    const [h0, cfg0, now0] = loadMock.mock.calls[0];
    expect(h0).toBe(hs);
    expect(cfg0.series[0].entity).toBe(TEMP);
    expect(now0).toBeInstanceOf(Date);
    expect(initMock).toHaveBeenCalledTimes(1);
    expect(initMock.mock.calls[0][0]).toBe(q(el, '.chart'));
    expect(q(el, '.shimmer')).not.toBeNull();
    expect(lastChart().setOption).not.toHaveBeenCalled();

    // More hass updates while loading do not start more loads.
    el.hass = withStates(hs, entity(TEMP, '21.6', { unit_of_measurement: '°C' }, T0 + 1000));
    expect(loadMock).toHaveBeenCalledTimes(1);

    pending.resolve(fakeData(cfg0, now0.getTime()));
    await settle(el);
    expect(q(el, '.shimmer')).toBeNull();
    expect(lastChart().setOption).toHaveBeenCalledTimes(1);
    expect(lastChart().setOption.mock.calls[0][1]).toEqual({ notMerge: true });
    const ctx = buildMock.mock.calls[buildMock.mock.calls.length - 1][3];
    expect(ctx.hass).toBe(el.hass);
    expect(typeof ctx.now).toBe('number');
    expect(typeof ctx.resolveColor).toBe('function');
  });

  it('single series renders a hero value read from hass.states', async () => {
    const el = await mount({ type: 'custom:echart-graph-card', title: 'Climate', series: [{ entity: TEMP, precision: 1 }] }, hass());
    expect(q(el, '.hero .title')?.textContent).toBe('Climate');
    expect(q(el, '.hero .subtitle')?.textContent).toBe(TEMP); // name from loaded data
    expect(q(el, '.hero-number')?.textContent).toBe('21.5');
    expect(q(el, '.hero-unit')?.textContent).toBe('°C');
  });

  it('hass.states churn of untracked entities never re-renders', async () => {
    const hs = hass();
    const el = await mount({ type: 'custom:echart-graph-card', series: [TEMP] }, hs);
    const render = vi.spyOn(el as unknown as { render: () => unknown }, 'render');
    el.hass = withStates(hs, entity('sensor.unrelated', '2'));
    await settle(el);
    expect(render).not.toHaveBeenCalled();
    // Theme change does re-render.
    el.hass = { ...el.hass!, themes: { darkMode: true } };
    await settle(el);
    expect(render).toHaveBeenCalled();
  });

  it('live mode: tracked state change -> throttled merge update + header refresh', async () => {
    vi.useFakeTimers({ now: T0 + 60_000, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const hs = hass();
    const el = await mount({ type: 'custom:echart-graph-card', series: [TEMP] }, hs);
    const chart = lastChart();
    expect(chart.setOption).toHaveBeenCalledTimes(1);

    el.hass = withStates(hs, entity(TEMP, '22.0', { unit_of_measurement: '°C' }, T0 + 61_000));
    el.hass = withStates(el.hass, entity(TEMP, '22.5', { unit_of_measurement: '°C' }, T0 + 61_500));
    await vi.advanceTimersByTimeAsync(0);
    await settle(el);
    expect(chart.setOption).toHaveBeenCalledTimes(2); // leading edge, both changes coalesced
    const [opt, opts] = chart.setOption.mock.calls[1];
    expect(opts).toEqual(MERGE);
    expect((opt as { animation?: boolean }).animation).toBe(false);
    expect(q(el, '.hero-number')?.textContent).toBe('22.5');
    const data = buildMock.mock.calls[buildMock.mock.calls.length - 1][1];
    expect(data[0].points[data[0].points.length - 1]).toEqual([T0 + 61_500, 22.5]);

    // Within the throttle window: deferred, then exactly one more update.
    el.hass = withStates(el.hass, entity(TEMP, '23', { unit_of_measurement: '°C' }, T0 + 62_000));
    await vi.advanceTimersByTimeAsync(500);
    expect(chart.setOption).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(600);
    await settle(el);
    expect(chart.setOption).toHaveBeenCalledTimes(3);
    expect(q(el, '.hero-number')?.textContent).toBe('23');
  });

  it('update: interval reloads on its cadence; update: none never reloads', async () => {
    vi.useFakeTimers({ now: T0, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const el = await mount({ type: 'custom:echart-graph-card', update: '10s', series: [TEMP] }, hass());
    expect(loadMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    await settle(el);
    expect(loadMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(loadMock).toHaveBeenCalledTimes(3);
    el.remove();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(loadMock).toHaveBeenCalledTimes(3); // timers stopped when detached

    loadMock.mockClear();
    const el2 = await mount({ type: 'custom:echart-graph-card', update: 'none', series: [TEMP] }, hass());
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    await settle(el2);
    expect(loadMock).toHaveBeenCalledTimes(1);
  });

  it('live mode: re-anchors every minute, refreshes only statistics series after each compile', async () => {
    vi.useFakeTimers({ now: T0 + 5 * 60_000, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    loadMock.mockImplementation(async (_h, cfg, now, opts) =>
      fakeData(cfg, now.getTime(), { source: 'statistics' }).filter((d) => !opts?.only || opts.only.has(d.series.key)),
    );
    const el = await mount({ type: 'custom:echart-graph-card', span: '7d', series: [TEMP] }, hass());
    const chart = lastChart();
    expect(loadMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_010); // tick at 60s schedules the (throttled) redraw
    await settle(el);
    expect(chart.setOption).toHaveBeenCalledTimes(2); // re-anchor (merge)
    expect(chart.setOption.mock.calls[1][1]).toMatchObject({ lazyUpdate: true });
    // Hourly statistics: nothing new before the next hour has been compiled (13:01 UTC).
    await vi.advanceTimersByTimeAsync(50 * 60_000);
    await settle(el);
    expect(loadMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    await settle(el);
    expect(loadMock).toHaveBeenCalledTimes(2);
    expect([...(loadMock.mock.calls[1][3]?.only ?? [])]).toEqual([`0:${TEMP}`]);
    // Drawn by merging (zoom / tooltip survive), not rebuilt.
    expect(lastCall(chart.setOption)?.[1]).toEqual(MERGE);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(loadMock).toHaveBeenCalledTimes(2);
  });

  it('pauses while the document is hidden and catches up when visible', async () => {
    vi.useFakeTimers({ now: T0 + 60_000, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const hs = hass();
    const el = await mount({ type: 'custom:echart-graph-card', series: [TEMP] }, hs);
    const chart = lastChart();
    hidden = true;
    document.dispatchEvent(new Event('visibilitychange'));
    el.hass = withStates(hs, entity(TEMP, '25', { unit_of_measurement: '°C' }, T0 + 61_000));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(chart.setOption).toHaveBeenCalledTimes(1);

    hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(10);
    await settle(el);
    expect(chart.setOption).toHaveBeenCalledTimes(2);
    expect(loadMock).toHaveBeenCalledTimes(1);

    // Hidden for a long time -> the gap is backfilled from history (no full reload).
    hidden = true;
    document.dispatchEvent(new Event('visibilitychange'));
    const hiddenAt = Date.now();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
    await settle(el);
    expect(loadMock).toHaveBeenCalledTimes(1);
    expect(rangeMock).toHaveBeenCalledTimes(1);
    expect(rangeMock.mock.calls[0][1].map((s) => s.entity)).toEqual([TEMP]);
    expect(rangeMock.mock.calls[0][2]).toBe(hiddenAt);
  });

  it('discards stale responses when the config changes mid-flight', async () => {
    const first = deferred<SeriesData[]>();
    const second = deferred<SeriesData[]>();
    loadMock.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
    const hs = hass();
    const el = await mount({ type: 'custom:echart-graph-card', series: [TEMP] }, hs);
    el.setConfig({ type: 'custom:echart-graph-card', span: '6h', series: [HUM] });
    await settle(el);
    expect(loadMock).toHaveBeenCalledTimes(2);
    const cfg2 = loadMock.mock.calls[1][1];

    second.resolve(fakeData(cfg2, T0));
    await settle(el);
    first.resolve(fakeData(loadMock.mock.calls[0][1], T0));
    await settle(el);

    const lastData = buildMock.mock.calls[buildMock.mock.calls.length - 1][1];
    expect(lastData.map((d) => d.series.entity)).toEqual([HUM]);
  });

  it('cosmetic config changes redraw without refetching', async () => {
    const el = await mount({ type: 'custom:echart-graph-card', series: [{ entity: TEMP, color: '#f00' }] }, hass());
    expect(loadMock).toHaveBeenCalledTimes(1);
    el.setConfig({ type: 'custom:echart-graph-card', title: 'New', series: [{ entity: TEMP, color: '#0f0' }] });
    await settle(el);
    expect(loadMock).toHaveBeenCalledTimes(1);
    const [cfg, data] = buildMock.mock.calls[buildMock.mock.calls.length - 1];
    expect(cfg.title).toBe('New');
    expect(data[0].series.color).toBe('#0f0');
    expect(lastCall(lastChart().setOption)?.[1]).toEqual({ notMerge: true });
  });

  it('shows WS failures and per-series errors inside the card', async () => {
    loadMock.mockRejectedValueOnce({ code: 'unknown_error', message: 'Connection lost' });
    const el = await mount({ type: 'custom:echart-graph-card', series: [TEMP] }, hass());
    expect(q(el, '.alert.error')?.textContent).toContain('Connection lost');
    expect(q(el, '.shimmer')).toBeNull();

    loadMock.mockImplementationOnce(async (_h, cfg) => [
      { series: cfg.series[0], points: [], name: 'sensor.gone', isBinary: false, source: 'history', error: 'Entity not found: sensor.gone' },
    ]);
    const el3 = await mount({ type: 'custom:echart-graph-card', series: ['sensor.gone'] }, hass());
    expect(q(el3, '.alert.warning')?.textContent).toContain('Entity not found: sensor.gone');
  });

  it('retries a failed initial load after the backoff', async () => {
    vi.useFakeTimers({ now: T0, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    loadMock.mockRejectedValueOnce(new Error('boom'));
    const hs = hass();
    const el = await mount({ type: 'custom:echart-graph-card', series: [TEMP] }, hs);
    expect(q(el, '.alert.error')?.textContent).toContain('boom');
    el.hass = withStates(hs, entity(TEMP, '22'));
    expect(loadMock).toHaveBeenCalledTimes(1); // backoff
    await vi.advanceTimersByTimeAsync(60_000);
    await settle(el);
    expect(loadMock).toHaveBeenCalledTimes(2);
    expect(q(el, '.alert.error')).toBeNull();
  });

  it('disposes on disconnect and re-creates the chart on reconnect', async () => {
    const el = await mount({ type: 'custom:echart-graph-card', series: [TEMP] }, hass());
    const first = lastChart();
    el.remove();
    expect(first.dispose).toHaveBeenCalledTimes(1);
    document.body.appendChild(el);
    await settle(el);
    expect(h.charts).toHaveLength(2);
    const second = lastChart();
    expect(second).not.toBe(first);
    expect(second.setOption).toHaveBeenCalledWith(expect.anything(), { notMerge: true });
  });

  it('sections layout fills the grid cell only with a fixed number of rows', async () => {
    const el = create({ type: 'custom:echart-graph-card', height: 300, grid_options: { rows: 5 }, series: [TEMP] } as CardConfig, hass());
    el.layout = 'grid';
    document.body.appendChild(el);
    await settle(el);
    expect(q(el, '.chart')?.style.height).toBe('100%');
    expect(el.hasAttribute('fill-height')).toBe(true);
    expect(q(el, 'ha-card')?.classList.contains('fill')).toBe(true);

    // Default (rows: auto) and explicit auto: sized by `height`, like HA's history graph card.
    for (const grid of [undefined, { rows: 'auto' }]) {
      const auto = create({ type: 'custom:echart-graph-card', height: 120, grid_options: grid, series: [TEMP] } as CardConfig, hass());
      auto.layout = 'grid';
      document.body.appendChild(auto);
      await settle(auto);
      expect(q(auto, '.chart')?.style.height).toBe('120px');
      expect(auto.hasAttribute('fill-height')).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Review fixes: reconnects, gaps, refresh cadence, merge redraws, zoom
// ---------------------------------------------------------------------------

describe('reload / catch-up behaviour', () => {
  const hass = (extra: Partial<HomeAssistant> = {}): HomeAssistant =>
    makeHass([entity(TEMP, '21.5', { unit_of_measurement: '°C', friendly_name: 'Living room' })], extra);
  const fake = { toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] as ('setTimeout' | 'clearTimeout' | 'setInterval' | 'clearInterval' | 'Date')[] };
  const offline = (h: HomeAssistant): HomeAssistant => ({ ...h, connected: false }) as HomeAssistant;
  const online = (h: HomeAssistant): HomeAssistant => ({ ...h, connected: true }) as HomeAssistant;

  it('retries a failed reload after a WebSocket reconnect even though data is loaded (live/history)', async () => {
    vi.useFakeTimers({ now: T0, ...fake });
    const h0 = online(hass());
    const el = await mount({ type: 'custom:echart-graph-card', series: [TEMP] }, h0);
    expect(loadMock).toHaveBeenCalledTimes(1);

    // HA restarts: disconnect for 20 min (longer than the window? no: 24h window -> backfill).
    el.hass = offline(h0);
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    rangeMock.mockRejectedValueOnce({ code: 'unknown_command', message: 'Unknown command.' });
    el.hass = online(h0);
    await settle(el);
    expect(rangeMock).toHaveBeenCalledTimes(1);
    expect(rangeMock.mock.calls[0][2]).toBe(T0); // gap starts when the socket went down
    expect(q(el, '.alert.error')?.textContent).toContain('Unknown command');

    // Retried with a full reload once the backoff expired, and the banner clears.
    await vi.advanceTimersByTimeAsync(60_000);
    await settle(el);
    expect(loadMock).toHaveBeenCalledTimes(2);
    expect(q(el, '.alert.error')).toBeNull();
  });

  it('measures re-attach staleness from the detach, and backfills only the gap', async () => {
    vi.useFakeTimers({ now: T0, ...fake });
    const el = await mount({ type: 'custom:echart-graph-card', series: [TEMP] }, hass());
    await vi.advanceTimersByTimeAsync(10 * 60_000); // connected for 10 min

    // Quick view switch: no fetch at all.
    el.remove();
    await vi.advanceTimersByTimeAsync(1000);
    document.body.appendChild(el);
    await settle(el);
    expect(loadMock).toHaveBeenCalledTimes(1);
    expect(rangeMock).not.toHaveBeenCalled();

    // Detached for 3 minutes: one history call for just the gap.
    el.remove();
    const detachedAt = Date.now();
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    document.body.appendChild(el);
    await settle(el);
    expect(loadMock).toHaveBeenCalledTimes(1);
    expect(rangeMock).toHaveBeenCalledTimes(1);
    expect(rangeMock.mock.calls[0][2]).toBe(detachedAt);

    // Detached longer than the window: full reload.
    el.remove();
    await vi.advanceTimersByTimeAsync(25 * 3_600_000);
    document.body.appendChild(el);
    await settle(el);
    expect(loadMock).toHaveBeenCalledTimes(2);
  });

  it('merges the backfilled history and pauses live appends while it is in flight', async () => {
    vi.useFakeTimers({ now: T0, ...fake });
    const h0 = hass();
    const el = await mount({ type: 'custom:echart-graph-card', series: [TEMP] }, h0);
    const pending = deferred<Record<string, Point[]>>();
    rangeMock.mockImplementationOnce(() => pending.promise);
    el.remove();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    document.body.appendChild(el);
    await settle(el);
    // A live change during the backfill is not appended yet (it would precede the gap's states).
    el.hass = withStates(h0, entity(TEMP, '23', { unit_of_measurement: '°C' }, T0 + 5 * 60_000));
    const key = `0:${TEMP}`;
    pending.resolve({ [key]: [[T0 + 60_000, 22]] });
    await settle(el);
    await vi.advanceTimersByTimeAsync(1100);
    await settle(el);
    const data = buildMock.mock.calls[buildMock.mock.calls.length - 1][1];
    expect(data[0].points.slice(-2)).toEqual([
      [T0 + 60_000, 22],
      [T0 + 5 * 60_000, 23],
    ]);
  });

  it('never refetches history in live mode, even for long forced-history windows', async () => {
    vi.useFakeTimers({ now: T0, ...fake });
    await mount({ type: 'custom:echart-graph-card', span: '7d', data_source: 'history', series: [TEMP] }, hass());
    await vi.advanceTimersByTimeAsync(3 * 3_600_000);
    expect(loadMock).toHaveBeenCalledTimes(1);
  });

  it('redraws interval reloads of the same config by merging (zoom and tooltip survive)', async () => {
    vi.useFakeTimers({ now: T0, ...fake });
    const el = await mount({ type: 'custom:echart-graph-card', update: '30s', show: { zoom: true }, series: [TEMP] }, hass());
    const chart = lastChart();
    expect(chart.setOption.mock.calls[0][1]).toEqual({ notMerge: true });
    await vi.advanceTimersByTimeAsync(30_000);
    await settle(el);
    expect(loadMock).toHaveBeenCalledTimes(2);
    expect(lastCall(chart.setOption)?.[1]).toEqual(MERGE);
    // A data-affecting config change still rebuilds from scratch.
    el.setConfig({ type: 'custom:echart-graph-card', update: '30s', span: '12h', series: [TEMP] });
    await settle(el);
    expect(lastCall(chart.setOption)?.[1]).toEqual({ notMerge: true });
  });
});

describe('zoom', () => {
  const hass = (): HomeAssistant => makeHass([entity(TEMP, '21.5', { unit_of_measurement: '°C' })]);

  it('tracks the zoom window, re-reduces after the gesture and keeps it across rebuilds', async () => {
    vi.useFakeTimers({ now: T0, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const el = await mount({ type: 'custom:echart-graph-card', show: { zoom: true }, series: [TEMP] }, hass());
    const chart = lastChart();
    const calls = chart.setOption.mock.calls.length;
    chart.handlers.get('datazoom')?.({ type: 'datazoom', batch: [{ start: 40, end: 60 }] });
    chart.handlers.get('datazoom')?.({ type: 'datazoom', batch: [{ start: 41, end: 61 }] });
    await vi.advanceTimersByTimeAsync(200);
    expect(chart.setOption.mock.calls.length).toBe(calls + 1); // debounced: one rebuild
    expect(lastCall(chart.setOption)?.[1]).toEqual(MERGE);
    expect(buildMock.mock.calls[buildMock.mock.calls.length - 1][3].zoom).toEqual({ start: 41, end: 61 });
    // Theme change (notMerge rebuild) keeps it.
    el.hass = { ...el.hass!, themes: { darkMode: true } };
    await settle(el);
    await vi.advanceTimersByTimeAsync(50);
    expect(buildMock.mock.calls[buildMock.mock.calls.length - 1][3].zoom).toEqual({ start: 41, end: 61 });
    // Zooming back out clears it.
    chart.handlers.get('datazoom')?.({ type: 'datazoom', start: 0, end: 100 });
    await vi.advanceTimersByTimeAsync(200);
    expect(buildMock.mock.calls[buildMock.mock.calls.length - 1][3].zoom).toBeUndefined();
  });

  it('enables wheel zoom only while Ctrl is held', async () => {
    const el = await mount({ type: 'custom:echart-graph-card', show: { zoom: true }, series: [TEMP] }, hass());
    expect(buildMock.mock.calls[buildMock.mock.calls.length - 1][3].zoomModifier).toBe(false);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control', ctrlKey: true }));
    expect(buildMock.mock.calls[buildMock.mock.calls.length - 1][3].zoomModifier).toBe(true);
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Control', ctrlKey: false }));
    expect(buildMock.mock.calls[buildMock.mock.calls.length - 1][3].zoomModifier).toBe(false);
    const builds = buildMock.mock.calls.length;
    el.remove();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control', ctrlKey: true }));
    expect(buildMock.mock.calls.length).toBe(builds); // listeners removed with the card
  });
});

describe('config warnings', () => {
  it('shows unknown options inside the card', async () => {
    const el = await mount({ type: 'custom:echart-graph-card', graph_span: '2h', series: [TEMP] } as CardConfig, makeHass([]));
    expect(q(el, '.alert.warning')?.textContent).toBe('Unknown option "graph_span" is ignored (use span)');
  });
});

// ---------------------------------------------------------------------------
// Header chips
// ---------------------------------------------------------------------------

describe('header chips', () => {
  const hass = (): HomeAssistant =>
    makeHass([
      entity(TEMP, '21.5', { unit_of_measurement: '°C', friendly_name: 'Temperature' }),
      entity(HUM, '48', { unit_of_measurement: '%', friendly_name: 'Humidity' }),
      entity('binary_sensor.window', 'on', { friendly_name: 'Window' }),
    ]);

  it('renders one chip per header series; toggle hides via the legend model', async () => {
    const el = await mount(
      { type: 'custom:echart-graph-card', title: 'Room', series: [{ entity: TEMP, name: 'Temp' }, { entity: HUM, name: 'Hum' }] },
      hass(),
    );
    const chips = qa(el, '.chip');
    expect(chips).toHaveLength(2);
    expect(chips[0].querySelector('.name')?.textContent).toBe('Temp');
    expect(chips[0].querySelector('.chip-value')?.textContent?.trim()).toBe('21.5 °C');
    expect(chips[1].querySelector('.chip-value')?.textContent?.trim()).toBe('48 %');

    const chart = lastChart();
    chips[0].querySelector<HTMLButtonElement>('.chip-toggle')!.click();
    await settle(el);
    expect(chart.dispatchAction).toHaveBeenCalledWith({ type: 'legendUnSelect', name: 'Temp' });
    expect(qa(el, '.chip')[0].classList.contains('off')).toBe(true);
    const ctx = buildMock.mock.calls[buildMock.mock.calls.length - 1][3];
    expect([...(ctx.hiddenKeys ?? [])]).toEqual([`0:${TEMP}`]);
    expect(lastCall(chart.setOption)?.[1]).toEqual(MERGE);

    qa(el, '.chip')[0].querySelector<HTMLButtonElement>('.chip-toggle')!.click();
    await settle(el);
    expect(chart.dispatchAction).toHaveBeenLastCalledWith({ type: 'legendSelect', name: 'Temp' });
    expect(qa(el, '.chip')[0].classList.contains('off')).toBe(false);
  });

  it('syncs visibility from ECharts legend clicks', async () => {
    const el = await mount(
      { type: 'custom:echart-graph-card', show: { legend: true }, series: [{ entity: TEMP, name: 'Temp' }, { entity: HUM, name: 'Hum' }] },
      hass(),
    );
    lastChart().handlers.get('legendselectchanged')?.({ selected: { Temp: true, Hum: false } });
    await settle(el);
    expect(qa(el, '.chip')[1].classList.contains('off')).toBe(true);
  });

  it('maps legend names to series by index when two series share a name', async () => {
    const el = await mount(
      { type: 'custom:echart-graph-card', show: { legend: true }, series: [{ entity: TEMP, name: 'Room' }, { entity: HUM, name: 'Room' }] },
      hass(),
    );
    const chart = lastChart();
    qa(el, '.chip')[1].querySelector<HTMLButtonElement>('.chip-toggle')!.click();
    await settle(el);
    expect(chart.dispatchAction).toHaveBeenCalledWith({ type: 'legendUnSelect', name: 'Room (2)' });
    expect(qa(el, '.chip').map((c) => c.classList.contains('off'))).toEqual([false, true]);
    chart.handlers.get('legendselectchanged')?.({ selected: { Room: false, 'Room (2)': true } });
    await settle(el);
    expect(qa(el, '.chip').map((c) => c.classList.contains('off'))).toEqual([true, false]);
  });

  it('series with hidden: true start dimmed', async () => {
    const el = await mount({ type: 'custom:echart-graph-card', series: [TEMP, { entity: HUM, hidden: true }] }, hass());
    expect(qa(el, '.chip').map((c) => c.classList.contains('off'))).toEqual([false, true]);
  });

  it('tapping a value opens more-info', async () => {
    const el = await mount({ type: 'custom:echart-graph-card', series: [TEMP, HUM] }, hass());
    const seen: unknown[] = [];
    document.addEventListener('hass-more-info', (e) => seen.push((e as CustomEvent).detail), { once: true });
    qa(el, '.chip')[1].querySelector<HTMLButtonElement>('.chip-value')!.click();
    expect(seen).toEqual([{ entityId: HUM }]);
  });

  it('binary series show the state text, not 0/1; show_in_header: false hides chips', async () => {
    const el = await mount(
      {
        type: 'custom:echart-graph-card',
        series: [{ entity: 'binary_sensor.window' }, { entity: TEMP }, { entity: HUM, show_in_header: false }],
      },
      hass(),
    );
    const chips = qa(el, '.chip');
    expect(chips).toHaveLength(2);
    expect(chips[0].querySelector('.chip-value')?.textContent?.trim()).toBe('On');
  });

  it('header_states: false renders only the title', async () => {
    const el = await mount({ type: 'custom:echart-graph-card', title: 'Only title', show: { header_states: false }, series: [TEMP] }, hass());
    expect(qa(el, '.chip')).toHaveLength(0);
    expect(q(el, '.hero')).toBeNull();
    expect(q(el, '.title')?.textContent).toBe('Only title');
  });

  it('extrema badges use the visible window', async () => {
    vi.useFakeTimers({ now: T0, toFake: ['Date'] });
    loadMock.mockImplementation(async (_h, cfg) =>
      cfg.series.map((s) => ({
        series: s,
        points: [
          [T0 - 48 * 3_600_000, 99], // replaced exactly at the window start -> not visible
          [T0 - 24 * 3_600_000, 10],
          [T0 - 12 * 3_600_000, 30],
        ] as Point[],
        unit: '°C',
        name: 'T',
        isBinary: false,
        source: 'history' as const,
      })),
    );
    const el = await mount({ type: 'custom:echart-graph-card', show: { extrema: true }, series: [TEMP] }, hass());
    const text = q(el, '.extrema')?.textContent ?? '';
    expect(text).toContain('↓ 10 °C');
    expect(text).toContain('↑ 30 °C');
    expect(text).toContain('⌀ 20 °C'); // 12h at 10 + 12h at 30
  });
});

describe('value-only chips (show_in_chart: false)', () => {
  const FORECAST = 'sensor.solar_forecast_today';
  const hass = (forecast = '4.8'): HomeAssistant =>
    makeHass([
      entity(TEMP, '21.5', { unit_of_measurement: '°C', friendly_name: 'Temperature' }),
      entity(FORECAST, forecast, { unit_of_measurement: 'kWh', friendly_name: 'Forecast today' }),
    ]);
  const config = (extra: Record<string, unknown> = {}): CardConfig => ({
    type: 'custom:echart-graph-card',
    series: [{ entity: TEMP, name: 'Temp' }, { entity: FORECAST, name: 'Expected', show_in_chart: false, precision: 1, ...extra }],
  });

  it('renders a plain value chip in config order: no dot, no toggle, never struck through', async () => {
    const el = await mount(config({ hidden: true }), hass());
    const chips = qa(el, '.chip');
    expect(chips).toHaveLength(2);
    const v = chips[1];
    expect(v.classList.contains('value-only')).toBe(true);
    expect(v.classList.contains('off')).toBe(false);
    expect(v.querySelector('.chip-toggle')).toBeNull();
    expect(v.querySelector('.dot')).toBeNull();
    expect(v.querySelector('.name')?.textContent).toBe('Expected');
    expect(v.querySelector('.chip-value')?.textContent?.trim()).toBe('4.8 kWh');
    // The drawn series still has its normal toggle chip (no hero layout).
    expect(chips[0].querySelector('.chip-toggle')).not.toBeNull();
    expect(q(el, '.hero')).toBeNull();
  });

  it('is never loaded or drawn', async () => {
    await mount(config(), hass());
    const cfg0 = loadMock.mock.calls[0][1] as NormalizedConfig;
    expect(cfg0.series.map((s) => s.entity)).toEqual([TEMP]);
    const built = buildMock.mock.calls[buildMock.mock.calls.length - 1];
    expect((built[1] as SeriesData[]).map((d) => d.series.entity)).toEqual([TEMP]);
  });

  it('follows the entity live and opens more-info on tap', async () => {
    vi.useFakeTimers({ now: T0 + 60_000, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const hs = hass();
    const el = await mount(config(), hs);
    el.hass = withStates(hs, entity(FORECAST, '5.26', { unit_of_measurement: 'kWh', friendly_name: 'Forecast today' }, T0 + 61_000));
    await vi.advanceTimersByTimeAsync(0);
    await settle(el);
    expect(qa(el, '.chip')[1].querySelector('.chip-value')?.textContent?.trim()).toBe('5.3 kWh');
    const seen: unknown[] = [];
    document.addEventListener('hass-more-info', (e) => seen.push((e as CustomEvent).detail), { once: true });
    qa(el, '.chip')[1].querySelector<HTMLButtonElement>('.chip-value')!.click();
    expect(seen).toEqual([{ entityId: FORECAST }]);
  });

  it('counts as a header chip for the card size', async () => {
    const el = await mount(config(), hass());
    const one = await mount({ type: 'custom:echart-graph-card', series: [TEMP] }, hass());
    expect(el.getCardSize()).toBe(one.getCardSize()); // hero row vs. chip row: both one extra row
  });
});

describe('header helpers', () => {
  it('computeExtrema is time-weighted and window-bounded', () => {
    const pts: Point[] = [
      [0, 100],
      [10, 0],
      [20, null],
      [30, 10],
    ];
    expect(computeExtrema(pts, 10, 40)).toEqual({ min: 0, max: 10, avg: 5 });
    expect(computeExtrema(pts, 5, 40)).toEqual({ min: 0, max: 100, avg: (100 * 5 + 0 * 10 + 10 * 10) / 25 });
    expect(computeExtrema([], 0, 10)).toBeUndefined();
    expect(computeExtrema([[0, null]], 0, 10)).toBeUndefined();
  });

  it('thresholdColor picks the stop at or below the value', () => {
    const stops = [
      { value: 0, color: 'blue' },
      { value: 20, color: 'orange' },
      { value: 30, color: 'red' },
    ];
    expect(thresholdColor(-5, stops)).toBe('blue');
    expect(thresholdColor(20, stops)).toBe('orange');
    expect(thresholdColor(29.9, stops)).toBe('orange');
    expect(thresholdColor(31, stops)).toBe('red');
    expect(thresholdColor(null, stops)).toBeUndefined();
    expect(thresholdColor(5, [])).toBeUndefined();
  });
});
