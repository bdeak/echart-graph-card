import { LitElement, css, html, nothing } from 'lit';
import type { PropertyValues, TemplateResult } from 'lit';
import { property, state } from 'lit/decorators.js';
import { normalizeConfig } from './config';
import { headerStyles, renderHeader } from './header';
import { readTheme } from './chart/theme';
import type { CardConfig, HomeAssistant, NormalizedConfig, SeriesData } from './types';

/**
 * `custom:echart-graph-card` - the Lovelace card element (registered in src/index.ts).
 *
 * Lifecycle contract (to be implemented):
 * - setConfig(raw): normalizeConfig (throws -> HA error card); schedules a refetch.
 * - hass setter: first hass -> loadSeriesData; afterwards `update.mode === 'live'` feeds
 *   LiveBuffer.append (throttled redraw ~1/s via setOption lazyUpdate). hass.states churn
 *   alone never triggers a Lit re-render (shouldUpdate); only config/data/error/theme do.
 * - Refresh: every `cfg.update.intervalMs` (live + interval) refetch/re-anchor the window.
 *   Paused while `document.hidden`; catches up on visibilitychange.
 * - Chart: echarts.init in firstUpdated on the `.chart` div (CanvasRenderer), ResizeObserver
 *   -> chart.resize(); disposed in disconnectedCallback, re-created on reconnect.
 *   Theme via readTheme(this, hass.themes.darkMode); rebuilt when darkMode changes.
 * - Errors (invalid WS response, unknown entity) render inside the card, not as a throw.
 */
export class EchartGraphCard extends LitElement {
  @property({ attribute: false }) public hass?: HomeAssistant;

  @state() protected _config?: NormalizedConfig;
  @state() protected _data: SeriesData[] = [];
  @state() protected _error?: string;

  /** Lovelace calls this with the raw YAML; must throw on invalid config. */
  public setConfig(config: CardConfig): void {
    this._config = normalizeConfig(config);
  }

  /** Masonry layout height hint (1 unit = 50px). */
  public getCardSize(): number {
    const px = Number.parseInt(this._config?.height ?? '220', 10) || 220;
    return Math.max(2, Math.round(px / 50) + (this._config?.title || this._config?.show.headerStates ? 1 : 0));
  }

  /** Sections layout defaults. */
  public getGridOptions(): { columns: number; rows: number | 'auto'; min_columns: number; min_rows: number } {
    return { columns: 12, rows: 'auto', min_columns: 3, min_rows: 2 };
  }

  /** Config inserted when the card is picked in the UI card picker. */
  public static getStubConfig(hass?: HomeAssistant): CardConfig {
    const entity =
      Object.keys(hass?.states ?? {}).find((id) => id.startsWith('sensor.') && hass?.states[id].attributes.unit_of_measurement) ??
      'sensor.temperature';
    return { type: 'custom:echart-graph-card', series: [{ entity }] };
  }

  protected override shouldUpdate(changed: PropertyValues): boolean {
    // hass alone never re-renders; live updates go straight to the chart.
    return !(changed.size === 1 && changed.has('hass'));
  }

  protected override render(): TemplateResult | typeof nothing {
    const cfg = this._config;
    if (!cfg) return nothing;
    const theme = readTheme(this, this.hass?.themes.darkMode ?? false);
    return html`
      <ha-card>
        ${this.hass ? renderHeader(cfg, this._data, theme, this.hass) : nothing}
        ${this._error ? html`<div class="error">${this._error}</div>` : nothing}
        <div class="chart" style="height:${cfg.height}"></div>
      </ha-card>
    `;
  }

  static override styles = [
    headerStyles,
    css`
      :host {
        display: block;
      }
      ha-card {
        overflow: hidden;
        height: 100%;
        display: flex;
        flex-direction: column;
      }
      .chart {
        width: 100%;
        flex: 1 1 auto;
      }
      .error {
        padding: 8px 16px;
        color: var(--error-color, #db4437);
      }
    `,
  ];
}
