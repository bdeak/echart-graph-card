import { LitElement, html, nothing } from 'lit';
import type { PropertyValues, TemplateResult } from 'lit';
import { property, state } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { styleMap } from 'lit/directives/style-map.js';
import { DEFAULTS, MINUTE, SECOND, normalizeConfig } from './config';
import { CARD_NAME } from './const';
import { headerStyles, renderHeader } from './header';
import { cardStyles } from './styles';
import { echarts } from './chart/echarts';
import type { EChartsCoreOption, EChartsInstance } from './chart/echarts';
import { buildOptions, legendNames } from './chart/options';
import { readTheme, resolveColor } from './chart/theme';
import { LiveBuffer } from './data/live';
import { loadSeriesData } from './data/loader';
import type { CardConfig, HomeAssistant, NormalizedConfig, SeriesData, ThemeColors } from './types';

/** Minimum time between two live (hass-driven) redraws. */
const REDRAW_THROTTLE_MS = SECOND;
/** Window re-anchor cadence (shift x-axis to "now", trim old points). */
const REANCHOR_MS = MINUTE;
/** A failed load is retried at most this often. */
const RETRY_MS = 30 * SECOND;
/** Reconnecting after being detached longer than this triggers a full reload. */
const RECONNECT_STALE_MS = MINUTE;
/** Returning to a tab hidden longer than this triggers a full reload (states may have been missed). */
const HIDDEN_STALE_MS = 5 * MINUTE;
/** Slack for timer jitter when deciding whether a periodic reload is due. */
const TIMER_SLACK_MS = SECOND;

/** Sections-layout sizing hints (see HA `getGridOptions`). */
export interface LovelaceGridOptions {
  columns?: number | 'full';
  rows?: number | 'auto';
  min_columns?: number;
  max_columns?: number;
  min_rows?: number;
  max_rows?: number;
}

/** Runtime `hass` fields we read but which are not part of the shared contract. */
interface HassRuntimeExtras {
  connected?: boolean;
  /** User theme preferences (theme name, dark, primary/accent color). */
  selectedTheme?: unknown;
}

/**
 * Everything in `hass` that changes how the chart looks (theme variables, dark mode, locale).
 * Compared element-wise by reference; deliberately avoids the `themes` wrapper object itself so
 * a hass implementation that re-creates it on every state change cannot cause full rebuilds.
 */
function styleKeyOf(hass: HomeAssistant | undefined): unknown[] {
  if (!hass) return [];
  const t = hass.themes as { darkMode?: boolean; theme?: unknown; themes?: unknown } | undefined;
  return [t?.darkMode, t?.theme, t?.themes, (hass as HassRuntimeExtras).selectedTheme, hass.locale, hass.language];
}

function sameKey(a: unknown[], b: unknown[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

type RedrawKind = 0 | 1 | 2; // 0 = none, 1 = header only, 2 = live chart update (+ header)

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'object' && e !== null && 'message' in e) return String((e as { message: unknown }).message);
  return String(e);
}

/** Everything in the config that affects the fetched data (anything else is cosmetic). */
function dataSignature(cfg: NormalizedConfig): string {
  return JSON.stringify([
    cfg.spanMs,
    cfg.dataSource,
    cfg.dataSourceAuto,
    cfg.statisticsPeriod,
    cfg.series.map((s) => [s.key, s.name, s.unit, s.transform, s.groupBy, s.statistic]),
  ]);
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const k of a) if (!b.has(k)) return false;
  return true;
}

/**
 * `custom:echart-graph-card` - the Lovelace card element (registered in src/index.ts).
 *
 * Lifecycle:
 * - setConfig(raw): normalizeConfig (throws -> HA error card). Data-affecting changes
 *   (window, source, entities, transform, group_by, ...) trigger a reload; cosmetic changes
 *   only rebuild the chart option from the already loaded data.
 * - hass setter: the first hass (while connected) starts the initial load. Afterwards, when a
 *   tracked entity's state object changed: `update: live` feeds LiveBuffer.append and a
 *   throttled (~1/s) chart update (setOption merge, lazyUpdate, no animation) + header refresh;
 *   other modes refresh only the header. hass.states churn alone never re-renders (shouldUpdate).
 * - Timers: every 60 s (or the `update` interval if shorter) the window is re-anchored to now and
 *   trimmed; a full reload happens every `update.intervalMs` for `update: <interval>`, and every
 *   5 min in live mode when statistics are involved or the span exceeds 72 h. `update: none`
 *   fetches once and keeps the window fixed. Paused while `document.hidden`; catches up on
 *   visibilitychange. Overlapping loads are guarded by a sequence number.
 * - Chart: echarts.init on the `.chart` div once connected with hass; ResizeObserver ->
 *   rAF-throttled chart.resize(); disposed (with observer/timers) in disconnectedCallback and
 *   re-created on reconnect. Theme via readTheme(this, darkMode), re-read when hass.themes /
 *   darkMode / locale change.
 * - Errors (WS failure, unknown entity) render inside the card, not as a throw.
 */
export class EchartGraphCard extends LitElement {
  /** Set by HA: `grid` in the sections view (the card then fills its grid cell). */
  @property({ attribute: false }) public layout?: string;

  @state() protected _config?: NormalizedConfig;
  @state() protected _data: SeriesData[] = [];
  @state() protected _error?: string;
  /** First dataset for the current config has arrived. */
  @state() protected _loaded = false;
  /** Series keys toggled off (header chips / legend). */
  @state() protected _hiddenKeys: ReadonlySet<string> = new Set();
  /** Bumped to force a (cheap) re-render, e.g. header values after live updates. */
  @state() protected _rev = 0;

  private _hass?: HomeAssistant;
  private _chart?: EChartsInstance;
  private _chartEl?: HTMLElement;
  private _chartInitFailed = false;
  private _ro?: ResizeObserver;
  private _resizeRaf?: number;
  private _themeRaf?: number;
  private _theme?: ThemeColors;
  private _styleKey: unknown[] = [];

  private readonly _live = new LiveBuffer();
  private _trackedEntities: string[] = [];

  private _wantSig?: string;
  private _haveSig?: string;
  private _inflightSig?: string;
  private _loadSeq = 0;
  /** Start time (epoch ms) of the last successful load; also the window end for `update: none`. */
  private _loadedAt = 0;
  private _retryAt = 0;

  private _pendingRedraw: RedrawKind = 0;
  private _redrawTimer?: ReturnType<typeof setTimeout>;
  private _lastRedrawAt = 0;
  private _tickTimer?: ReturnType<typeof setInterval>;
  private _hiddenAt?: number;

  // ---------------------------------------------------------------------------
  // HA card API
  // ---------------------------------------------------------------------------

  @property({ attribute: false })
  public get hass(): HomeAssistant | undefined {
    return this._hass;
  }

  public set hass(hass: HomeAssistant | undefined) {
    const old = this._hass;
    this._hass = hass;
    this._onHass(hass, old);
  }

  /** Lovelace calls this with the raw YAML; throws on invalid config (HA shows an error card). */
  public setConfig(config: CardConfig): void {
    const cfg = normalizeConfig(config);
    const prev = this._config;
    const sig = dataSignature(cfg);

    this._config = cfg;
    this._wantSig = sig;
    this._trackedEntities = [...new Set(cfg.series.map((s) => s.entity))];
    const hidden = new Set(cfg.series.filter((s) => s.hidden).map((s) => s.key));
    if (!sameSet(hidden, this._hiddenKeys)) this._hiddenKeys = hidden;

    if (prev && sig === this._haveSig && this._data.length === cfg.series.length) {
      // Cosmetic change only: keep the data, rebind it to the new normalized series.
      this._data.forEach((d, i) => {
        d.series = cfg.series[i];
      });
    } else if (prev && sig !== this._haveSig) {
      this._data = [];
      this._loaded = false;
      this._haveSig = undefined;
      this._error = undefined;
      this._retryAt = 0;
    }

    if (this.isConnected) this._startTicker();
    this._maybeLoad();
  }

  /** Masonry layout height hint (1 unit = 50px). */
  public getCardSize(): number {
    const cfg = this._config;
    const px = cfg && /^\d+(\.\d+)?px$/.test(cfg.height) ? Number.parseFloat(cfg.height) : Number.parseFloat(DEFAULTS.height);
    let size = Math.ceil(px / 50);
    if (cfg) {
      const chips = cfg.show.headerStates ? cfg.series.filter((s) => s.showInHeader).length : 0;
      if (chips === 1) size += 1; // title + hero value share one row
      else size += (cfg.title ? 1 : 0) + (chips > 1 ? 1 : 0);
    }
    return Math.max(2, size);
  }

  /** Sections layout defaults. */
  public getGridOptions(): LovelaceGridOptions {
    return { columns: 12, min_columns: 4, rows: 4, min_rows: 2 };
  }

  /** Config inserted when the card is picked in the UI card picker. */
  public static getStubConfig(hass?: HomeAssistant): CardConfig {
    const states = Object.values(hass?.states ?? {});
    const withUnit = states.filter((s) => s.entity_id.startsWith('sensor.') && s.attributes.unit_of_measurement);
    const numeric = withUnit.find((s) => s.state.trim() !== '' && Number.isFinite(Number(s.state)));
    const entity = (numeric ?? withUnit[0])?.entity_id ?? 'sensor.temperature';
    return { type: `custom:${CARD_NAME}`, series: [{ entity }] };
  }

  // ---------------------------------------------------------------------------
  // Lit lifecycle
  // ---------------------------------------------------------------------------

  public override connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener('visibilitychange', this._onVisibilityChange);
    this._hiddenAt = document.hidden ? Date.now() : undefined;
    this._startTicker();
    if (!this._config || !this._hass) return;
    // Re-attached (e.g. view switch): chart is re-created in updated(); refresh stale data.
    if (this._loaded && this._config.update.mode !== 'none' && Date.now() - this._loadedAt > RECONNECT_STALE_MS) {
      void this._load();
    } else {
      this._maybeLoad();
      if (this._loaded && this._config.update.mode === 'live') this._live.append(this._hass);
      if (this._loaded) this._scheduleRedraw(2);
    }
    this._rev++;
  }

  public override disconnectedCallback(): void {
    super.disconnectedCallback();
    document.removeEventListener('visibilitychange', this._onVisibilityChange);
    this._stopTicker();
    if (this._redrawTimer !== undefined) clearTimeout(this._redrawTimer);
    this._redrawTimer = undefined;
    if (this._resizeRaf !== undefined) cancelAnimationFrame(this._resizeRaf);
    this._resizeRaf = undefined;
    if (this._themeRaf !== undefined) cancelAnimationFrame(this._themeRaf);
    this._themeRaf = undefined;
    this._disposeChart();
  }

  protected override shouldUpdate(changed: PropertyValues): boolean {
    if (!(changed.size === 1 && changed.has('hass'))) return true;
    const old = changed.get('hass') as HomeAssistant | undefined;
    const hass = this._hass;
    if (!old || !hass) return true;
    // Chart still to be created (first hass while connected, reconnect).
    if (!this._chart && this._config && this.isConnected && !this._chartInitFailed) return true;
    // Theme / locale changes need a re-render; hass.states churn alone never does.
    return !sameKey(styleKeyOf(old), styleKeyOf(hass));
  }

  protected override willUpdate(changed: PropertyValues): void {
    super.willUpdate(changed);
    this.toggleAttribute('fill-height', this._config ? this._fillsCell(this._config) : false);
  }

  protected override render(): TemplateResult | typeof nothing {
    const cfg = this._config;
    if (!cfg) return nothing;
    const hass = this._hass;
    const fill = this._fillsCell(cfg);

    const seriesErrors = [...new Set(this._data.map((d) => d.error).filter((e): e is string => Boolean(e)))];
    const shimmer = !this._loaded && !this._error;
    const empty =
      this._loaded && !this._error && seriesErrors.length === 0 && !this._data.some((d) => d.points.some((p) => p[1] !== null));

    return html`
      <ha-card class=${classMap({ fill })}>
        ${hass
          ? renderHeader(cfg, this._data, this._currentTheme(), hass, {
              hiddenKeys: this._hiddenKeys,
              onToggle: this._toggleSeries,
              now: this._windowEnd(),
            })
          : cfg.title
            ? html`<div class="header"><div class="title">${cfg.title}</div></div>`
            : nothing}
        ${this._error || seriesErrors.length
          ? html`<div class="alerts">
              ${this._error ? html`<div class="alert error" role="alert">${this._error}</div>` : nothing}
              ${seriesErrors.map((e) => html`<div class="alert warning">${e}</div>`)}
            </div>`
          : nothing}
        <div class="chart-wrap">
          <div class="chart" role="img" aria-label=${cfg.title ?? 'History chart'} style=${styleMap({ height: fill ? '100%' : cfg.height })}></div>
          ${shimmer ? html`<div class="shimmer" aria-hidden="true"></div>` : nothing}
          ${empty ? html`<div class="empty">No data in this period</div>` : nothing}
        </div>
      </ha-card>
    `;
  }

  protected override updated(changed: PropertyValues): void {
    super.updated(changed);
    const created = this._ensureChart();

    const styleKey = styleKeyOf(this._hass);
    const styleChanged = !sameKey(styleKey, this._styleKey);
    this._styleKey = styleKey;

    if (created) return; // _ensureChart already drew the current state.
    if (styleChanged && this._chart && this._styleKey.length) {
      // HA applies theme variables around the same update; read them one frame later.
      if (this._themeRaf !== undefined) cancelAnimationFrame(this._themeRaf);
      this._themeRaf = requestAnimationFrame(() => {
        this._themeRaf = undefined;
        this._theme = undefined;
        this._applyChart(true);
      });
    }
    if (changed.has('_config') || changed.has('_data') || changed.has('_loaded')) {
      if (this._loaded) this._applyChart(true);
      else this._chart?.clear();
    } else if (changed.has('_hiddenKeys')) {
      this._applyChart(false);
    }
  }

  // ---------------------------------------------------------------------------
  // hass handling
  // ---------------------------------------------------------------------------

  private _onHass(hass: HomeAssistant | undefined, old: HomeAssistant | undefined): void {
    const cfg = this._config;
    if (!hass || !cfg || !this.isConnected) return;

    const connected = (hass as HassRuntimeExtras).connected;
    const wasConnected = (old as HassRuntimeExtras | undefined)?.connected;
    if (old && wasConnected === false && connected !== false && this._loaded) {
      // WebSocket reconnected: states may have been missed.
      void this._load();
      return;
    }

    if (!this._loaded) this._maybeLoad();
    if (!old || !this._trackedChanged(hass, old)) return;

    // Header values always follow hass.states; the chart only in live mode.
    let chartDirty = false;
    if (this._loaded && cfg.update.mode === 'live') chartDirty = this._live.append(hass);
    this._scheduleRedraw(chartDirty ? 2 : 1);
  }

  private _trackedChanged(hass: HomeAssistant, old: HomeAssistant): boolean {
    if (hass.states === old.states) return false;
    for (const id of this._trackedEntities) {
      if (hass.states[id] !== old.states[id]) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Loading
  // ---------------------------------------------------------------------------

  /** Load if the current config's data is neither loaded nor in flight (and no retry backoff). */
  private _maybeLoad(): void {
    if (!this._config || !this._hass || !this.isConnected) return;
    if (this._haveSig === this._wantSig || this._inflightSig === this._wantSig) return;
    if (Date.now() < this._retryAt) return;
    if (document.hidden && this._loaded) return; // catch up on visibilitychange
    void this._load();
  }

  /** (Re)load all series for the current config. Stale responses are discarded. */
  private async _load(): Promise<void> {
    const cfg = this._config;
    const hass = this._hass;
    const sig = this._wantSig;
    if (!cfg || !hass || sig === undefined) return;
    if (this._inflightSig === sig) return; // same request already running

    const seq = ++this._loadSeq;
    this._inflightSig = sig;
    const startedAt = Date.now();
    try {
      const data = await loadSeriesData(hass, cfg, new Date(startedAt));
      if (seq !== this._loadSeq) return;
      // Snapshot the hass the fetch was based on, then catch up on anything newer.
      const latestCfg = this._config;
      if (latestCfg && latestCfg !== cfg) {
        // Cosmetic setConfig while in flight (same data signature): bind to the newest series.
        data.forEach((d, i) => {
          d.series = latestCfg.series[i] ?? d.series;
        });
      }
      this._live.reset(data, hass);
      const current = this._hass;
      if (cfg.update.mode === 'live' && current && current !== hass) this._live.append(current);
      this._data = data;
      this._haveSig = sig;
      this._loadedAt = startedAt;
      this._loaded = true;
      this._error = undefined;
      this._retryAt = 0;
    } catch (e) {
      if (seq !== this._loadSeq) return;
      this._error = `Could not load data: ${errorMessage(e)}`;
      this._retryAt = Date.now() + RETRY_MS;
    } finally {
      if (seq === this._loadSeq) this._inflightSig = undefined;
    }
  }

  /** Full reload cadence for the current config/data, Infinity when never. */
  private _reloadEveryMs(): number {
    const cfg = this._config;
    if (!cfg || cfg.update.mode === 'none') return Infinity;
    if (cfg.update.mode === 'interval') return cfg.update.intervalMs;
    const usesStatistics = cfg.dataSource === 'statistics' || this._data.some((d) => d.source === 'statistics');
    return usesStatistics || cfg.spanMs > DEFAULTS.autoHistoryMaxSpanMs ? cfg.update.intervalMs : Infinity;
  }

  private _reloadDue(now: number): boolean {
    return this._loaded && now - this._loadedAt >= this._reloadEveryMs() - TIMER_SLACK_MS;
  }

  // ---------------------------------------------------------------------------
  // Timers / visibility
  // ---------------------------------------------------------------------------

  private _startTicker(): void {
    this._stopTicker();
    const cfg = this._config;
    if (!cfg || cfg.update.mode === 'none') return;
    const period = cfg.update.mode === 'interval' ? Math.min(cfg.update.intervalMs, REANCHOR_MS) : REANCHOR_MS;
    this._tickTimer = setInterval(() => this._onTick(), period);
  }

  private _stopTicker(): void {
    if (this._tickTimer !== undefined) clearInterval(this._tickTimer);
    this._tickTimer = undefined;
  }

  private _onTick(): void {
    if (!this.isConnected || document.hidden || !this._config || !this._hass) return;
    if (this._reloadDue(Date.now())) {
      void this._load();
      return;
    }
    if (!this._loaded || this._haveSig !== this._wantSig) {
      this._maybeLoad(); // retry after a failed load
      return;
    }
    this._scheduleRedraw(2); // re-anchor window + trim
  }

  private readonly _onVisibilityChange = (): void => {
    if (document.hidden) {
      this._hiddenAt ??= Date.now();
      return;
    }
    const hiddenFor = this._hiddenAt === undefined ? 0 : Date.now() - this._hiddenAt;
    this._hiddenAt = undefined;
    const cfg = this._config;
    if (!cfg || !this._hass || !this.isConnected) return;
    if (this._loaded && (this._reloadDue(Date.now()) || (cfg.update.mode !== 'none' && hiddenFor >= HIDDEN_STALE_MS))) {
      void this._load();
      return;
    }
    this._maybeLoad();
    if (this._loaded) this._scheduleRedraw(2);
  };

  // ---------------------------------------------------------------------------
  // Chart
  // ---------------------------------------------------------------------------

  /** Create the ECharts instance when possible. Returns true if it was created (and drawn) now. */
  private _ensureChart(): boolean {
    if (!this.isConnected || !this._hass || !this._config) return false;
    const el = this.renderRoot.querySelector<HTMLElement>('.chart');
    if (!el) return false;
    if (this._chart && this._chartEl === el && !this._chart.isDisposed()) return false;
    this._disposeChart();
    try {
      this._chart = echarts.init(el, undefined, { renderer: 'canvas' });
    } catch (e) {
      this._chartInitFailed = true;
      this._error = `Could not create chart: ${errorMessage(e)}`;
      return false;
    }
    this._chartInitFailed = false;
    this._chartEl = el;
    this._chart.on('legendselectchanged', this._onLegendSelectChanged);
    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(() => this._scheduleResize());
      this._ro.observe(el);
    }
    this._theme = undefined;
    if (this._loaded) this._applyChart(true);
    return true;
  }

  private _disposeChart(): void {
    this._ro?.disconnect();
    this._ro = undefined;
    if (this._chart) {
      this._chart.off('legendselectchanged', this._onLegendSelectChanged);
      if (!this._chart.isDisposed()) this._chart.dispose();
    }
    this._chart = undefined;
    this._chartEl = undefined;
  }

  private _scheduleResize(): void {
    if (this._resizeRaf !== undefined) return;
    this._resizeRaf = requestAnimationFrame(() => {
      this._resizeRaf = undefined;
      if (this._chart && !this._chart.isDisposed()) this._chart.resize();
    });
  }

  private _currentTheme(): ThemeColors {
    if (!this._theme) this._theme = readTheme(this, this._hass?.themes?.darkMode ?? false);
    return this._theme;
  }

  /** Right edge of the time window: now, or the load time for `update: none`. */
  private _windowEnd(): number {
    return this._config?.update.mode === 'none' && this._loadedAt ? this._loadedAt : Date.now();
  }

  /** Grid (sections) layout: fill the cell, unless the user sized the card by content. */
  private _fillsCell(cfg: NormalizedConfig): boolean {
    if (this.layout !== 'grid') return false;
    const grid = (cfg.raw as { grid_options?: { rows?: unknown } }).grid_options;
    return grid?.rows !== 'auto';
  }

  /**
   * Push the current state into ECharts. `full`: rebuild from scratch (notMerge) - config,
   * theme or data change. Otherwise a cheap merge (replace series by id, lazy, no animation).
   */
  private _applyChart(full: boolean): void {
    const chart = this._chart;
    const cfg = this._config;
    const hass = this._hass;
    if (!chart || chart.isDisposed() || !cfg || !hass || !this._loaded) return;
    let option: EChartsCoreOption;
    try {
      option = buildOptions(cfg, this._data, this._currentTheme(), {
        hass,
        now: this._windowEnd(),
        resolveColor: (c) => resolveColor(this, c),
        hiddenKeys: this._hiddenKeys,
        animate: full,
        width: this._chartEl?.clientWidth || undefined,
      });
    } catch (e) {
      this._error = `Could not render chart: ${errorMessage(e)}`;
      return;
    }
    if (full) {
      chart.setOption(option, { notMerge: true });
    } else {
      chart.setOption({ ...option, animation: false }, { replaceMerge: ['series'], lazyUpdate: true, silent: true });
    }
  }

  /** Throttle hass-driven work to ~1/s. kind 2 = chart update + header, 1 = header only. */
  private _scheduleRedraw(kind: RedrawKind): void {
    if (kind > this._pendingRedraw) this._pendingRedraw = kind;
    if (this._redrawTimer !== undefined) return;
    const wait = Math.max(0, this._lastRedrawAt + REDRAW_THROTTLE_MS - Date.now());
    this._redrawTimer = setTimeout(() => this._flushRedraw(), wait);
  }

  private _flushRedraw(): void {
    this._redrawTimer = undefined;
    const cfg = this._config;
    if (!cfg || !this.isConnected || document.hidden) return; // pending work stays queued
    const kind = this._pendingRedraw;
    this._pendingRedraw = 0;
    if (kind === 0) return;
    this._lastRedrawAt = Date.now();
    if (kind === 2 && this._loaded) {
      if (cfg.update.mode !== 'none') this._live.trim(this._windowEnd() - cfg.spanMs);
      this._applyChart(false);
    }
    this._rev++;
  }

  // ---------------------------------------------------------------------------
  // Series visibility
  // ---------------------------------------------------------------------------

  private readonly _toggleSeries = (key: string): void => {
    const next = new Set(this._hiddenKeys);
    const hide = !next.has(key);
    if (hide) next.add(key);
    else next.delete(key);
    this._hiddenKeys = next;
    const i = this._data.findIndex((x) => x.series.key === key);
    if (i >= 0 && this._chart && !this._chart.isDisposed()) {
      // Immediate feedback through ECharts' legend model (keyed by the de-duplicated series
      // names); updated() then re-syncs the option.
      this._chart.dispatchAction({ type: hide ? 'legendUnSelect' : 'legendSelect', name: legendNames(this._data)[i] });
    }
  };

  private readonly _onLegendSelectChanged = (e: unknown): void => {
    const selected = (e as { selected?: Record<string, boolean> } | undefined)?.selected;
    if (!selected) return;
    const next = new Set<string>();
    const names = legendNames(this._data);
    this._data.forEach((d, i) => {
      if (selected[names[i]] === false) next.add(d.series.key);
    });
    if (!sameSet(next, this._hiddenKeys)) this._hiddenKeys = next;
  };

  static override styles = [cardStyles, headerStyles];
}
