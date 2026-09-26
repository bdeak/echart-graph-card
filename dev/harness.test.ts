/**
 * Self-tests for the dev harness: every examples/*.yaml is valid YAML and a valid card config,
 * and the mock hass speaks the same WebSocket / state protocol as Home Assistant.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeConfig } from '../src/config';
import type { CardConfig, HistoryResponse, HistoryState, StatisticsResponse } from '../src/types';
import { MockHassController } from './mock-hass';
import { DAY, HOUR, MINUTE } from './synth';
import { parseYaml } from './yaml';

// import.meta.url is not a file: URL under happy-dom; dirname is provided by vite-node/vitest.
const examplesDir = join(import.meta.dirname, '..', 'examples') + '/';
const exampleFiles = readdirSync(examplesDir).filter((f) => f.endsWith('.yaml'));
const load = (file: string): CardConfig => parseYaml(readFileSync(examplesDir + file, 'utf8')) as CardConfig;

const mock = (): MockHassController => new MockHassController({ latencyMs: [0, 0] });

describe('examples', () => {
  it('has the documented examples', () => {
    for (const f of ['temperature', 'battery_soc', 'humidity', 'energy_flow', 'water_usage', 'multi_axis']) {
      expect(exampleFiles).toContain(`${f}.yaml`);
    }
  });

  it.each(exampleFiles)('%s parses and normalizes', (file) => {
    const raw = load(file);
    expect(raw.type).toBe('custom:echart-graph-card');
    expect(() => normalizeConfig(raw)).not.toThrow();
  });

  it.each(exampleFiles)('%s only uses entities the mock provides', (file) => {
    const ids = new Set(Object.keys(mock().hass.states));
    for (const s of normalizeConfig(load(file)).series) expect(ids).toContain(s.entity);
  });

  it('energy_flow is a faithful apexcharts port', () => {
    const cfg = normalizeConfig(load('energy_flow.yaml'));
    expect(cfg.spanMs).toBe(2 * HOUR);
    expect(cfg.series.map((s) => [s.name, s.color])).toEqual([
      ['Grid', '#2196F3'],
      ['Solar', '#FFC107'],
      ['Battery', '#4CAF50'],
    ]);
    for (const s of cfg.series) expect(s.groupBy).toEqual({ func: 'avg', durationMs: 30_000 });
    expect(cfg.yAxes[0]).toMatchObject({ unit: 'W', softMin: -3000, softMax: 5000 });
    expect(cfg.thresholds[0]).toMatchObject({ kind: 'line', value: 0, style: 'dashed' });
  });

  it('humidity uses statistics, water uses hourly change', () => {
    expect(normalizeConfig(load('humidity.yaml'))).toMatchObject({ dataSource: 'statistics', statisticsPeriod: 'hour' });
    const water = normalizeConfig(load('water_usage.yaml'));
    expect(water).toMatchObject({ dataSource: 'statistics', statisticsPeriod: 'hour' });
    expect(water.series[0]).toMatchObject({ statistic: 'change', fill: 'solid' });
  });
});

describe('mock hass', () => {
  const now = Date.now();
  const iso = (t: number): string => new Date(t).toISOString();

  it('exposes a realistic hass surface', () => {
    const { hass } = mock();
    expect(hass.config.time_zone).toBe('Europe/Berlin');
    expect(hass.locale).toMatchObject({ language: 'en', time_zone: 'server' });
    expect(hass.themes.darkMode).toBe(false);
    const grid = hass.states['sensor.grid_measured_total_power'];
    expect(grid.attributes).toMatchObject({ unit_of_measurement: 'W', state_class: 'measurement' });
    expect(Date.parse(grid.last_changed)).toBeLessThanOrEqual(Date.parse(grid.last_updated));
    expect(hass.entities?.['sensor.living_room_temperature'].display_precision).toBe(1);
  });

  it('answers history/history_during_period in the compressed format', async () => {
    const { hass } = mock();
    const res = await hass.callWS<HistoryResponse>({
      type: 'history/history_during_period',
      start_time: iso(now - DAY),
      end_time: iso(now),
      entity_ids: ['sensor.outdoor_temperature', 'sensor.batteries_total_power', 'binary_sensor.front_door', 'sensor.nope'],
      minimal_response: true,
      no_attributes: true,
      significant_changes_only: false,
    });
    expect(Object.keys(res)).toEqual(['sensor.outdoor_temperature', 'sensor.batteries_total_power', 'binary_sensor.front_door']);
    const outdoor = res['sensor.outdoor_temperature'];
    expect(outdoor[0]).toMatchObject({ a: {}, lu: Math.round(now - DAY) / 1000 });
    expect(Object.keys(outdoor[1]).sort()).toEqual(['lu', 's']);
    for (let i = 1; i < outdoor.length; i++) {
      expect(outdoor[i].lu).toBeGreaterThan(outdoor[i - 1].lu);
      expect(outdoor[i].s).not.toBe(outdoor[i - 1].s);
    }
    expect(outdoor.some((e) => e.s === 'unavailable')).toBe(true);
    const battery = res['sensor.batteries_total_power'].map((e) => Number(e.s)).filter(Number.isFinite);
    expect(Math.min(...battery)).toBeLessThan(0);
    expect(res['binary_sensor.front_door'].every((e) => e.s === 'on' || e.s === 'off')).toBe(true);
  });

  it('returns attributes when asked (climate setpoint history)', async () => {
    const { hass } = mock();
    const res = await hass.callWS<HistoryResponse>({
      type: 'history/history_during_period',
      start_time: iso(now - DAY),
      end_time: iso(now),
      entity_ids: ['climate.living_room'],
      minimal_response: true,
      no_attributes: false,
      significant_changes_only: false,
    });
    const rows: HistoryState[] = res['climate.living_room'];
    expect(rows.length).toBeGreaterThan(10);
    const setpoints = new Set(rows.map((r) => r.a?.temperature));
    expect(setpoints).toEqual(new Set([19, 21.5]));
    expect(rows.slice(1).some((r) => r.lc !== undefined && r.lc < r.lu)).toBe(true);
  });

  it('answers recorder/statistics_during_period with completed, aligned buckets', async () => {
    const { hass } = mock();
    const res = await hass.callWS<StatisticsResponse>({
      type: 'recorder/statistics_during_period',
      start_time: iso(now - 2 * DAY),
      end_time: iso(now),
      statistic_ids: ['sensor.living_room_humidity', 'sensor.water_meter_total', 'binary_sensor.front_door'],
      period: 'hour',
      types: ['mean', 'min', 'max', 'change', 'sum', 'state'],
    });
    expect(Object.keys(res).sort()).toEqual(['sensor.living_room_humidity', 'sensor.water_meter_total']);
    const hum = res['sensor.living_room_humidity'];
    expect(hum.length).toBeGreaterThanOrEqual(46);
    for (const r of hum) {
      expect(Number(r.start) % HOUR).toBe(0);
      expect(Number(r.end) - Number(r.start)).toBe(HOUR);
      expect(Number(r.end)).toBeLessThanOrEqual(Date.now());
      expect(r.min as number).toBeLessThanOrEqual(r.mean as number);
      expect(r.mean as number).toBeLessThanOrEqual(r.max as number);
    }
    const water = res['sensor.water_meter_total'];
    expect(water.every((r) => (r.change as number) >= 0)).toBe(true);
    expect(water.reduce((s, r) => s + (r.change as number), 0)).toBeGreaterThan(100);
    for (let i = 1; i < water.length; i++) expect(water[i].sum as number).toBeGreaterThanOrEqual(water[i - 1].sum as number);
  });

  it('filters statistics columns by types and supports 5minute / day periods', async () => {
    const { hass } = mock();
    const five = await hass.callWS<StatisticsResponse>({
      type: 'recorder/statistics_during_period',
      start_time: iso(now - 2 * HOUR),
      end_time: iso(now),
      statistic_ids: ['sensor.grid_measured_total_power'],
      period: '5minute',
      types: ['mean'],
    });
    const rows = five['sensor.grid_measured_total_power'];
    expect(rows.length).toBeGreaterThanOrEqual(22);
    expect(Object.keys(rows[0]).sort()).toEqual(['end', 'mean', 'start']);
    expect(Number(rows[0].start) % (5 * MINUTE)).toBe(0);
    const day = await hass.callWS<StatisticsResponse>({
      type: 'recorder/statistics_during_period',
      start_time: iso(now - 10 * DAY),
      end_time: iso(now),
      statistic_ids: ['sensor.outdoor_temperature'],
      period: 'day',
      types: ['mean', 'min', 'max'],
    });
    const days = day['sensor.outdoor_temperature'];
    expect(days.length).toBeGreaterThanOrEqual(8);
    const berlinHour = (ms: number): string =>
      new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms);
    for (const r of days) expect(berlinHour(Number(r.start))).toBe('00:00');
  });

  it('rejects unknown commands like HA', async () => {
    await expect(mock().hass.callWS({ type: 'nope/nope' })).rejects.toMatchObject({ code: 'unknown_command' });
  });

  it('publishes a new hass object with changed states on tick', () => {
    const c = mock();
    const before = c.hass;
    const seen: unknown[] = [];
    c.subscribe((h) => seen.push(h));
    const t = Date.now() + 30_000;
    expect(c.tick(t)).toBe(true);
    const after = c.hass;
    expect(after).not.toBe(before);
    expect(after.states).not.toBe(before.states);
    expect(seen).toEqual([after]);
    const grid = after.states['sensor.grid_measured_total_power'];
    expect(grid).not.toBe(before.states['sensor.grid_measured_total_power']);
    expect(grid.last_updated).toBe(new Date(t).toISOString());
    // The thermostat state ("heat") does not change: same entity object or only last_updated moves.
    const climate = after.states['climate.living_room'];
    expect(climate.last_changed).toBe(before.states['climate.living_room'].last_changed);
  });

  it('toggles themes.darkMode', () => {
    const c = mock();
    c.setDarkMode(true);
    expect(c.hass.themes.darkMode).toBe(true);
  });

  it('keeps big history requests fast', async () => {
    const { hass } = mock();
    const t0 = performance.now();
    await hass.callWS<HistoryResponse>({
      type: 'history/history_during_period',
      start_time: iso(now - DAY),
      end_time: iso(now),
      entity_ids: ['sensor.grid_measured_total_power', 'sensor.growatt_min_3000_tl_x_growatt_pv_power_total', 'sensor.batteries_total_power'],
      minimal_response: true,
      no_attributes: true,
      significant_changes_only: false,
    });
    expect(performance.now() - t0).toBeLessThan(3000);
  });
});

describe('mock hass fidelity', () => {
  it('rejects a history request with a malformed unknown id as a whole, like HA', async () => {
    const { hass } = mock();
    await expect(
      hass.callWS({
        type: 'history/history_during_period',
        start_time: new Date(Date.now() - 3_600_000).toISOString(),
        entity_ids: ['sensor.outdoor_temperature', 'tibber:consumption'],
        minimal_response: true,
        no_attributes: true,
        significant_changes_only: false,
      }),
    ).rejects.toMatchObject({ code: 'invalid_entity_ids' });
  });

  it('formats untranslated states raw, like the frontend', () => {
    const { hass } = mock();
    const cover = { entity_id: 'cover.garage', state: 'open', attributes: {}, last_changed: '', last_updated: '' };
    expect(hass.formatEntityState(cover, 'open')).toBe('Open');
    expect(hass.formatEntityState(cover, 'on')).toBe('on');
  });
});
