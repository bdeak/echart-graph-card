import { describe, expect, it } from 'vitest';
import {
  autoPrecision,
  browserTimeZone,
  formatAxisValue,
  formatNumber,
  formatValue,
  makeTimeFormatter,
  resolveTimeZone,
  timeTicks,
  withUnit,
  zoneMatchesBrowser,
} from '../../src/chart/format';
import { DAY, HOUR, MINUTE } from '../../src/config';
import type { HassLocale, HomeAssistant } from '../../src/types';

function mockHass(locale: Partial<HassLocale> = {}, serverTz = 'Europe/Berlin'): HomeAssistant {
  return {
    states: {},
    callWS: async () => ({}) as never,
    connection: { subscribeMessage: async () => async () => undefined },
    locale: { language: 'en', time_zone: 'server', number_format: 'language', time_format: '24', ...locale },
    config: { time_zone: serverTz },
    themes: { darkMode: false },
  };
}

const EN: HassLocale = { language: 'en', time_zone: 'local', number_format: 'language' };
const DE: HassLocale = { language: 'de', time_zone: 'local', number_format: 'language' };

/** 2026-09-26 12:00:00 UTC (a Saturday; Berlin is UTC+2 then). */
const NOON_UTC = Date.UTC(2026, 8, 26, 12, 0, 0);
/** Another zone guaranteed to differ from the test machine's zone. */
const OTHER_TZ = browserTimeZone() === 'Asia/Kolkata' ? 'America/St_Johns' : 'Asia/Kolkata';

describe('resolveTimeZone', () => {
  it('uses the server zone for time_zone: server', () => {
    expect(resolveTimeZone(mockHass({ time_zone: 'server' }, 'America/New_York'))).toBe('America/New_York');
  });

  it('uses the browser zone for local (and unknown settings)', () => {
    expect(resolveTimeZone(mockHass({ time_zone: 'local' }, 'America/New_York'))).toBe(browserTimeZone());
    expect(resolveTimeZone(mockHass({ time_zone: 'nonsense/zone' }, 'America/New_York'))).toBe(browserTimeZone());
  });

  it('falls back to the browser zone when the server zone is invalid', () => {
    expect(resolveTimeZone(mockHass({ time_zone: 'server' }, 'Not/AZone'))).toBe(browserTimeZone());
  });
});

describe('makeTimeFormatter', () => {
  it('formats in the resolved zone', () => {
    expect(makeTimeFormatter(mockHass({}, 'Europe/Berlin')).time(NOON_UTC)).toBe('14:00');
    expect(makeTimeFormatter(mockHass({}, 'UTC')).time(NOON_UTC)).toBe('12:00');
    expect(makeTimeFormatter(mockHass({}, 'America/New_York')).time(NOON_UTC)).toBe('08:00');
  });

  it('honours 12/24h settings and the language default', () => {
    const t12 = makeTimeFormatter(mockHass({ time_format: '12' }, 'UTC'));
    expect(t12.hour12).toBe(true);
    expect(t12.time(NOON_UTC + 2 * HOUR + 5 * MINUTE)).toMatch(/^2:05\sPM$/);
    expect(makeTimeFormatter(mockHass({ language: 'en-US', time_format: 'language' }, 'UTC')).hour12).toBe(true);
    expect(makeTimeFormatter(mockHass({ language: 'de', time_format: 'language' }, 'UTC')).hour12).toBe(false);
    expect(makeTimeFormatter(mockHass({ time_format: '24' }, 'UTC')).time(Date.UTC(2026, 0, 1, 0, 0))).toBe('00:00');
  });

  it('caches formatters per language/zone/clock', () => {
    expect(makeTimeFormatter(mockHass())).toBe(makeTimeFormatter(mockHass()));
  });

  it('computes zone offsets and local midnight (DST aware)', () => {
    const tf = makeTimeFormatter(mockHass({}, 'Europe/Berlin'));
    expect(tf.offset(NOON_UTC)).toBe(2 * HOUR);
    expect(tf.offset(Date.UTC(2026, 11, 1))).toBe(HOUR);
    expect(tf.isDayStart(Date.UTC(2026, 8, 25, 22))).toBe(true); // 00:00 CEST
    expect(tf.isDayStart(Date.UTC(2026, 11, 1, 23))).toBe(true); // 00:00 CET
    expect(tf.isDayStart(Date.UTC(2026, 8, 26, 0))).toBe(false);
  });

  it('builds compact axis labels by span', () => {
    const tf = makeTimeFormatter(mockHass({ language: 'en-GB' }, 'Europe/Berlin'));
    const berlinMidnight = Date.UTC(2026, 8, 25, 22); // Sat 26 Sep 00:00 local
    expect(tf.axis(NOON_UTC, DAY)).toBe('14:00');
    expect(tf.axis(berlinMidnight, DAY)).toBe('Sat');
    expect(tf.axis(berlinMidnight, 3 * DAY)).toBe('Sat');
    expect(tf.axis(NOON_UTC + 30 * 1000, HOUR)).toBe('14:00:30');
    expect(tf.axis(berlinMidnight, 30 * DAY)).toBe('26 Sept');
    expect(tf.axis(NOON_UTC, 30 * DAY)).toBe('14:00');
    expect(tf.axis(Date.UTC(2026, 9, 31, 23), 365 * DAY)).toBe('Nov'); // 1 Nov 00:00 CET
    expect(tf.axis(Date.UTC(2026, 11, 31, 23), 365 * DAY)).toBe('2027'); // 1 Jan
    const us = makeTimeFormatter(mockHass({ language: 'en-US', time_format: '12' }, 'UTC'));
    expect(us.axis(NOON_UTC + 3 * HOUR, DAY)).toMatch(/^3\sPM$/);
    expect(us.axis(NOON_UTC + 3 * HOUR + 30 * MINUTE, DAY)).toMatch(/^3:30\sPM$/);
  });

  it('builds tooltip headers with seconds / date only depending on resolution', () => {
    const tf = makeTimeFormatter(mockHass({ language: 'en-GB' }, 'Europe/Berlin'));
    const header = tf.tooltip(NOON_UTC);
    expect(header).toContain('Sat');
    expect(header).toContain('26 Sept');
    expect(header).toContain('14:00');
    expect(tf.tooltip(NOON_UTC + 12_000, 1000)).toContain('14:00:12');
    expect(tf.tooltip(NOON_UTC + 12_000, MINUTE)).not.toContain(':12');
    const daily = tf.tooltip(NOON_UTC, DAY);
    expect(daily).toContain('2026');
    expect(daily).not.toContain('14:00');
    expect(makeTimeFormatter(mockHass({ language: 'de' }, 'Europe/Berlin')).tooltip(NOON_UTC)).toMatch(/Sa\.,? 26\. Sept?\.?,? 14:00/);
  });
});

describe('zone-aware ticks', () => {
  it('detects when the display zone matches the browser', () => {
    const local = makeTimeFormatter(mockHass({ time_zone: 'local' }));
    expect(zoneMatchesBrowser(local, NOON_UTC - DAY, NOON_UTC)).toBe(true);
    const other = makeTimeFormatter(mockHass({ time_zone: 'server' }, OTHER_TZ));
    expect(zoneMatchesBrowser(other, NOON_UTC - DAY, NOON_UTC)).toBe(false);
  });

  it('places ticks on wall-clock boundaries of the display zone', () => {
    const tf = makeTimeFormatter(mockHass({}, 'Asia/Kolkata'));
    const end = NOON_UTC + 17 * MINUTE;
    const ticks = timeTicks(tf, end - DAY, end, 6);
    expect(ticks.length).toBeGreaterThanOrEqual(5);
    expect(ticks.length).toBeLessThanOrEqual(7);
    for (const t of ticks) {
      const wall = t + tf.offset(t);
      expect(wall % (4 * HOUR)).toBe(0);
      expect(t).toBeGreaterThanOrEqual(end - DAY);
      expect(t).toBeLessThanOrEqual(end);
    }
  });

  it('uses local midnights for multi-day windows and survives DST changes', () => {
    const tf = makeTimeFormatter(mockHass({}, 'Europe/Berlin'));
    const end = Date.UTC(2026, 2, 31, 10); // spans the 29 Mar 2026 DST switch
    const ticks = timeTicks(tf, end - 7 * DAY, end, 7);
    expect(ticks.length).toBe(7);
    for (const t of ticks) expect(tf.isDayStart(t)).toBe(true);
    for (let i = 1; i < ticks.length; i++) expect(ticks[i]).toBeGreaterThan(ticks[i - 1]);
  });
});

describe('numbers', () => {
  it('formatAxisValue pads labels to the axis decimals but never drops a tick\'s own digits', () => {
    const en: HassLocale = { language: 'en', number_format: 'language', time_zone: 'local' };
    expect(formatAxisValue(22, '°C', undefined, en, 1)).toBe('22.0 °C');
    expect(formatAxisValue(22.5, '°C', undefined, en, 1)).toBe('22.5 °C');
    expect(formatAxisValue(22.25, '°C', undefined, en, 1)).toBe('22.25 °C');
    expect(formatAxisValue(22, '°C', undefined, en, 0)).toBe('22 °C');
    expect(formatAxisValue(22, '°C', 2, en, 1)).toBe('22.00 °C'); // explicit precision wins
  });

  it('autoPrecision', () => {
    expect(autoPrecision(1234)).toBe(0);
    expect(autoPrecision(100)).toBe(0);
    expect(autoPrecision(-250)).toBe(0);
    expect(autoPrecision(21.53)).toBe(1);
    expect(autoPrecision(1)).toBe(1);
    expect(autoPrecision(0.123)).toBe(2);
    expect(autoPrecision(0)).toBe(2);
    expect(autoPrecision(NaN)).toBe(0);
  });

  it('formatValue with auto precision and units', () => {
    expect(formatValue(21.53, '°C', undefined, EN)).toBe('21.5 °C');
    expect(formatValue(21, '°C', undefined, EN)).toBe('21 °C');
    expect(formatValue(1234.5, 'W', undefined, EN)).toBe('1,235 W');
    expect(formatValue(1234.5, 'W', undefined, DE)).toBe('1.235 W');
    expect(formatValue(0.123, 'kWh', undefined, EN)).toBe('0.12 kWh');
    expect(formatValue(42, undefined, undefined, EN)).toBe('42');
  });

  it('formatValue with fixed precision', () => {
    expect(formatValue(21.5, '°C', 2, EN)).toBe('21.50 °C');
    expect(formatValue(21.46, '°C', 0, EN)).toBe('21 °C');
    expect(formatValue(21.46, '°C', 1, DE)).toBe('21,5 °C');
  });

  it('formatValue percent spacing follows the language', () => {
    expect(formatValue(50, '%', 0, EN)).toBe('50%');
    expect(formatValue(50, '%', 0, DE)).toBe('50 %');
    expect(withUnit('270', '°', 'en')).toBe('270°');
  });

  it('formatValue number_format variants', () => {
    expect(formatValue(1234.56, undefined, 1, { ...EN, number_format: 'decimal_comma' })).toBe('1.234,6');
    expect(formatValue(1234.56, undefined, 1, { ...DE, number_format: 'comma_decimal' })).toBe('1,234.6');
    expect(formatValue(1234.56, undefined, 1, { ...EN, number_format: 'none' })).toBe('1234.6');
    expect(formatValue(1234.56, undefined, 1, { ...EN, number_format: 'space_comma' })).toMatch(/^1\s234,6$/u);
  });

  it('formatValue handles missing values and negative zero', () => {
    expect(formatValue(null, 'W', undefined, EN)).toBe('—');
    expect(formatValue(undefined, 'W', undefined, EN)).toBe('—');
    expect(formatValue(NaN, 'W', undefined, EN)).toBe('—');
    expect(formatValue(-0.001, 'W', 1, EN)).toBe('0.0 W');
    expect(formatNumber(-0.2, EN, 0)).toBe('0');
    expect(formatValue(-3.21, 'W', undefined, EN)).toBe('-3.2 W');
  });

  it('formatAxisValue keeps tick decimals but trims float noise', () => {
    expect(formatAxisValue(2.25, 'kWh', undefined, EN)).toBe('2.25 kWh');
    expect(formatAxisValue(0.30000000000000004, undefined, undefined, EN)).toBe('0.3');
    expect(formatAxisValue(1500, 'W', undefined, EN)).toBe('1,500 W');
    expect(formatAxisValue(20, '°C', undefined, EN)).toBe('20 °C');
    expect(formatAxisValue(20, '°C', 1, EN)).toBe('20.0 °C');
    expect(formatAxisValue(23.4712, '°C', undefined, EN)).toBe('23.47 °C');
  });
});
