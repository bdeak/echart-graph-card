import { LitElement, html, nothing } from 'lit';
import type { PropertyValues, TemplateResult } from 'lit';
import { property, state } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { styleMap } from 'lit/directives/style-map.js';
import { DEFAULTS, HOUR, MINUTE, SECOND, normalizeConfig } from './config';
import { CARD_NAME } from './const';
import { headerStyles, renderHeader } from './header';
import { cardStyles } from './styles';
import { echarts } from './chart/echarts';
import type { EChartsCoreOption, EChartsInstance } from './chart/echarts';
import { buildOptions, legendNames } from './chart/options';
import { readTheme, resolveColor } from './chart/theme';
import { LiveBuffer } from './data/live';
import { loadHistoryRange, loadSeriesData } from './data/loader';
import { bucketTimeZone, chartWindow } from './data/transform';
import type { ChartWindow } from './data/transform';
import type { CardConfig, HomeAssistant, NormalizedConfig, SeriesData, ThemeColors } from './types';

/** Minimum time between two live (hass-driven) redraws. */
const REDRAW_THROTTLE_MS = SECOND;
/** Window re-anchor cadence (shift x-axis to "now", trim old points). */
const REANCHOR_MS = MINUTE;
/** A failed load is retried at most this often. */
const RETRY_MS = 30 * SECOND;
/** Re-attaching after being detached longer than this backfills the missed states. */
const RECONNECT_STALE_MS = MINUTE;
/** Returning to a tab hidden longer than this backfills the missed states. */
const HIDDEN_STALE_MS = 5 * MINUTE;
/** Slack for timer jitter when deciding whether a periodic reload is due. */
const TIMER_SLACK_MS = SECOND;
/**
 * HA compiles statistics every 5 minutes (hourly rows at the full hour) a few seconds after the
 * period ends; statistics series are refreshed this long after each period boundary.
 */
const STATS_COMPILE_DELAY_MS = MINUTE;
/** Re-reduce the zoomed range this long after the last zoom / pan event. */
const ZOOM_DEBOUNCE_MS = 150;
/** Rebuild the chart option after a resize that changes width / height by more than this. */
const RESIZE_REBUILD_RATIO = 0.1;

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

/** Next time statistics of `period` can have new rows (just after the next compile). */
export function nextStatisticsRefresh(now: number, period: NormalizedConfig['statisticsPeriod']): number {
  const step = period === '5minute' ? 5 * MINUTE : HOUR;
  return Math.floor((now - STATS_COMPILE_DELAY_MS) / step) * step + step + STATS_COMPILE_DELAY_MS;
}

const isTouchDevice = (): boolean => typeof window !== 'undefined' && 'ontouchstart' in window;

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'object' && e !== null && 'message' in e) return String((e as { message: unknown }).message);
  return String(e);
}

/** Everything in the config that affects the fetched data (anything else is cosmetic). */
function dataSignature(cfg: NormalizedConfig): string {
  return JSON.stringify([
    cfg.spanMs,
    cfg.spanStart,
    cfg.dataSource,
    cfg.dataSourceAuto,
    cfg.statisticsPeriod,
    cfg.series.map((s) => [s.key, s.name, s.unit, s.transform, s.groupBy, s.statistic, s.timeKey]),
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
 *   trimmed; a full reload happens every `update.intervalMs` for `update: <interval>`. In live
 *   mode history is never refetched; statistics series alone are refreshed just after each
 *   statistics period was compiled (nextStatisticsRefresh). `update: none` fetches once and keeps
 *   the window fixed. Paused while `document.hidden`. Gaps in the live feed (detached > 1 min,
 *   tab hidden >= 5 min, WebSocket reconnect) are backfilled with one history call for just the
 *   gap (a full reload when the gap is as long as the window). A failed load / refresh is
 *   retried every 30 s with a full reload. Reloads of unchanged configs redraw by merging
 *   (zoom, tooltip and animation state survive). Overlapping loads are guarded by a sequence
 *   number.
 * - Chart: echarts.init on the `.chart` div once connected with hass; ResizeObserver ->
 *   rAF-throttled chart.resize() (option rebuilt when the size changed a lot: point reduction
 *   and tick count follow the size); disposed (with observer/timers) in disconnectedCallback and
 *   re-created on reconnect. Theme via readTheme(this, darkMode), re-read when hass.themes /
 *   darkMode / locale change. show.zoom: the zoom window survives redraws and rebuilds; touch
 *   devices only pan once zoomed in, the mouse wheel only zooms while Ctrl is held.
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
  /** Window start of the last successful full load (span.start: a new day reloads). */
  private _loadedStart = 0;
  private _retryAt = 0;
  /** The last load / refresh failed: retried (full reload) from `_retryAt` on. */
  private _reloadFailed = false;
  /** Partial update in flight (history backfill of a gap, statistics-only refresh). */
  private _partial?: 'backfill' | 'statistics';
  private _partialSeq = 0;
  /** Start of a live-feed gap waiting for a backfill (another partial update was running). */
  private _pendingGap?: number;
  /** Live mode: when the statistics series are refreshed next. */
  private _statsDueAt = Infinity;
  /** The next `_data` change is a refresh of the same config: redraw by merging. */
  private _dataRefresh = false;

  private _pendingRedraw: RedrawKind = 0;
  private _redrawTimer?: ReturnType<typeof setTimeout>;
  private _lastRedrawAt = 0;
  private _tickTimer?: ReturnType<typeof setInterval>;
  private _hiddenAt?: number;
  private _detachedAt?: number;
  /** When the WebSocket was seen disconnected (start of the gap to backfill). */
  private _disconnectedAt?: number;

  /** show.zoom: current zoom window in percent, undefined = not zoomed. */
  private _zoom?: { start: number; end: number };
  private _zoomTimer?: ReturnType<typeof setTimeout>;
  private _zoomModifier = false;
  private readonly _touch = isTouchDevice();
  /** Chart size the current option was built for. */
  private _builtSize: [number, number] = [0, 0];

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
    this._trackedEntities = [...new Set([...cfg.series, ...cfg.valueSeries].map((s) => s.entity))];
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
      this._reloadFailed = false;
      this._zoom = undefined;
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
      const chips = cfg.headerSeries.length;
      if (chips === 1) size += 1; // title + hero value share one row
      else size += (cfg.title ? 1 : 0) + (chips > 1 ? 1 : 0);
    }
    return Math.max(2, size);
  }

  /**
   * Sections layout defaults. No `rows`: the card sizes to its content (`height`), like HA's own
   * history graph card; it fills the grid cell only when the user sets `grid_options.rows`.
   */
  public getGridOptions(): LovelaceGridOptions {
    return { columns: 12, min_columns: 4, min_rows: 2 };
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
    window.addEventListener('keydown', this._onKey);
    window.addEventListener('keyup', this._onKey);
    window.addEventListener('blur', this._onBlur);
    this._hiddenAt = document.hidden ? Date.now() : undefined;
    this._startTicker();
    const detachedAt = this._detachedAt;
    this._detachedAt = undefined;
    if (!this._config || !this._hass) return;
    // Re-attached (e.g. view switch): the chart is re-created in updated(). States that arrived
    // while detached were not appended: backfill them when it was long enough to matter.
    if (this._loaded && detachedAt !== undefined && Date.now() - detachedAt > RECONNECT_STALE_MS) {
      this._catchUp(detachedAt);
    } else {
      this._maybeLoad();
      if (this._loaded && this._config.update.mode === 'live' && !this._backfilling()) this._live.append(this._hass);
    }
    if (this._loaded) this._scheduleRedraw(2);
    this._rev++;
  }

  public override disconnectedCallback(): void {
    super.disconnectedCallback();
    this._detachedAt = Date.now();
    document.removeEventListener('visibilitychange', this._onVisibilityChange);
    window.removeEventListener('keydown', this._onKey);
    window.removeEventListener('keyup', this._onKey);
    window.removeEventListener('blur', this._onBlur);
    this._stopTicker();
    if (this._redrawTimer !== undefined) clearTimeout(this._redrawTimer);
    this._redrawTimer = undefined;
    if (this._zoomTimer !== undefined) clearTimeout(this._zoomTimer);
    this._zoomTimer = undefined;
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
              start: this._window().start,
            })
          : cfg.title
            ? html`<div class="header"><div class="title">${cfg.title}</div></div>`
            : nothing}
        ${this._error || seriesErrors.length || cfg.warnings.length
          ? html`<div class="alerts">
              ${this._error ? html`<div class="alert error" role="alert">${this._error}</div>` : nothing}
              ${seriesErrors.map((e) => html`<div class="alert warning">${e}</div>`)}
              ${cfg.warnings.map((w) => html`<div class="alert warning">${w}</div>`)}
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

    const refresh = this._dataRefresh;
    this._dataRefresh = false;
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
      // A reload of the unchanged config merges (keeps zoom, open tooltip, no entry animation).
      if (this._loaded) this._applyChart(changed.has('_config') || changed.has('_loaded') || !refresh);
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
    if (connected === false && wasConnected !== false) this._disconnectedAt ??= Date.now();
    if (old && wasConnected === false && connected !== false && this._loaded) {
      // WebSocket reconnected (e.g. HA restarted): states may have been missed.
      const gapStart = this._disconnectedAt ?? this._loadedAt;
      this._disconnectedAt = undefined;
      this._catchUp(gapStart);
      this._scheduleRedraw(2);
      return;
    }

    if (!this._loaded) this._maybeLoad();
    if (!old || !this._trackedChanged(hass, old)) return;

    // Header values always follow hass.states; the chart only in live mode (paused while a
    // backfill is in flight; it catches up when the backfill is merged).
    let chartDirty = false;
    if (this._loaded && cfg.update.mode === 'live' && !this._backfilling()) chartDirty = this._live.append(hass);
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

  /** Cosmetic setConfig while a fetch was in flight (same data signature): bind to the newest series. */
  private _rebind(data: SeriesData[], cfg: NormalizedConfig): void {
    const latest = this._config;
    if (!latest || latest === cfg) return;
    const byKey = new Map(latest.series.map((s) => [s.key, s]));
    for (const d of data) d.series = byKey.get(d.series.key) ?? d.series;
  }

  private _fail(e: unknown): void {
    this._error = `Could not load data: ${errorMessage(e)}`;
    this._retryAt = Date.now() + RETRY_MS;
    this._reloadFailed = true;
  }

  /** A history backfill of the current dataset is in flight (live appends wait for it). */
  private _backfilling(): boolean {
    return this._partial === 'backfill' && this._partialSeq === this._loadSeq;
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
    // Same config as the data on screen: a refresh, drawn by merging.
    const refresh = this._loaded && this._haveSig === sig;
    try {
      const data = await loadSeriesData(hass, cfg, new Date(startedAt));
      if (seq !== this._loadSeq) return;
      this._rebind(data, cfg);
      // Snapshot the hass the fetch was based on, then catch up on anything newer.
      this._live.reset(data, hass);
      const current = this._hass;
      if (cfg.update.mode === 'live' && current && current !== hass) this._live.append(current);
      this._dataRefresh = refresh;
      this._data = data;
      this._haveSig = sig;
      this._loadedAt = startedAt;
      this._loadedStart = chartWindow(cfg.spanMs, cfg.spanStart, startedAt, bucketTimeZone(hass)).start;
      this._loaded = true;
      this._error = undefined;
      this._retryAt = 0;
      this._reloadFailed = false;
      this._pendingGap = undefined;
      this._statsDueAt = this._nextStatsDue(data, startedAt);
    } catch (e) {
      if (seq !== this._loadSeq) return;
      this._fail(e);
    } finally {
      if (seq === this._loadSeq) this._inflightSig = undefined;
    }
  }

  /**
   * Live-feed gap [gapStart, now] (detached, hidden, WebSocket down). Live mode: backfill the
   * history series with one call for just the gap (a full reload when the gap covers the whole
   * window or the last load failed). Interval mode: reload if due. `update: none`: nothing.
   */
  private _catchUp(gapStart: number): void {
    const cfg = this._config;
    if (!cfg || !this._loaded || cfg.update.mode === 'none') return;
    const now = Date.now();
    if (this._reloadFailed || now - gapStart >= cfg.spanMs || (cfg.update.mode === 'interval' && this._reloadDue(now))) {
      void this._load();
      return;
    }
    if (cfg.update.mode === 'live') void this._backfill(gapStart);
  }

  /** Merge the recorder history of [gapStart, now] into the live history series. */
  private async _backfill(gapStart: number): Promise<void> {
    const cfg = this._config;
    const hass = this._hass;
    if (!cfg || !hass || !this._loaded) return;
    if (this._inflightSig !== undefined) return; // a full load is running and covers the gap
    if (this._partial) {
      this._pendingGap = Math.min(this._pendingGap ?? gapStart, gapStart);
      return;
    }
    const series = this._data.filter((d) => d.source === 'history' && !d.error).map((d) => d.series);
    if (series.length === 0) return;
    const seq = this._loadSeq;
    this._partial = 'backfill';
    this._partialSeq = seq;
    try {
      const pts = await loadHistoryRange(hass, series, gapStart, new Date());
      if (seq !== this._loadSeq) return;
      this._live.backfill(pts, gapStart, this._hass);
      if (this._hass) this._live.append(this._hass);
      this._error = undefined;
      this._reloadFailed = false;
      this._scheduleRedraw(2);
    } catch (e) {
      if (seq !== this._loadSeq) return;
      this._fail(e);
    } finally {
      this._partialDone();
    }
  }

  /** Live mode: reload only the statistics series (history stays live). */
  private async _refreshStatistics(): Promise<void> {
    const cfg = this._config;
    const hass = this._hass;
    if (!cfg || !hass || !this._loaded || this._partial || this._inflightSig !== undefined) return;
    const keys = new Set(this._data.filter((d) => d.source === 'statistics').map((d) => d.series.key));
    if (keys.size === 0) {
      this._statsDueAt = Infinity;
      return;
    }
    const seq = this._loadSeq;
    this._partial = 'statistics';
    this._partialSeq = seq;
    const startedAt = Date.now();
    try {
      const fresh = await loadSeriesData(hass, cfg, new Date(startedAt), { only: keys });
      if (seq !== this._loadSeq) return;
      this._rebind(fresh, cfg);
      const byKey = new Map(fresh.map((d) => [d.series.key, d]));
      const next = this._data.map((d) => byKey.get(d.series.key) ?? d);
      this._live.reset(next, hass);
      const current = this._hass;
      if (current && current !== hass) this._live.append(current);
      this._dataRefresh = true;
      this._data = next;
      this._statsDueAt = this._nextStatsDue(next, startedAt);
      this._error = undefined;
      this._reloadFailed = false;
    } catch (e) {
      if (seq !== this._loadSeq) return;
      this._fail(e);
    } finally {
      this._partialDone();
    }
  }

  private _partialDone(): void {
    this._partial = undefined;
    const gap = this._pendingGap;
    this._pendingGap = undefined;
    if (gap !== undefined && this.isConnected) void this._backfill(gap);
  }

  /** Live mode: next statistics refresh for `data` (Infinity without statistics series). */
  private _nextStatsDue(data: SeriesData[], now: number): number {
    const cfg = this._config;
    if (!cfg || cfg.update.mode !== 'live' || !data.some((d) => d.source === 'statistics')) return Infinity;
    return nextStatisticsRefresh(now, cfg.statisticsPeriod);
  }

  /** `update: <interval>`: a full reload is due. */
  private _reloadDue(now: number): boolean {
    const cfg = this._config;
    return !!cfg && cfg.update.mode === 'interval' && this._loaded && now - this._loadedAt >= cfg.update.intervalMs - TIMER_SLACK_MS;
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
    const cfg = this._config;
    if (!this.isConnected || document.hidden || !cfg || !this._hass) return;
    if (!this._loaded || this._haveSig !== this._wantSig) {
      this._maybeLoad(); // initial load / config change, also retries a failed one
      return;
    }
    this._scheduleRedraw(2); // re-anchor window + trim
    if ((this._hass as HassRuntimeExtras).connected === false) return; // wait for the reconnect
    const now = Date.now();
    if (this._reloadFailed) {
      // Also after a failed reload of already loaded data (e.g. HA still starting after a reconnect).
      if (now >= this._retryAt) void this._load();
      return;
    }
    if (this._reloadDue(now) || this._newAlignedWindow()) void this._load();
    else if (cfg.update.mode === 'live' && now >= this._statsDueAt) void this._refreshStatistics();
  }

  /** `span.start`: the aligned window moved on (a new day began) since the last load. */
  private _newAlignedWindow(): boolean {
    const cfg = this._config;
    return !!cfg && cfg.spanStart !== null && cfg.update.mode !== 'none' && this._loaded && this._window().start !== this._loadedStart;
  }

  private readonly _onVisibilityChange = (): void => {
    if (document.hidden) {
      this._hiddenAt ??= Date.now();
      return;
    }
    const hiddenAt = this._hiddenAt;
    this._hiddenAt = undefined;
    const cfg = this._config;
    if (!cfg || !this._hass || !this.isConnected) return;
    if (!this._loaded) {
      this._maybeLoad();
      return;
    }
    this._scheduleRedraw(2);
    if ((this._hass as HassRuntimeExtras).connected === false) return;
    const now = Date.now();
    if (this._reloadFailed ? now >= this._retryAt : this._reloadDue(now)) void this._load();
    else if (cfg.update.mode === 'live' && hiddenAt !== undefined && now - hiddenAt >= HIDDEN_STALE_MS) this._catchUp(hiddenAt);
    else if (cfg.update.mode === 'live' && now >= this._statsDueAt) void this._refreshStatistics();
    else this._maybeLoad();
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
    this._chart.on('datazoom', this._onDataZoom);
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
      this._chart.off('datazoom', this._onDataZoom);
      if (!this._chart.isDisposed()) this._chart.dispose();
    }
    this._chart = undefined;
    this._chartEl = undefined;
  }

  private _scheduleResize(): void {
    if (this._resizeRaf !== undefined) return;
    this._resizeRaf = requestAnimationFrame(() => {
      this._resizeRaf = undefined;
      if (!this._chart || this._chart.isDisposed()) return;
      this._chart.resize();
      // Point reduction and tick count follow the size: rebuild after larger changes.
      const [w, h] = this._builtSize;
      const el = this._chartEl;
      const changed = (a: number, b: number): boolean => (a > 0 ? Math.abs(b - a) / a > RESIZE_REBUILD_RATIO : b > 0);
      if (el && (changed(w, el.clientWidth) || changed(h, el.clientHeight))) this._applyChart(false);
    });
  }

  private _currentTheme(): ThemeColors {
    if (!this._theme) this._theme = readTheme(this, this._hass?.themes?.darkMode ?? false);
    return this._theme;
  }

  /** "Now" of the chart: the current time, or the load time for `update: none`. */
  private _windowEnd(): number {
    return this._config?.update.mode === 'none' && this._loadedAt ? this._loadedAt : Date.now();
  }

  /** The visible window at `_windowEnd()` (see chartWindow). */
  private _window(): ChartWindow {
    const cfg = this._config;
    const now = this._windowEnd();
    if (!cfg) return { start: now, end: now };
    return chartWindow(cfg.spanMs, cfg.spanStart, now, bucketTimeZone(this._hass));
  }

  /**
   * Grid (sections) layout: fill the cell only when the user gave it a fixed number of rows
   * (like HA's history graph card); otherwise the card sizes to `height`.
   */
  private _fillsCell(cfg: NormalizedConfig): boolean {
    if (this.layout !== 'grid') return false;
    const grid = (cfg.raw as { grid_options?: { rows?: unknown } }).grid_options;
    return typeof grid?.rows === 'number';
  }

  /**
   * Push the current state into ECharts. `full`: rebuild from scratch (notMerge) - config,
   * theme or new dataset. Otherwise a cheap merge (series / y axes / visual maps replaced by id,
   * lazy, no animation), which keeps the zoom window and an open tooltip.
   */
  private _applyChart(full: boolean): void {
    const chart = this._chart;
    const cfg = this._config;
    const hass = this._hass;
    if (!chart || chart.isDisposed() || !cfg || !hass || !this._loaded) return;
    let option: EChartsCoreOption;
    const width = this._chartEl?.clientWidth ?? 0;
    const height = this._chartEl?.clientHeight ?? 0;
    try {
      option = buildOptions(cfg, this._data, this._currentTheme(), {
        hass,
        now: this._windowEnd(),
        resolveColor: (c) => resolveColor(this, c),
        hiddenKeys: this._hiddenKeys,
        animate: full,
        width: width || undefined,
        height: height || undefined,
        zoom: this._zoom,
        touch: this._touch,
        zoomModifier: this._zoomModifier,
      });
    } catch (e) {
      this._error = `Could not render chart: ${errorMessage(e)}`;
      return;
    }
    this._builtSize = [width, height];
    if (full) {
      chart.setOption(option, { notMerge: true });
    } else {
      chart.setOption({ ...option, animation: false }, { replaceMerge: ['series', 'yAxis', 'visualMap'], lazyUpdate: true, silent: true });
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
      if (cfg.update.mode !== 'none') this._live.trim(this._window().start);
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

  // ---------------------------------------------------------------------------
  // Zoom
  // ---------------------------------------------------------------------------

  /** Track the zoom window; re-reduce the visible range (finer points) once the gesture settles. */
  private readonly _onDataZoom = (e: unknown): void => {
    const ev = e as { start?: unknown; end?: unknown; batch?: Array<{ start?: unknown; end?: unknown }> } | undefined;
    const b = ev?.batch?.[0] ?? ev;
    const start = b?.start;
    const end = b?.end;
    if (typeof start !== 'number' || typeof end !== 'number') return;
    this._zoom = start > 0.01 || end < 99.99 ? { start, end } : undefined;
    if (this._zoomTimer !== undefined) clearTimeout(this._zoomTimer);
    this._zoomTimer = setTimeout(() => {
      this._zoomTimer = undefined;
      this._applyChart(false);
    }, ZOOM_DEBOUNCE_MS);
  };

  /** Ctrl enables wheel zoom (show.zoom, mouse): ECharts otherwise swallows page scrolling. */
  private readonly _onKey = (e: KeyboardEvent): void => {
    this._setZoomModifier(e.ctrlKey);
  };

  private readonly _onBlur = (): void => {
    this._setZoomModifier(false);
  };

  private _setZoomModifier(pressed: boolean): void {
    if (pressed === this._zoomModifier) return;
    this._zoomModifier = pressed;
    if (this._config?.show.zoom && !this._touch) this._applyChart(false);
  }

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
