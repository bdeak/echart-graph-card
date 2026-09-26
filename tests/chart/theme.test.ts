import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_PALETTE,
  FALLBACK_THEME,
  parseColor,
  readTheme,
  resolveColor,
  scaleAlpha,
  withAlpha,
} from '../../src/chart/theme';

function host(vars: Record<string, string> = {}): HTMLElement {
  const el = document.createElement('div');
  for (const [k, v] of Object.entries(vars)) el.style.setProperty(k, v);
  document.body.appendChild(el);
  return el;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('palette', () => {
  it('has distinct valid hex colors', () => {
    expect(DEFAULT_PALETTE.length).toBeGreaterThanOrEqual(8);
    expect(new Set(DEFAULT_PALETTE).size).toBe(DEFAULT_PALETTE.length);
    for (const c of DEFAULT_PALETTE) expect(parseColor(c)).not.toBeNull();
  });
});

describe('parseColor / alpha helpers', () => {
  it('parses hex, rgb(a), hsl(a) and triplets', () => {
    expect(parseColor('#03a9f4')).toEqual([3, 169, 244, 1]);
    expect(parseColor('#fff')).toEqual([255, 255, 255, 1]);
    expect(parseColor('#00000080')?.[3]).toBeCloseTo(0.502, 2);
    expect(parseColor('rgb(3, 169, 244)')).toEqual([3, 169, 244, 1]);
    expect(parseColor('rgba(0, 0, 0, .12)')).toEqual([0, 0, 0, 0.12]);
    expect(parseColor('rgb(3 169 244 / 50%)')).toEqual([3, 169, 244, 0.5]);
    expect(parseColor('hsl(0, 100%, 50%)')).toEqual([255, 0, 0, 1]);
    expect(parseColor('hsla(120 100% 25% / 0.5)')).toEqual([0, 128, 0, 0.5]);
    expect(parseColor('3, 169, 244')).toEqual([3, 169, 244, 1]);
    expect(parseColor('transparent')).toEqual([0, 0, 0, 0]);
    expect(parseColor('red')).toBeNull();
    expect(parseColor('color-mix(in srgb, red, blue)')).toBeNull();
  });

  it('withAlpha / scaleAlpha', () => {
    expect(withAlpha('#ff0000', 0.35)).toBe('rgba(255, 0, 0, 0.35)');
    expect(withAlpha('rgba(0,0,0,.5)', 1)).toBe('rgb(0, 0, 0)');
    expect(withAlpha('red', 0.5)).toBeNull();
    expect(scaleAlpha('rgba(0, 0, 0, 0.5)', 0.5)).toBe('rgba(0, 0, 0, 0.25)');
    expect(scaleAlpha('red', 0.5)).toBe('red');
  });
});

describe('resolveColor', () => {
  it('passes plain colors through unchanged', () => {
    const el = host();
    expect(resolveColor(el, '#4caf50')).toBe('#4caf50');
    expect(resolveColor(el, 'rgb(1, 2, 3)')).toBe('rgb(1, 2, 3)');
    expect(resolveColor(el, 'hsl(10, 50%, 50%)')).toBe('hsl(10, 50%, 50%)');
    expect(resolveColor(el, 'tomato')).toBe('tomato');
  });

  it('resolves var(--x), bare --x and fallbacks', () => {
    const el = host({ '--accent': '#ff9800', '--rgb-primary-color': '3, 169, 244' });
    expect(resolveColor(el, 'var(--accent)')).toBe('#ff9800');
    expect(resolveColor(el, '--accent')).toBe('#ff9800');
    expect(resolveColor(el, 'var(--missing, #123456)')).toBe('#123456');
    expect(resolveColor(el, 'var(--missing, var(--accent))')).toBe('#ff9800');
    expect(resolveColor(el, 'var(--missing)')).toBe('var(--missing)');
    expect(resolveColor(el, 'var(--rgb-primary-color)')).toBe('rgb(3, 169, 244)');
  });
});

describe('readTheme', () => {
  it('returns the fallbacks when no theme variables are set', () => {
    const el = host();
    expect(readTheme(el, false)).toEqual({ ...FALLBACK_THEME.light, tooltipBackground: 'rgba(255, 255, 255, 0.96)' });
    expect(readTheme(el, true).dark).toBe(true);
    expect(readTheme(el, true).background).toBe(FALLBACK_THEME.dark.background);
  });

  it('reads HA theme variables', () => {
    const el = host({
      '--primary-text-color': '#e1e1e1',
      '--secondary-text-color': '#9b9b9b',
      '--divider-color': 'rgba(225, 225, 225, 0.12)',
      '--ha-card-background': '#1c1c1c',
      '--primary-color': '#ff9800',
      '--ha-font-family-body': 'Inter, sans-serif',
    });
    const t = readTheme(el, true);
    expect(t).toMatchObject({
      dark: true,
      text: '#e1e1e1',
      secondaryText: '#9b9b9b',
      divider: 'rgba(225, 225, 225, 0.12)',
      background: '#1c1c1c',
      primary: '#ff9800',
      fontFamily: 'Inter, sans-serif',
      tooltipText: '#e1e1e1',
      tooltipBorder: 'rgba(225, 225, 225, 0.12)',
      tooltipBackground: 'rgba(28, 28, 28, 0.96)',
    });
  });

  it('prefers --ha-card-background, then --card-background-color, skipping transparent ones', () => {
    expect(readTheme(host({ '--card-background-color': '#fafafa' }), false).background).toBe('#fafafa');
    expect(readTheme(host({ '--ha-card-background': 'rgba(0, 0, 0, 0)', '--card-background-color': '#fafafa' }), false).background).toBe(
      '#fafafa',
    );
    expect(readTheme(host({ '--ha-card-background': 'transparent' }), true).background).toBe(FALLBACK_THEME.dark.background);
  });
});
