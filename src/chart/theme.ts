import type { ThemeColors } from '../types';

/**
 * Default series colors, assigned by series index (normalizeConfig). Mid-saturation hues that
 * keep contrast on both light (#fff) and dark (#1c1c1c) card backgrounds, ordered so adjacent
 * series are maximally distinct.
 */
export const DEFAULT_PALETTE: readonly string[] = [
  '#3B82F6', // blue
  '#F59E0B', // amber
  '#10B981', // emerald
  '#EF4444', // red
  '#8B5CF6', // violet
  '#06B6D4', // cyan
  '#EC4899', // pink
  '#84CC16', // lime
  '#F97316', // orange
  '#64748B', // slate
];

/** Fallbacks used when a CSS variable is missing/empty. */
export const FALLBACK_THEME: { light: ThemeColors; dark: ThemeColors } = {
  light: {
    dark: false,
    text: '#212121',
    secondaryText: '#727272',
    divider: 'rgba(0, 0, 0, 0.12)',
    background: '#ffffff',
    primary: '#03a9f4',
    tooltipBackground: 'rgba(255, 255, 255, 0.96)',
    tooltipText: '#212121',
    tooltipBorder: 'rgba(0, 0, 0, 0.12)',
    fontFamily: 'Roboto, Noto, sans-serif',
  },
  dark: {
    dark: true,
    text: '#e1e1e1',
    secondaryText: '#9b9b9b',
    divider: 'rgba(225, 225, 225, 0.12)',
    background: '#1c1c1c',
    primary: '#03a9f4',
    tooltipBackground: 'rgba(40, 40, 40, 0.96)',
    tooltipText: '#e1e1e1',
    tooltipBorder: 'rgba(225, 225, 225, 0.16)',
    fontFamily: 'Roboto, Noto, sans-serif',
  },
};

/**
 * Read HA theme CSS variables via getComputedStyle(el) and map them to ECharts colors.
 * Sources: --primary-text-color, --secondary-text-color, --divider-color,
 * --ha-card-background / --card-background-color, --primary-color,
 * --ha-font-family-body / --paper-font-body1_-_font-family / --mdc-typography-font-family.
 * Tooltip colors derive from background/text/divider. Missing vars fall back to
 * FALLBACK_THEME[dark ? 'dark' : 'light']. Call again when hass.themes.darkMode changes.
 */
export function readTheme(el: HTMLElement, dark: boolean): ThemeColors {
  void el;
  // STUB: returns fallbacks only; the real implementation reads computed CSS variables.
  return { ...(dark ? FALLBACK_THEME.dark : FALLBACK_THEME.light) };
}

/**
 * Resolve a user color to a concrete CSS color ECharts can parse (canvas cannot read CSS vars).
 * `var(--x)` / `var(--x, fallback)` -> computed value of --x on `el` (or the fallback, or
 * `c` unchanged if both are empty). Any other string is returned unchanged.
 */
export function resolveColor(el: HTMLElement, c: string): string {
  void el;
  // STUB: passthrough; the real implementation resolves var(--x).
  return c;
}
