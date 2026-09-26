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

// ---------------------------------------------------------------------------
// Color parsing helpers (pure)
// ---------------------------------------------------------------------------

/** `[r, g, b, a]` with r/g/b in 0..255 and a in 0..1. */
export type RGBA = [number, number, number, number];

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

function channel(s: string, max: number): number {
  const t = s.trim();
  return t.endsWith('%') ? (parseFloat(t) / 100) * max : parseFloat(t);
}

function alphaOf(s: string | undefined): number {
  if (s === undefined || s.trim() === '') return 1;
  const t = s.trim();
  return clamp(t.endsWith('%') ? parseFloat(t) / 100 : parseFloat(t), 0, 1);
}

/** Split `a, b, c / d` or `a b c / d` or `a, b, c, d` into [parts, alpha]. */
function splitArgs(body: string): [string[], string | undefined] | null {
  const [main, slashAlpha] = body.split('/');
  const parts = main.includes(',') ? main.split(',') : main.trim().split(/\s+/);
  const trimmed = parts.map((p) => p.trim()).filter((p) => p !== '');
  if (slashAlpha !== undefined) return trimmed.length === 3 ? [trimmed, slashAlpha] : null;
  if (trimmed.length === 4) return [trimmed.slice(0, 3), trimmed[3]];
  return trimmed.length === 3 ? [trimmed, undefined] : null;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hh = (((h % 360) + 360) % 360) / 360;
  const f = (n: number): number => {
    const k = (n + hh * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return Math.round((l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255);
  };
  return [f(0), f(8), f(4)];
}

/**
 * Parse `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()/rgba()` and `hsl()/hsla()` (comma or
 * space syntax), `transparent`, or a bare `r, g, b` triplet (HA `--rgb-*` variables).
 * Returns null for anything else (named colors, color-mix(), oklch(), ...).
 */
export function parseColor(input: string): RGBA | null {
  const c = input.trim().toLowerCase();
  if (c === 'transparent') return [0, 0, 0, 0];
  if (c.startsWith('#')) {
    const h = c.slice(1);
    if (!/^[0-9a-f]+$/.test(h)) return null;
    if (h.length === 3 || h.length === 4) {
      const v = h.split('').map((x) => parseInt(x + x, 16));
      return [v[0], v[1], v[2], h.length === 4 ? v[3] / 255 : 1];
    }
    if (h.length === 6 || h.length === 8) {
      const v = [0, 2, 4, 6].map((i) => parseInt(h.slice(i, i + 2), 16));
      return [v[0], v[1], v[2], h.length === 8 ? v[3] / 255 : 1];
    }
    return null;
  }
  const fn = /^(rgba?|hsla?)\(([^()]*)\)$/.exec(c);
  if (fn) {
    const args = splitArgs(fn[2]);
    if (!args) return null;
    const [[p0, p1, p2], a] = args;
    let rgb: [number, number, number];
    if (fn[1].startsWith('rgb')) {
      rgb = [channel(p0, 255), channel(p1, 255), channel(p2, 255)];
    } else {
      const s = parseFloat(p1) / 100;
      const l = parseFloat(p2) / 100;
      rgb = hslToRgb(parseFloat(p0), clamp(s, 0, 1), clamp(l, 0, 1));
    }
    const alpha = alphaOf(a);
    if (rgb.some((x) => !Number.isFinite(x)) || !Number.isFinite(alpha)) return null;
    return [Math.round(clamp(rgb[0], 0, 255)), Math.round(clamp(rgb[1], 0, 255)), Math.round(clamp(rgb[2], 0, 255)), alpha];
  }
  const triplet = /^(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})$/.exec(c);
  if (triplet) return [Number(triplet[1]), Number(triplet[2]), Number(triplet[3]), 1];
  return null;
}

/** Serialize RGBA as `rgb()` (opaque) or `rgba()`. */
export function toCss([r, g, b, a]: RGBA): string {
  return a >= 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${Math.round(a * 1000) / 1000})`;
}

/** `c` with its alpha replaced by `alpha`; null when `c` is not parseable. */
export function withAlpha(c: string, alpha: number): string | null {
  const p = parseColor(c);
  return p ? toCss([p[0], p[1], p[2], clamp(alpha, 0, 1)]) : null;
}

/** `c` with its alpha multiplied by `factor`; `c` unchanged when not parseable. */
export function scaleAlpha(c: string, factor: number): string {
  const p = parseColor(c);
  return p ? toCss([p[0], p[1], p[2], clamp(p[3] * factor, 0, 1)]) : c;
}

// ---------------------------------------------------------------------------
// DOM-backed resolution
// ---------------------------------------------------------------------------

const VAR_RE = /^var\(\s*(--[^,\s)]+)\s*(?:,\s*([\s\S]*))?\)$/;
const NAMED_RE = /^[a-z]+$/i;

function styleSource(el: HTMLElement): CSSStyleDeclaration | undefined {
  try {
    return getComputedStyle(el.isConnected ? el : document.documentElement);
  } catch {
    return undefined;
  }
}

function readVar(el: HTMLElement, name: string, cs = styleSource(el)): string {
  return cs ? cs.getPropertyValue(name).trim() : '';
}

let ctx2d: CanvasRenderingContext2D | null | undefined;
const canvasCache = new Map<string, string | null>();

/** Last resort for exotic syntaxes (oklch, color(), lab, ...): paint one pixel and read it back. */
function viaCanvas(value: string): string | null {
  const hit = canvasCache.get(value);
  if (hit !== undefined) return hit;
  if (ctx2d === undefined) {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      ctx2d = canvas.getContext('2d', { willReadFrequently: true });
    } catch {
      ctx2d = null;
    }
  }
  let out: string | null = null;
  if (ctx2d) {
    try {
      const sentinel = '#010203';
      ctx2d.fillStyle = sentinel;
      ctx2d.fillStyle = value;
      if (String(ctx2d.fillStyle) !== sentinel) {
        ctx2d.clearRect(0, 0, 1, 1);
        ctx2d.fillRect(0, 0, 1, 1);
        const d = ctx2d.getImageData(0, 0, 1, 1).data;
        out = toCss([d[0], d[1], d[2], d[3] / 255]);
      }
    } catch {
      out = null;
    }
  }
  if (canvasCache.size > 256) canvasCache.clear();
  canvasCache.set(value, out);
  return out;
}

/**
 * Turn an arbitrary CSS color value into something ECharts/zrender understands:
 * hex/rgb/hsl/named pass through, `r, g, b` triplets become `rgb()`, and functional syntaxes
 * zrender cannot parse (color-mix(), light-dark(), oklch(), ...) are resolved via a probe element
 * in `el`'s scope (respects color-scheme) and, if needed, a 1px canvas. null = not a color.
 */
function normalizeColor(el: HTMLElement, value: string): string | null {
  const v = value.trim();
  if (v === '') return null;
  if (parseColor(v)) {
    return /^\d/.test(v) ? toCss(parseColor(v) as RGBA) : v;
  }
  if (NAMED_RE.test(v)) return v;
  if (typeof document === 'undefined') return null;
  let computed = '';
  try {
    const probe = document.createElement('span');
    probe.style.color = v;
    if (probe.style.color !== '') {
      const host: Node = el.isConnected ? (el.shadowRoot ?? el) : document.body;
      host.appendChild(probe);
      computed = getComputedStyle(probe).color.trim();
      probe.remove();
    }
  } catch {
    computed = '';
  }
  if (computed && parseColor(computed)) return computed;
  return viaCanvas(computed || v);
}

/**
 * Read HA theme CSS variables via getComputedStyle(el) and map them to ECharts colors.
 * Sources: --primary-text-color, --secondary-text-color, --divider-color,
 * --ha-card-background / --card-background-color, --primary-color,
 * --ha-font-family-body / --paper-font-body1_-_font-family / --mdc-typography-font-family.
 * Tooltip colors derive from background/text/divider (the tooltip lives in document.body, outside
 * the theme scope, so everything is resolved to concrete values). Missing/unusable vars fall back
 * to FALLBACK_THEME[dark ? 'dark' : 'light']; a (nearly) transparent card background falls back
 * too, so the tooltip stays readable. Call again when hass.themes.darkMode changes.
 */
export function readTheme(el: HTMLElement, dark: boolean): ThemeColors {
  const fb = dark ? FALLBACK_THEME.dark : FALLBACK_THEME.light;
  const cs = styleSource(el);
  if (!cs) return { ...fb };
  const color = (name: string, fallback: string): string => normalizeColor(el, readVar(el, name, cs)) ?? fallback;
  const opaqueEnough = (name: string): string | null => {
    const c = normalizeColor(el, readVar(el, name, cs));
    if (!c) return null;
    const p = parseColor(c);
    return p && p[3] < 0.5 ? null : c;
  };

  const text = color('--primary-text-color', fb.text);
  const secondaryText = color('--secondary-text-color', fb.secondaryText);
  const divider = color('--divider-color', fb.divider);
  const background = opaqueEnough('--ha-card-background') ?? opaqueEnough('--card-background-color') ?? fb.background;
  const primary = color('--primary-color', fb.primary);
  const fontFamily =
    readVar(el, '--ha-font-family-body', cs) ||
    readVar(el, '--paper-font-body1_-_font-family', cs) ||
    readVar(el, '--mdc-typography-font-family', cs) ||
    fb.fontFamily;

  const bg = parseColor(background);
  return {
    dark,
    text,
    secondaryText,
    divider,
    background,
    primary,
    tooltipBackground: bg ? toCss([bg[0], bg[1], bg[2], 0.96]) : fb.tooltipBackground,
    tooltipText: text,
    tooltipBorder: divider,
    fontFamily,
  };
}

/**
 * Resolve a user color to a concrete CSS color ECharts can parse (canvas cannot read CSS vars).
 * `var(--x)` / `var(--x, fallback)` / bare `--x` -> computed value of --x on `el` (or the
 * fallback, or `c` unchanged if both are empty). HA `--rgb-*` triplets become `rgb()`.
 * hex/rgb/hsl/named colors are returned unchanged; syntaxes zrender cannot parse (oklch(),
 * color-mix(), ...) are normalized to rgb()/rgba() when a DOM is available.
 */
export function resolveColor(el: HTMLElement, c: string): string {
  if (typeof c !== 'string') return c;
  const s = c.trim();
  const m = VAR_RE.exec(s);
  if (m || s.startsWith('--')) {
    const name = m ? m[1] : s;
    const value = readVar(el, name);
    if (value) return normalizeColor(el, value) ?? value;
    if (m && m[2] !== undefined && m[2].trim() !== '') return resolveColor(el, m[2].trim());
    return c;
  }
  if (parseColor(s) || NAMED_RE.test(s)) return s;
  return normalizeColor(el, s) ?? s;
}
