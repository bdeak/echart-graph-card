import { notImplemented } from '../stub';
import type { HassLocale, HomeAssistant } from '../types';

/** Locale/timezone-aware time formatters (Intl.DateTimeFormat instances cached inside). */
export interface TimeFormatter {
  /** IANA zone actually used (see resolveTimeZone). */
  readonly timeZone: string;
  /** Whether 12h clock is used (hass.locale.time_format, else language default). */
  readonly hour12: boolean;
  /**
   * Compact x-axis label. spanMs <= 1 day: `HH:mm`; <= 7 days: weekday + `HH:mm` at day
   * boundaries (`HH:mm` otherwise); longer: day + short month.
   */
  axis(ms: number, spanMs: number): string;
  /** Full tooltip header: short date + time with seconds only when < 1 minute resolution matters. */
  tooltip(ms: number): string;
  /** `HH:mm` (or 12h variant). */
  time(ms: number): string;
  /** Short date, e.g. `26.09.` / `9/26`. */
  date(ms: number): string;
}

/**
 * IANA time zone for display: `hass.locale.time_zone === 'server'` -> `hass.config.time_zone`,
 * otherwise the browser zone (`Intl.DateTimeFormat().resolvedOptions().timeZone`).
 */
export function resolveTimeZone(hass: HomeAssistant): string {
  return notImplemented('resolveTimeZone', hass);
}

/** Build formatters for hass.locale.language / time zone / time_format. */
export function makeTimeFormatter(hass: HomeAssistant): TimeFormatter {
  return notImplemented('makeTimeFormatter', hass);
}

/**
 * Decimals when no precision is configured: |v| >= 100 -> 0, >= 10 -> 1, >= 1 -> 1, else 2
 * (trailing zeros are not forced).
 */
export function autoPrecision(v: number): number {
  return notImplemented('autoPrecision', v);
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
  return notImplemented('formatValue', v, unit, precision, locale);
}
