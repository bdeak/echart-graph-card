/**
 * Home Assistant default theme CSS variables (light and dark), applied to :root the way the
 * HA frontend applies themes (inline custom properties on <html>). The card reads these via
 * getComputedStyle, so swapping them here is a realistic theme switch.
 */

const FONT = 'Roboto, Noto, sans-serif';

const COMMON: Record<string, string> = {
  '--primary-color': '#03a9f4',
  '--dark-primary-color': '#0288d1',
  '--light-primary-color': '#b3e5fc',
  '--accent-color': '#ff9800',
  '--rgb-primary-color': '3, 169, 244',
  '--rgb-accent-color': '255, 152, 0',
  '--text-primary-color': '#ffffff',
  '--text-light-primary-color': '#212121',
  '--error-color': '#db4437',
  '--warning-color': '#ffa600',
  '--success-color': '#43a047',
  '--info-color': '#039be5',
  '--ha-card-border-radius': '12px',
  '--ha-card-border-width': '1px',
  '--ha-card-box-shadow': 'none',
  '--ha-font-family-body': FONT,
  '--paper-font-body1_-_font-family': FONT,
  '--mdc-typography-font-family': FONT,
  '--ha-font-size-m': '14px',
  '--ha-font-size-l': '16px',
  '--ha-font-size-xl': '20px',
  '--ha-font-size-2xl': '24px',
  '--ha-font-weight-normal': '400',
  '--ha-font-weight-medium': '500',
  '--ha-font-weight-bold': '600',
  '--mdc-theme-primary': '#03a9f4',
  '--mdc-theme-secondary': '#ff9800',
};

export const HA_LIGHT: Record<string, string> = {
  ...COMMON,
  '--primary-background-color': '#fafafa',
  '--secondary-background-color': '#e5e5e5',
  '--clear-background-color': '#ffffff',
  '--card-background-color': '#ffffff',
  '--primary-text-color': '#212121',
  '--secondary-text-color': '#727272',
  '--disabled-text-color': '#bdbdbd',
  '--divider-color': 'rgba(0, 0, 0, 0.12)',
  '--outline-color': 'rgba(0, 0, 0, 0.12)',
  '--rgb-primary-text-color': '33, 33, 33',
  '--rgb-secondary-text-color': '114, 114, 114',
  '--rgb-card-background-color': '255, 255, 255',
  '--state-icon-color': '#44739e',
  '--paper-item-icon-color': '#44739e',
  '--sidebar-background-color': '#ffffff',
  '--sidebar-text-color': '#212121',
  '--app-header-background-color': '#03a9f4',
  '--app-header-text-color': '#ffffff',
  '--scrollbar-thumb-color': 'rgb(194, 194, 194)',
  '--mdc-theme-surface': '#ffffff',
  '--mdc-theme-on-surface': '#212121',
};

export const HA_DARK: Record<string, string> = {
  ...COMMON,
  '--primary-background-color': '#111111',
  '--secondary-background-color': '#282828',
  '--clear-background-color': '#111111',
  '--card-background-color': '#1c1c1c',
  '--primary-text-color': '#e1e1e1',
  '--secondary-text-color': '#9b9b9b',
  '--disabled-text-color': '#6f6f6f',
  '--divider-color': 'rgba(225, 225, 225, 0.12)',
  '--outline-color': 'rgba(225, 225, 225, 0.12)',
  '--rgb-primary-text-color': '225, 225, 225',
  '--rgb-secondary-text-color': '155, 155, 155',
  '--rgb-card-background-color': '28, 28, 28',
  '--state-icon-color': '#9da0a2',
  '--paper-item-icon-color': '#9da0a2',
  '--sidebar-background-color': '#1c1c1c',
  '--sidebar-text-color': '#e1e1e1',
  '--app-header-background-color': '#101e24',
  '--app-header-text-color': '#e1e1e1',
  '--scrollbar-thumb-color': 'rgb(80, 80, 80)',
  '--mdc-theme-surface': '#1e1e1e',
  '--mdc-theme-on-surface': '#e1e1e1',
};

/** Swap the HA theme variables on :root (document.documentElement). */
export function applyHaTheme(dark: boolean, root: HTMLElement = document.documentElement): void {
  const vars = dark ? HA_DARK : HA_LIGHT;
  const other = dark ? HA_LIGHT : HA_DARK;
  for (const key of Object.keys(other)) if (!(key in vars)) root.style.removeProperty(key);
  for (const [key, value] of Object.entries(vars)) root.style.setProperty(key, value);
  root.style.colorScheme = dark ? 'dark' : 'light';
  root.classList.toggle('dark', dark);
}
