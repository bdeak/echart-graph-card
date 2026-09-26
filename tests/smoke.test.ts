import { describe, expect, it } from 'vitest';
import { CARD_NAME, CARD_VERSION } from '../src/const';
import { normalizeConfig, parseDuration } from '../src/config';
import { echarts } from '../src/chart/echarts';
import pkg from '../package.json';

describe('smoke', () => {
  it('CARD_VERSION matches package.json', () => {
    expect(CARD_VERSION).toBe(pkg.version);
  });

  it('registers the custom element and card picker entry', async () => {
    await import('../src/index');
    expect(customElements.get(CARD_NAME)).toBeDefined();
    expect(window.customCards?.some((c) => c.type === CARD_NAME)).toBe(true);
  });

  it('renders the card shell after setConfig (decorators + Lit work)', async () => {
    await import('../src/index');
    const el = document.createElement(CARD_NAME);
    el.setConfig({ type: 'custom:echart-graph-card', title: 'T', height: 180, series: ['sensor.temp'] });
    document.body.appendChild(el);
    await el.updateComplete;
    const chart = el.shadowRoot?.querySelector<HTMLElement>('.chart');
    expect(chart?.style.height).toBe('180px');
    expect(el.getCardSize()).toBeGreaterThanOrEqual(2);
    el.remove();
  });

  it('exposes a modular echarts build', () => {
    expect(typeof echarts.init).toBe('function');
  });

  it('parses durations', () => {
    expect(parseDuration('30s')).toBe(30_000);
    expect(parseDuration('1h30m')).toBe(5_400_000);
    expect(parseDuration(24, 3_600_000)).toBe(86_400_000);
    expect(() => parseDuration('soon')).toThrow(/Invalid duration/);
  });

  it('normalizes a minimal config with good defaults', () => {
    const cfg = normalizeConfig({ type: 'custom:echart-graph-card', series: ['sensor.temp'] });
    expect(cfg.spanMs).toBe(86_400_000);
    expect(cfg.dataSource).toBe('history');
    expect(cfg.series[0]).toMatchObject({ entity: 'sensor.temp', key: '0:sensor.temp', fill: 'gradient', yAxis: null });
    expect(cfg.show).toMatchObject({ legend: false, tooltip: true, headerStates: true });
  });

  it('rejects invalid configs with a friendly message', () => {
    expect(() => normalizeConfig({ type: 'x', series: [] })).toThrow(/series must be a non-empty list/);
    expect(() => normalizeConfig({ type: 'x', series: [{ entity: 'sensor.a', y_axis: 'nope' }] })).toThrow(/unknown y-axis "nope"/);
  });
});
