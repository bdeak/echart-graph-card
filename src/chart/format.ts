import { DAY, HOUR, MINUTE, SECOND, WEEK } from '../config';
import type { HassLocale, HomeAssistant } from '../types';

/** Locale/timezone-aware time formatters (Intl.DateTimeFormat instances cached inside). */
export interface TimeFormatter {
  /** IANA zone actually used (see resolveTimeZone). */
  readonly timeZone: string;
  /** Whether 12h clock is used (hass.locale.time_format, else language default). */
  readonly hour12: boolean;
  /**
   * Compact x-axis label for a tick at `ms` on an axis spanning `spanMs`:
   * - spanMs <= 7 days: `HH:mm` (12h: `3 PM` / `3:30 PM`; seconds for sub-minute ticks);
   *   ticks at local midnight show the short weekday instead (`Sat`).
   * - <= 120 days: day + short month at midnight (`26 Sep`), `HH:mm` otherwise.
   * - longer: short month on the 1st (the year in January), day + month otherwise.
   */
  axis(ms: number, spanMs: number): string;
  /**
   * Full tooltip header, e.g. `Sat, 26 Sep, 14:35`. `resolutionMs` (default 1 min) is the data
   * resolution: >= 1 day -> date only (with year); < 1 min -> seconds when they are non-zero.
   */
  tooltip(ms: number, resolutionMs?: number): string;
  /** `HH:mm` (or 12h variant). */
  time(ms: number): string;
  /** Short date, e.g. `26.9.` / `9/26`. */
  date(ms: number): string;
  /** True when `ms` is exactly local midnight in `timeZone` (used to emphasise day ticks). */
  isDayStart(ms: number): boolean;
  /** UTC offset of `timeZone` at `ms` in ms (wall clock = ms + offset). */
  offset(ms: number): number;
}

// ---------------------------------------------------------------------------
// Time zone / locale resolution
// ---------------------------------------------------------------------------

const zoneValidity = new Map<string, boolean>();

function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || tz === '') return false;
  let ok = zoneValidity.get(tz);
  if (ok === undefined) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      ok = true;
    } catch {
      ok = false;
    }
    zoneValidity.set(tz, ok);
  }
  return ok;
}

/** The browser's IANA zone (`UTC` if it cannot be determined). */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/**
 * IANA time zone for display: `hass.locale.time_zone === 'server'` -> `hass.config.time_zone`,
 * otherwise the browser zone (`Intl.DateTimeFormat().resolvedOptions().timeZone`). An explicit
 * valid IANA zone in `hass.locale.time_zone` is honoured too; invalid zones fall back to the
 * browser zone.
 */
export function resolveTimeZone(hass: HomeAssistant): string {
  const setting = hass?.locale?.time_zone;
  if (setting === 'server') {
    const server = hass?.config?.time_zone;
    return isValidTimeZone(server) ? server : browserTimeZone();
  }
  if (setting && setting !== 'local' && setting !== 'system' && isValidTimeZone(setting)) return setting;
  return browserTimeZone();
}

const languageValidity = new Map<string, string>();

/** A BCP 47 tag Intl accepts (falls back to `en`). */
function safeLanguage(lang: string | undefined): string {
  const l = lang && lang.trim() ? lang.trim() : 'en';
  let r = languageValidity.get(l);
  if (r === undefined) {
    try {
      new Intl.DateTimeFormat(l);
      r = l;
    } catch {
      r = 'en';
    }
    languageValidity.set(l, r);
  }
  return r;
}

function languageUses12h(lang: string | undefined): boolean {
  try {
    const o = new Intl.DateTimeFormat(lang, { hour: 'numeric' }).resolvedOptions();
    if (typeof o.hour12 === 'boolean') return o.hour12;
    return o.hourCycle === 'h11' || o.hourCycle === 'h12';
  } catch {
    return false;
  }
}

function resolveHour12(locale: HassLocale | undefined, language: string): boolean {
  switch (locale?.time_format) {
    case '12':
      return true;
    case '24':
      return false;
    case 'system':
      return languageUses12h(undefined);
    default:
      return languageUses12h(language);
  }
}

// ---------------------------------------------------------------------------
// Time formatting
// ---------------------------------------------------------------------------

function mod(a: number, b: number): number {
  return ((a % b) + b) % b;
}

class TimeFormatterImpl implements TimeFormatter {
  readonly timeZone: string;
  readonly hour12: boolean;
  private readonly _hm: Intl.DateTimeFormat;
  private readonly _hms: Intl.DateTimeFormat;
  private readonly _h: Intl.DateTimeFormat;
  private readonly _weekday: Intl.DateTimeFormat;
  private readonly _dayMonth: Intl.DateTimeFormat;
  private readonly _month: Intl.DateTimeFormat;
  private readonly _year: Intl.DateTimeFormat;
  private readonly _date: Intl.DateTimeFormat;
  private readonly _tip: Intl.DateTimeFormat;
  private readonly _tipSec: Intl.DateTimeFormat;
  private readonly _tipDay: Intl.DateTimeFormat;
  private readonly _parts: Intl.DateTimeFormat;
  private readonly _offsets = new Map<number, number>();

  constructor(language: string, timeZone: string, hour12: boolean) {
    this.timeZone = timeZone;
    this.hour12 = hour12;
    const clock: Intl.DateTimeFormatOptions = hour12
      ? { hour: 'numeric', minute: '2-digit', hour12: true }
      : { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
    const f = (o: Intl.DateTimeFormatOptions): Intl.DateTimeFormat => new Intl.DateTimeFormat(language, { ...o, timeZone });
    this._hm = f(clock);
    this._hms = f({ ...clock, second: '2-digit' });
    this._h = f(hour12 ? { hour: 'numeric', hour12: true } : clock);
    this._weekday = f({ weekday: 'short' });
    this._dayMonth = f({ day: 'numeric', month: 'short' });
    this._month = f({ month: 'short' });
    this._year = f({ year: 'numeric' });
    this._date = f({ day: 'numeric', month: 'numeric' });
    this._tip = f({ weekday: 'short', day: 'numeric', month: 'short', ...clock });
    this._tipSec = f({ weekday: 'short', day: 'numeric', month: 'short', ...clock, second: '2-digit' });
    this._tipDay = f({ weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
    this._parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      hourCycle: 'h23',
    });
  }

  offset(ms: number): number {
    // Zone transitions happen on 15-minute UTC boundaries, so cache per quarter hour.
    const key = Math.floor(ms / (15 * MINUTE));
    let off = this._offsets.get(key);
    if (off === undefined) {
      const p: Record<string, number> = {};
      for (const part of this._parts.formatToParts(new Date(ms))) {
        if (part.type !== 'literal') p[part.type] = Number(part.value);
      }
      const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour === 24 ? 0 : p.hour, p.minute, p.second);
      off = wall - (ms - mod(ms, SECOND));
      if (this._offsets.size > 512) this._offsets.clear();
      this._offsets.set(key, off);
    }
    return off;
  }

  isDayStart(ms: number): boolean {
    return mod(ms + this.offset(ms), DAY) === 0;
  }

  time(ms: number): string {
    return this._hm.format(ms);
  }

  date(ms: number): string {
    return this._date.format(ms);
  }

  axis(ms: number, spanMs: number): string {
    const wall = ms + this.offset(ms);
    const midnight = mod(wall, DAY) === 0;
    if (spanMs > 120 * DAY) {
      if (midnight && new Date(wall).getUTCDate() === 1) {
        return new Date(wall).getUTCMonth() === 0 ? this._year.format(ms) : this._month.format(ms);
      }
      return this._dayMonth.format(ms);
    }
    if (spanMs > WEEK) return midnight ? this._dayMonth.format(ms) : this._hm.format(ms);
    if (midnight) return this._weekday.format(ms);
    if (mod(wall, MINUTE) !== 0) return this._hms.format(ms);
    if (this.hour12 && mod(wall, HOUR) === 0) return this._h.format(ms);
    return this._hm.format(ms);
  }

  tooltip(ms: number, resolutionMs: number = MINUTE): string {
    if (resolutionMs >= DAY) return this._tipDay.format(ms);
    if (resolutionMs < MINUTE && mod(ms, MINUTE) !== 0) return this._tipSec.format(ms);
    return this._tip.format(ms);
  }
}

const formatterCache = new Map<string, TimeFormatter>();

/** Build formatters for hass.locale.language / time zone / time_format (cached per combination). */
export function makeTimeFormatter(hass: HomeAssistant): TimeFormatter {
  const language = safeLanguage(hass?.locale?.language ?? hass?.language);
  const timeZone = resolveTimeZone(hass);
  const hour12 = resolveHour12(hass?.locale, language);
  const key = `${language}|${timeZone}|${hour12 ? 12 : 24}`;
  let tf = formatterCache.get(key);
  if (!tf) {
    tf = new TimeFormatterImpl(language, timeZone, hour12);
    formatterCache.set(key, tf);
  }
  return tf;
}

// ---------------------------------------------------------------------------
// Time-zone aware ticks (only needed when the display zone differs from the browser's)
// ---------------------------------------------------------------------------

const TICK_STEPS: readonly number[] = [
  30 * SECOND,
  MINUTE,
  2 * MINUTE,
  5 * MINUTE,
  10 * MINUTE,
  15 * MINUTE,
  30 * MINUTE,
  HOUR,
  2 * HOUR,
  3 * HOUR,
  4 * HOUR,
  6 * HOUR,
  12 * HOUR,
  DAY,
  2 * DAY,
  WEEK,
  2 * WEEK,
  4 * WEEK,
];

/**
 * True when `tf.timeZone` has the browser's UTC offset at both ends of the window, i.e. ECharts'
 * own (browser-local) tick placement already lands on nice wall-clock times.
 */
export function zoneMatchesBrowser(tf: TimeFormatter, start: number, end: number): boolean {
  if (tf.timeZone === browserTimeZone()) return true;
  const browserOffset = (ms: number): number => -new Date(ms).getTimezoneOffset() * MINUTE;
  return tf.offset(start) === browserOffset(start) && tf.offset(end) === browserOffset(end);
}

/**
 * Nice tick positions within [start, end], aligned to wall-clock boundaries of `tf.timeZone`
 * (DST-safe), with at most ~`maxTicks` intervals. Sub-day steps align to the wall clock, day and
 * longer steps to local midnight.
 */
export function timeTicks(tf: TimeFormatter, start: number, end: number, maxTicks = 6): number[] {
  const span = end - start;
  if (!(span > 0)) return [];
  const step = TICK_STEPS.find((s) => span / s <= Math.max(1, maxTicks)) ?? TICK_STEPS[TICK_STEPS.length - 1];
  const toUtc = (wall: number): number => wall - tf.offset(wall - tf.offset(wall));
  const unit = Math.min(step, DAY);
  const ticks: number[] = [];
  let wall = Math.ceil((start + tf.offset(start)) / unit) * unit;
  for (let guard = 0; guard < 1000; guard++, wall += step) {
    const t = toUtc(wall);
    if (t > end) break;
    if (t >= start && (ticks.length === 0 || t > ticks[ticks.length - 1])) ticks.push(t);
  }
  return ticks;
}

// ---------------------------------------------------------------------------
// Numbers / values
// ---------------------------------------------------------------------------

/**
 * Decimals when no precision is configured: |v| >= 100 -> 0, >= 1 -> 1, else 2
 * (trailing zeros are not forced).
 */
export function autoPrecision(v: number): number {
  if (!Number.isFinite(v)) return 0;
  const a = Math.abs(v);
  if (a >= 100) return 0;
  if (a >= 1) return 1;
  return 2;
}

/** Intl locale for `locale.number_format` (undefined = browser default). */
function numberLocale(locale: HassLocale | undefined): string | undefined {
  switch (locale?.number_format as string | undefined) {
    case 'comma_decimal':
    case 'none':
      return 'en-US';
    case 'decimal_comma':
      return 'de-DE';
    case 'space_comma':
      return 'fr-FR';
    case 'quote_decimal':
      return 'de-CH';
    case 'system':
      return undefined;
    default:
      return safeLanguage(locale?.language);
  }
}

const numberCache = new Map<string, Intl.NumberFormat>();

function numberFormatter(locale: HassLocale | undefined, minFd: number, maxFd: number): Intl.NumberFormat {
  const loc = numberLocale(locale);
  const grouping = locale?.number_format !== 'none';
  const key = `${loc ?? ''}|${minFd}|${maxFd}|${grouping ? 1 : 0}`;
  let nf = numberCache.get(key);
  if (!nf) {
    const opts: Intl.NumberFormatOptions = { minimumFractionDigits: minFd, maximumFractionDigits: maxFd, useGrouping: grouping };
    try {
      nf = new Intl.NumberFormat(loc, opts);
    } catch {
      nf = new Intl.NumberFormat('en-US', opts);
    }
    numberCache.set(key, nf);
  }
  return nf;
}

/**
 * Locale-aware number without unit. `decimals` = maximum fraction digits (`fixed` also forces
 * them as the minimum). Values that round to zero print as `0`, never `-0`.
 */
export function formatNumber(v: number, locale: HassLocale | undefined, decimals: number, fixed = false): string {
  const d = Math.max(0, Math.min(20, Math.round(decimals)));
  const x = Math.abs(v) < 0.5 * 10 ** -d ? 0 : v;
  return numberFormatter(locale, fixed ? d : 0, d).format(x);
}

/** Join number and unit like HA does: `°` no space, `%` per language (`50%` / `50 %`), otherwise one space. */
export function withUnit(text: string, unit: string | undefined, language: string | undefined): string {
  if (!unit) return text;
  if (unit === '°') return `${text}${unit}`;
  if (unit === '%') {
    const lang = (language ?? '').toLowerCase().split(/[-_]/)[0];
    return ['cs', 'de', 'fi', 'fr', 'sk', 'sv'].includes(lang) ? `${text} %` : `${text}%`;
  }
  return `${text} ${unit}`;
}

/**
 * Format a value for header/tooltip: `null`/`undefined`/NaN -> `'—'`. Number formatting follows
 * `locale.number_format` (`language` -> locale.language, `system` -> browser default,
 * `comma_decimal` -> en-US, `decimal_comma` -> de-DE, `space_comma` -> fr-FR,
 * `none` -> no grouping) with `precision` fixed decimals, or autoPrecision when undefined.
 * The unit is appended after a space (`21.5 °C`, `230 W`); `%` follows the language
 * convention (no space for English). No unit -> number only.
 */
export function formatValue(
  v: number | null | undefined,
  unit: string | undefined,
  precision: number | undefined,
  locale: HassLocale,
): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
  const text = precision === undefined ? formatNumber(v, locale, autoPrecision(v)) : formatNumber(v, locale, precision, true);
  return withUnit(text, unit, locale?.language);
}

function countDecimals(v: number): number {
  if (Number.isInteger(v)) return 0;
  const s = Math.abs(v).toPrecision(12);
  if (s.includes('e')) return 6;
  const t = s.replace(/0+$/, '');
  const dot = t.indexOf('.');
  return dot < 0 ? 0 : t.length - dot - 1;
}

/**
 * Axis tick label: configured `precision` (fixed), else the tick's own decimals capped at
 * autoPrecision + 1 (`2.25` stays `2.25`; float noise like `0.30000000000000004` becomes `0.3`).
 * `minDecimals` (the decimals of the axis' tick interval) pads every label of an axis to the
 * same number of decimals (`21.5 °C`, `22.0 °C` instead of `22 °C`).
 */
export function formatAxisValue(
  v: number,
  unit: string | undefined,
  precision: number | undefined,
  locale: HassLocale,
  minDecimals?: number,
): string {
  if (!Number.isFinite(v)) return '';
  let text: string;
  if (precision !== undefined) text = formatNumber(v, locale, precision, true);
  else {
    const own = Math.min(countDecimals(v), autoPrecision(v) + 1);
    text = minDecimals ? formatNumber(v, locale, Math.max(own, minDecimals), true) : formatNumber(v, locale, own);
  }
  return withUnit(text, unit, locale?.language);
}
