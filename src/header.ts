import { css, html, nothing } from 'lit';
import type { TemplateResult } from 'lit';
import { styleMap } from 'lit/directives/style-map.js';
import { formatValue } from './chart/format';
import { isBinaryEntity, seriesValue } from './data/history';
import { windowExtrema } from './data/reduce';
import { transformValue } from './data/transform';
import type {
  ColorThreshold,
  HassEntityState,
  HomeAssistant,
  NormalizedConfig,
  NormalizedSeries,
  Point,
  SeriesData,
  ThemeColors,
} from './types';

/** Interaction hooks for header chips (they double as the legend when show.legend is off). */
export interface HeaderOptions {
  /** Series keys currently hidden. Default: series with `hidden: true`. */
  hiddenKeys?: ReadonlySet<string>;
  /** Called with series.key when a chip's dot/name is clicked/activated (toggle visibility). */
  onToggle?: (key: string) => void;
  /**
   * Called with the entity id when a chip value is tapped. Default: fire the standard
   * `hass-more-info` event (bubbles + composed) from the clicked element.
   */
  onMoreInfo?: (entityId: string) => void;
  /** Epoch ms used as the right edge of the window for extrema. Default Date.now(). */
  now?: number;
  /** Epoch ms of the window start (extrema). Default `now - cfg.spanMs`. */
  start?: number;
}

/** Optional formatters present on modern `hass` objects (not part of the shared contract). */
interface HassFormatters {
  formatEntityState?: (stateObj: HassEntityState, state?: string) => string;
  formatEntityAttributeValue?: (stateObj: HassEntityState, attribute: string, value?: unknown) => string;
}

export interface Extrema {
  min: number;
  max: number;
  avg: number;
}

/** Everything a chip needs, resolved once per render. */
interface ChipModel {
  series: NormalizedSeries;
  entityId: string;
  /** Entity is in hass.states (more-info makes sense). */
  known: boolean;
  name: string;
  /** Formatted value incl. unit (or the state text). */
  text: string;
  /** Formatted number only (hero); unit rendered separately. */
  number: string;
  /** Unit rendered next to `number` (undefined for text states). */
  heroUnit?: string;
  color: string;
  hidden: boolean;
  extrema?: { min: string; max: string; avg: string };
}

/** Fire an HA frontend event (same shape as custom-card-helpers' fireEvent). */
export function fireEvent(node: EventTarget, type: string, detail: unknown): void {
  node.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
}

/** Color of the ColorThreshold stop that applies to `v` (stops sorted ascending). */
export function thresholdColor(v: number | null | undefined, stops: readonly ColorThreshold[]): string | undefined {
  if (v === null || v === undefined || !Number.isFinite(v) || stops.length === 0) return undefined;
  let color = stops[0].color;
  for (const s of stops) {
    if (v >= s.value) color = s.color;
    else break;
  }
  return color;
}

/**
 * Min / max / time-weighted average of the non-null values visible in [start, end].
 * Each value holds until the next point (sample-and-hold), the last one until `end`.
 * Reference implementation (full scan); the header uses the cached windowExtrema.
 */
export function computeExtrema(points: readonly Point[], start: number, end: number): Extrema | undefined {
  let min = Infinity;
  let max = -Infinity;
  let weighted = 0;
  let weight = 0;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < points.length; i++) {
    const [t, v] = points[i];
    if (t > end) break;
    const nextT = i + 1 < points.length ? Math.min(points[i + 1][0], end) : end;
    // Skip nulls and values that were replaced before the window starts.
    if (v === null || !Number.isFinite(v) || (t < start && nextT <= start)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
    count++;
    const span = nextT - Math.max(t, start);
    if (span > 0) {
      weighted += v * span;
      weight += span;
    }
  }
  if (count === 0) return undefined;
  return { min, max, avg: weight > 0 ? weighted / weight : sum / count };
}

/** Block length of the extrema cache: ~256 blocks per window, at least 1 s. */
function extremaBlockMs(spanMs: number): number {
  return Math.max(1000, Math.ceil(spanMs / 256));
}

function humanizeState(s: string): string {
  const t = s.replace(/_/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function isNumericLike(v: unknown): boolean {
  if (typeof v === 'number') return Number.isFinite(v);
  return typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v));
}

/** Value of the point at or before `t` (the bucket / list item covering it). */
function pointValueAt(points: readonly Point[], t: number): number | null | undefined {
  let v: number | null | undefined;
  for (const p of points) {
    if (p[0] > t) break;
    v = p[1];
  }
  return v;
}

function buildChip(
  series: NormalizedSeries,
  d: SeriesData | undefined,
  hass: HomeAssistant,
  cfg: NormalizedConfig,
  hidden: boolean,
  now: number,
  start: number,
): ChipModel {
  const entityId = series.entity;
  const st: HassEntityState | undefined = hass.states[entityId];
  const attr = series.attribute;
  const fmt = hass as HomeAssistant & HassFormatters;

  const name = d?.name ?? series.name ?? st?.attributes.friendly_name ?? entityId;
  const unit = d?.unit ?? series.unit ?? (attr ? undefined : st?.attributes.unit_of_measurement);
  const precision = series.precision ?? (attr ? undefined : hass.entities?.[entityId]?.display_precision);

  let value: number | null | undefined;
  let text: string;
  let number: string;
  let heroUnit: string | undefined;

  if (series.valueKey !== undefined) {
    // List attribute: the item covering now (the attribute itself is a list, not a value).
    value = st ? (d ? (pointValueAt(d.points, now) ?? null) : null) : undefined;
    text = formatValue(value, unit, precision, hass.locale);
    number = formatValue(value, undefined, precision, hass.locale);
    heroUnit = value === null || value === undefined ? undefined : unit;
  } else if (!st) {
    // External statistic (`source:id`) or unknown entity: use the loader's value if any.
    value = d?.latest;
    text = formatValue(value, unit, precision, hass.locale);
    number = formatValue(value, undefined, precision, hass.locale);
    heroUnit = value === null || value === undefined ? undefined : unit;
  } else {
    const rawValue: unknown = attr ? st.attributes[attr] : st.state;
    const binary = d?.isBinary ?? isBinaryEntity(entityId, st, attr);
    const numeric = seriesValue(entityId, rawValue, attr);
    value = numeric === null ? null : transformValue(numeric, series.transform);
    if (value !== null && !binary && isNumericLike(rawValue)) {
      text = formatValue(value, unit, precision, hass.locale);
      number = formatValue(value, undefined, precision, hass.locale);
      heroUnit = unit;
    } else {
      // Binary / text / unavailable: show the (localized) state rather than 0/1.
      const raw = rawValue === undefined || rawValue === null ? '' : String(rawValue);
      const localized = attr ? fmt.formatEntityAttributeValue?.(st, attr) : fmt.formatEntityState?.(st);
      text = raw === '' ? '—' : (localized ?? humanizeState(raw));
      number = text;
      heroUnit = undefined;
    }
  }

  let extrema: ChipModel['extrema'];
  if (cfg.show.extrema && d && d.points.length > 0 && !d.isBinary) {
    // Cached per points array: repeated renders of a live series only rescan its edges.
    const e = windowExtrema(d.points, start, now, extremaBlockMs(cfg.spanMs));
    if (e) {
      extrema = {
        min: formatValue(e.min, unit, precision, hass.locale),
        max: formatValue(e.max, unit, precision, hass.locale),
        avg: formatValue(e.avg, unit, precision, hass.locale),
      };
    }
  }

  return {
    series,
    entityId,
    known: st !== undefined,
    name,
    text,
    number,
    heroUnit,
    color: thresholdColor(value, series.colorThresholds) ?? series.color,
    hidden,
    extrema,
  };
}

function moreInfoHandler(entityId: string, opts: HeaderOptions): (ev: Event) => void {
  return (ev: Event) => {
    ev.stopPropagation();
    if (opts.onMoreInfo) opts.onMoreInfo(entityId);
    else if (ev.currentTarget) fireEvent(ev.currentTarget, 'hass-more-info', { entityId });
  };
}

function renderExtrema(e: NonNullable<ChipModel['extrema']>, cls: string): TemplateResult {
  return html`<span class=${cls}
    ><span title="Minimum">↓ ${e.min}</span><span title="Maximum">↑ ${e.max}</span><span title="Average">⌀ ${e.avg}</span></span
  >`;
}

function renderHero(cfg: NormalizedConfig, chip: ChipModel, opts: HeaderOptions): TemplateResult {
  const showName = !cfg.title || cfg.title !== chip.name;
  const value = html`<span class="hero-number">${chip.number}</span>${chip.heroUnit
      ? html`<span class="hero-unit">${chip.heroUnit}</span>`
      : nothing}`;
  const tip = `${chip.name}: ${chip.text}`;
  return html`
    <div class="header hero" style=${styleMap({ '--chip-color': chip.color })}>
      <div class="hero-titles">
        ${cfg.title ? html`<div class="title">${cfg.title}</div>` : nothing}
        ${showName ? html`<div class=${cfg.title ? 'subtitle' : 'title name-title'}>${chip.name}</div>` : nothing}
      </div>
      <div class="hero-right">
        ${chip.known
          ? html`<button class="hero-value" title=${tip} @click=${moreInfoHandler(chip.entityId, opts)}>${value}</button>`
          : html`<span class="hero-value" title=${tip}>${value}</span>`}
        ${chip.extrema ? renderExtrema(chip.extrema, 'extrema') : nothing}
      </div>
    </div>
  `;
}

function renderChip(chip: ChipModel, opts: HeaderOptions): TemplateResult {
  const toggle = (ev: Event): void => {
    ev.stopPropagation();
    opts.onToggle?.(chip.series.key);
  };
  const tip = `${chip.name}: ${chip.text}`;
  const valueContent = html`${chip.text}${chip.extrema ? renderExtrema(chip.extrema, 'chip-ext') : nothing}`;
  return html`
    <div class="chip ${chip.hidden ? 'off' : ''}" data-key=${chip.series.key} style=${styleMap({ '--chip-color': chip.color })}>
      <button
        class="chip-toggle"
        aria-pressed=${chip.hidden ? 'false' : 'true'}
        title=${chip.hidden ? `Show ${chip.name}` : `Hide ${chip.name}`}
        @click=${toggle}
      >
        <span class="dot"></span><span class="name">${chip.name}</span>
      </button>
      ${chip.known
        ? html`<button class="chip-value" title=${tip} @click=${moreInfoHandler(chip.entityId, opts)}>${valueContent}</button>`
        : html`<span class="chip-value" title=${tip}>${valueContent}</span>`}
    </div>
  `;
}

/**
 * Card header: optional title, then (when cfg.show.headerStates) one chip per series with
 * `showInHeader`: color dot (series.color, CSS vars work natively here; the active
 * color_thresholds stop when defined), name, and the current value via
 * formatValue(value, unit, precision ?? display_precision, hass.locale).
 * The value is read from hass.states on every render (so it is current in every update
 * mode), transform applied; binary / text / unavailable states show the (localized) state.
 * A single chip renders as a large "hero" value next to the title. Hidden series render dimmed.
 * When cfg.show.extrema, each chip adds min / max / avg of its visible-window points.
 * Chips are buttons (keyboard accessible): dot+name calls opts.onToggle(series.key), the
 * value opens more-info (`hass-more-info`).
 * Returns an empty template when there is neither a title nor chips.
 */
export function renderHeader(
  cfg: NormalizedConfig,
  data: SeriesData[],
  theme: ThemeColors,
  hass: HomeAssistant,
  opts: HeaderOptions = {},
): TemplateResult {
  void theme; // Colors come from HA CSS variables directly; kept for API symmetry.
  const hiddenKeys = opts.hiddenKeys ?? new Set(cfg.series.filter((s) => s.hidden).map((s) => s.key));
  const now = opts.now ?? Date.now();
  const start = opts.start ?? now - cfg.spanMs;

  const chips: ChipModel[] = cfg.show.headerStates
    ? cfg.series
        .filter((s) => s.showInHeader)
        .map((s) => {
          const d = data[s.index]?.series.key === s.key ? data[s.index] : undefined;
          return buildChip(s, d, hass, cfg, hiddenKeys.has(s.key), now, start);
        })
    : [];

  if (chips.length === 1) return renderHero(cfg, chips[0], opts);
  if (!cfg.title && chips.length === 0) return html``;

  return html`
    <div class="header">
      ${cfg.title ? html`<div class="title">${cfg.title}</div>` : nothing}
      ${chips.length ? html`<div class="chips">${chips.map((c) => renderChip(c, opts))}</div>` : nothing}
    </div>
  `;
}

/** Styles for renderHeader output; include in EchartGraphCard.styles. */
export const headerStyles = css`
  .header {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px 16px 0;
    min-width: 0;
  }

  .title {
    font-size: var(--ha-font-size-l, 16px);
    font-weight: var(--ha-font-weight-medium, 500);
    line-height: 1.3;
    color: var(--primary-text-color);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    letter-spacing: 0.1px;
  }

  .subtitle {
    margin-top: 2px;
    font-size: var(--ha-font-size-s, 12px);
    color: var(--secondary-text-color);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .name-title {
    color: var(--secondary-text-color);
    font-weight: var(--ha-font-weight-normal, 400);
  }

  button {
    appearance: none;
    background: none;
    border: 0;
    margin: 0;
    padding: 0;
    font: inherit;
    color: inherit;
    text-align: inherit;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }

  button:focus-visible {
    outline: 2px solid var(--chip-color, var(--primary-color));
    outline-offset: 2px;
  }

  /* ---- single-series hero ---------------------------------------------- */

  .hero {
    flex-direction: row;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
  }

  .hero-titles {
    flex: 1 1 auto;
    min-width: 0;
    padding-top: 4px;
  }

  .hero-right {
    display: flex;
    flex: 0 1 auto;
    flex-direction: column;
    align-items: flex-end;
    gap: 2px;
    max-width: 70%;
    min-width: 0;
  }

  .hero-value {
    display: inline-flex;
    align-items: baseline;
    max-width: 100%;
    border-radius: var(--ha-border-radius-sm, 6px);
    color: var(--primary-text-color);
    font-size: var(--ha-font-size-3xl, 28px);
    font-weight: var(--ha-font-weight-normal, 400);
    line-height: 1.1;
    letter-spacing: -0.02em;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .hero-unit {
    margin-left: 0.15em;
    font-size: 0.55em;
    letter-spacing: 0;
    color: var(--secondary-text-color);
  }

  .extrema {
    display: flex;
    gap: 8px;
    font-size: var(--ha-font-size-xs, 11px);
    color: var(--secondary-text-color);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  /* ---- multi-series chips ---------------------------------------------- */

  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .chip {
    display: inline-flex;
    align-items: center;
    min-width: 0;
    max-width: 100%;
    border-radius: 999px;
    background: var(--secondary-background-color, rgba(127, 127, 127, 0.1));
    background: color-mix(in srgb, var(--chip-color) 13%, transparent);
    font-size: var(--ha-font-size-s, 12px);
    line-height: 16px;
    transition:
      opacity 0.15s ease,
      background-color 0.15s ease;
  }

  .chip:hover {
    background: color-mix(in srgb, var(--chip-color) 20%, transparent);
  }

  .chip-toggle {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    padding: 4px 4px 4px 9px;
    border-radius: 999px 0 0 999px;
  }

  .chip-value {
    display: inline-flex;
    align-items: baseline;
    gap: 6px;
    padding: 4px 10px 4px 2px;
    border-radius: 0 999px 999px 0;
    font-weight: var(--ha-font-weight-medium, 500);
    color: var(--primary-text-color);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .dot {
    flex: none;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--chip-color);
    box-shadow: 0 0 0 1.5px var(--chip-color) inset;
    transition: background-color 0.15s ease;
  }

  .name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--secondary-text-color);
  }

  .chip-ext {
    display: inline-flex;
    gap: 6px;
    font-size: var(--ha-font-size-xs, 11px);
    font-weight: var(--ha-font-weight-normal, 400);
    color: var(--secondary-text-color);
  }

  .chip.off {
    opacity: 0.55;
    background: transparent;
    box-shadow: 0 0 0 1px var(--divider-color, rgba(127, 127, 127, 0.3)) inset;
  }

  .chip.off .dot {
    background: transparent;
  }

  .chip.off .name {
    text-decoration: line-through;
  }
`;
