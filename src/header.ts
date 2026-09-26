import { css, html, nothing } from 'lit';
import type { TemplateResult } from 'lit';
import type { HomeAssistant, NormalizedConfig, SeriesData, ThemeColors } from './types';

/** Interaction hooks for header chips (they double as the legend when show.legend is off). */
export interface HeaderOptions {
  /** Series keys currently hidden. */
  hiddenKeys?: ReadonlySet<string>;
  /** Called with series.key when a chip is clicked/activated (toggle visibility). */
  onToggle?: (key: string) => void;
}

/**
 * Card header: optional title, then (when cfg.show.headerStates) one chip per series with
 * `showInHeader`: color dot (series.color, CSS vars work natively here), name, and
 * `latest` via formatValue(latest, unit, precision ?? display_precision, hass.locale).
 * Single-series cards render the value large (primary emphasis). Hidden series render dimmed.
 * When cfg.show.extrema, each chip adds min / max / avg of its visible-window points.
 * Chips are buttons (keyboard accessible) calling opts.onToggle(series.key).
 * Returns `nothing`-equivalent empty template when there is neither a title nor chips.
 */
export function renderHeader(
  cfg: NormalizedConfig,
  data: SeriesData[],
  theme: ThemeColors,
  hass: HomeAssistant,
  opts: HeaderOptions = {},
): TemplateResult {
  // STUB: title only. Chips/extrema are implemented later.
  void data;
  void theme;
  void hass;
  void opts;
  return html`${cfg.title ? html`<div class="header"><div class="title">${cfg.title}</div></div>` : nothing}`;
}

/** Styles for renderHeader output; include in EchartGraphCard.styles. */
export const headerStyles = css`
  .header {
    padding: 12px 16px 0;
  }
  .title {
    font-size: 1.1em;
    font-weight: 500;
    color: var(--primary-text-color);
  }
`;
