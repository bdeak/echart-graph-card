/**
 * Mock Home Assistant `hass` object for the dev harness.
 *
 * - `states` for the synthetic entities in ./synth.ts, refreshed every `tickMs` (default 2 s)
 *   exactly like HA does it: a NEW hass object and a NEW `states` object on every change,
 *   unchanged entity objects keep their identity, `last_changed` moves only when the state
 *   string changes, `last_updated` also moves on attribute changes.
 * - `callWS` answers:
 *     history/history_during_period      (compressed states, epoch-second timestamps)
 *     recorder/statistics_during_period  (5minute/hour/day/week/month; mean/min/max/state/sum/change)
 *     recorder/get_statistics_metadata
 *   with realistic latency. Unknown commands reject with `{ code, message }` like HA.
 * - locale / config time zone Europe/Berlin, `themes.darkMode` toggle.
 */
import type {
  HassEntityRegistryDisplayEntry,
  HassEntityState,
  HassLocale,
  HassMessage,
  HistoryResponse,
  HistoryState,
  HomeAssistant,
  StatisticType,
  StatisticValue,
  StatisticsPeriod,
  StatisticsResponse,
} from '../src/types';
import { DAY, HOUR, HomeModel, MINUTE, SECOND, TIME_ZONE, buildEntities, dayOfWeek, localDay, localMidnight, monthBounds } from './synth';
import type { EntityDef } from './synth';

export interface MockHassOptions {
  dark?: boolean;
  /** hass.locale.language, default `en`. */
  language?: string;
  /** hass.locale.time_zone: `server` (default, = Europe/Berlin) or `local` (browser zone). */
  timeZone?: 'server' | 'local';
  /** hass.locale.time_format, default `24`. */
  timeFormat?: HassLocale['time_format'];
  /** Synthetic data seed. */
  seed?: number;
  /** Model time = real time + shiftMs (see `?at=` in main.ts). */
  shiftMs?: number;
  /** Simulated WebSocket round-trip range in ms. Default [60, 220]. */
  latencyMs?: [number, number];
  /** Live state update period. Default 2000 ms. */
  tickMs?: number;
  /** Cap on history samples per entity and request (like a busy recorder). Default 20000. */
  maxHistoryPoints?: number;
  /** Log every WS call to the console. */
  debug?: boolean;
}

/** Extra members a real `hass` has that the card does not rely on. */
export type MockHass = HomeAssistant & {
  /** WebSocket connection state; the card reloads when it goes false -> true. */
  connected: boolean;
  user: { id: string; name: string; is_admin: boolean; is_owner: boolean };
  callService(domain: string, service: string, data?: Record<string, unknown>): Promise<void>;
  localize(key: string): string;
  /** Translated state text, like the frontend's `hass.formatEntityState` (HA 2023.9+). */
  formatEntityState(stateObj: HassEntityState, state?: string): string;
  selectedTheme: { theme: string; dark?: boolean } | null;
};

export interface WsCallRecord {
  type: string;
  at: number;
  ms: number;
  ok: boolean;
  summary: string;
}

interface HaError {
  code: string;
  message: string;
}

/** Domains for which HA always returns full states, even with minimal_response. */
const NEED_ATTRIBUTE_DOMAINS = new Set(['climate', 'humidifier', 'input_datetime', 'water_heater']);

const STATISTIC_TYPES: readonly StatisticType[] = ['mean', 'min', 'max', 'sum', 'state', 'change'];
const PERIODS: readonly StatisticsPeriod[] = ['5minute', 'hour', 'day', 'week', 'month'];

const iso = (t: number): string => new Date(t).toISOString();

/** The few frontend translations the card may ask for (`hass.localize`). */
const TRANSLATIONS: Record<string, string> = {
  'component.binary_sensor.entity_component._.state.on': 'On',
  'component.binary_sensor.entity_component._.state.off': 'Off',
  'state.default.unavailable': 'Unavailable',
  'state.default.unknown': 'Unknown',
};

/** binary_sensor device classes with their own state names (subset of HA's translations). */
const BINARY_STATE_NAMES: Record<string, [string, string]> = {
  door: ['Closed', 'Open'],
  garage_door: ['Closed', 'Open'],
  window: ['Closed', 'Open'],
  opening: ['Closed', 'Open'],
  motion: ['Clear', 'Detected'],
  occupancy: ['Clear', 'Detected'],
  moisture: ['Dry', 'Wet'],
};

/** Minimal `hass.formatEntityState`: translated binary states, else the state humanized. */
function formatEntityState(stateObj: HassEntityState, state?: string): string {
  const s = state ?? stateObj.state;
  if (s === 'unavailable' || s === 'unknown') return TRANSLATIONS[`state.default.${s}`];
  const domain = stateObj.entity_id.split('.')[0];
  if (domain === 'binary_sensor' && (s === 'on' || s === 'off')) {
    const names = BINARY_STATE_NAMES[String(stateObj.attributes.device_class ?? '')] ?? ['Off', 'On'];
    return names[s === 'on' ? 1 : 0];
  }
  const unit = stateObj.attributes.unit_of_measurement;
  if (s.trim() !== '' && Number.isFinite(Number(s))) return unit ? `${s} ${unit}` : s;
  const t = s.replace(/_/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function haError(code: string, message: string): HaError {
  return { code, message };
}

function parseTime(v: unknown, field: string): number {
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  if (!Number.isFinite(t)) throw haError('invalid_format', `Invalid ${field}`);
  return t;
}

export class MockHassController {
  hass: MockHass;
  readonly model: HomeModel;
  readonly entities: EntityDef[];
  readonly calls: WsCallRecord[] = [];
  readonly callCounts: Record<string, number> = {};
  ticks = 0;

  private readonly opts: Required<Omit<MockHassOptions, 'timeFormat'>> & { timeFormat: HassLocale['time_format'] };
  private readonly byId = new Map<string, EntityDef>();
  private readonly listeners = new Set<(hass: MockHass) => void>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private contextSeq = 0;

  constructor(options: MockHassOptions = {}) {
    this.opts = {
      dark: options.dark ?? false,
      language: options.language ?? 'en',
      timeZone: options.timeZone ?? 'server',
      timeFormat: options.timeFormat ?? '24',
      seed: options.seed ?? 1,
      shiftMs: options.shiftMs ?? 0,
      latencyMs: options.latencyMs ?? [60, 220],
      tickMs: options.tickMs ?? 2000,
      maxHistoryPoints: options.maxHistoryPoints ?? 20_000,
      debug: options.debug ?? false,
    };
    this.model = new HomeModel({ seed: this.opts.seed, now: Date.now() + this.opts.shiftMs });
    this.entities = buildEntities(this.model, this.opts.shiftMs);
    for (const e of this.entities) this.byId.set(e.entity_id, e);
    this.hass = this.createHass();
  }

  // ---- public API ----------------------------------------------------------

  /** Called with every new hass object (state tick, dark mode change). Returns unsubscribe. */
  subscribe(fn: (hass: MockHass) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  get running(): boolean {
    return this.timer !== undefined;
  }

  start(): void {
    if (this.timer === undefined) this.timer = setInterval(() => this.tick(), this.opts.tickMs);
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  setDarkMode(dark: boolean): void {
    if (this.hass.themes.darkMode === dark) return;
    this.opts.dark = dark;
    this.publish({ ...this.hass, themes: { ...this.hass.themes, darkMode: dark }, selectedTheme: { theme: 'default', dark } });
  }

  /**
   * Simulate a WebSocket drop: `connected: false` (no state updates) for `downMs`, then
   * `connected: true` with fresh states, like HA after a reconnect.
   */
  simulateDisconnect(downMs = 3000): void {
    if (!this.hass.connected) return;
    const wasRunning = this.running;
    this.stop();
    this.publish({ ...this.hass, connected: false });
    setTimeout(() => {
      this.publish({ ...this.hass, connected: true });
      this.tick();
      if (wasRunning) this.start();
    }, downMs);
  }

  /** Advance live states to "now". Returns true when at least one entity changed. */
  tick(now: number = Date.now()): boolean {
    this.ticks++;
    const nowIso = iso(now);
    const prev = this.hass.states;
    let next: Record<string, HassEntityState> | undefined;
    for (const def of this.entities) {
      const cur = prev[def.entity_id];
      const state = def.state(now);
      const dyn = def.dynamicAttributes?.(now);
      const stateChanged = state !== cur.state;
      const attrsChanged = dyn !== undefined && Object.entries(dyn).some(([k, v]) => cur.attributes[k] !== v);
      if (!stateChanged && !attrsChanged) continue;
      next ??= { ...prev };
      next[def.entity_id] = {
        entity_id: def.entity_id,
        state,
        attributes: { ...def.attributes, ...dyn },
        last_changed: stateChanged ? nowIso : cur.last_changed,
        last_updated: nowIso,
        context: this.context(),
      };
    }
    if (!next) return false;
    this.publish({ ...this.hass, states: next });
    return true;
  }

  // ---- hass construction -----------------------------------------------------

  private createHass(): MockHass {
    const now = Date.now();
    const states: Record<string, HassEntityState> = {};
    const registry: Record<string, HassEntityRegistryDisplayEntry> = {};
    for (const def of this.entities) {
      states[def.entity_id] = this.initialState(def, now);
      registry[def.entity_id] = {
        entity_id: def.entity_id,
        platform: 'mock',
        ...(def.displayPrecision !== undefined ? { display_precision: def.displayPrecision } : {}),
      };
    }
    return {
      states,
      entities: registry,
      connected: true,
      callWS: <T>(msg: HassMessage): Promise<T> => this.callWS(msg) as Promise<T>,
      connection: {
        subscribeMessage: async <T>(callback: (msg: T) => void, msg: HassMessage): Promise<() => Promise<void>> => {
          void callback;
          console.warn(`[mock-hass] subscribeMessage(${msg.type}) is not simulated`);
          return async () => undefined;
        },
      },
      locale: {
        language: this.opts.language,
        number_format: 'language',
        time_format: this.opts.timeFormat,
        time_zone: this.opts.timeZone,
      },
      language: this.opts.language,
      config: {
        time_zone: TIME_ZONE,
        location_name: 'Home',
        country: 'DE',
        currency: 'EUR',
        version: '2026.9.0',
        unit_system: { temperature: '°C', length: 'km', mass: 'kg', volume: 'L', pressure: 'hPa' },
      },
      themes: { darkMode: this.opts.dark, theme: 'default', default_theme: 'default', default_dark_theme: null, themes: {} },
      selectedTheme: { theme: 'default', dark: this.opts.dark },
      user: { id: 'mock-user', name: 'Dev', is_admin: true, is_owner: true },
      callService: async (domain, service, data) => {
        console.info(`[mock-hass] callService ${domain}.${service}`, data ?? {});
      },
      // Like the real frontend: unknown keys translate to '' (callers fall back to their own text).
      localize: (key) => TRANSLATIONS[key] ?? '',
      formatEntityState: (stateObj, state) => formatEntityState(stateObj, state),
    };
  }

  /** Current state with realistic last_changed / last_updated (found by scanning back). */
  private initialState(def: EntityDef, now: number): HassEntityState {
    const state = def.state(now);
    const dyn = def.dynamicAttributes?.(now);
    const key = (t: number): string => def.state(t) + (def.dynamicAttributes ? JSON.stringify(def.dynamicAttributes(t)) : '');
    const curKey = key(now);
    let lastChanged = now - 2000 * def.sampleMs;
    let lastUpdated: number | undefined;
    if (def.transitions) {
      const tr = def.transitions(now - 7 * DAY, now);
      lastChanged = tr.length ? tr[tr.length - 1] : now - 7 * DAY;
    } else {
      for (let i = 1; i <= 2000; i++) {
        const t = now - i * def.sampleMs;
        // `key` includes the state, so the first key difference is never older than the state change.
        if (lastUpdated === undefined && key(t) !== curKey) lastUpdated = t + def.sampleMs;
        if (def.state(t) !== state) {
          lastChanged = t + def.sampleMs;
          break;
        }
      }
    }
    if (lastUpdated === undefined || lastUpdated < lastChanged) lastUpdated = lastChanged;
    return {
      entity_id: def.entity_id,
      state,
      attributes: { ...def.attributes, ...dyn },
      last_changed: iso(lastChanged),
      last_updated: iso(lastUpdated),
      context: this.context(),
    };
  }

  private context(): { id: string; parent_id: null; user_id: null } {
    this.contextSeq++;
    return { id: `01MOCK${this.contextSeq.toString(36).toUpperCase().padStart(20, '0')}`, parent_id: null, user_id: null };
  }

  private publish(hass: MockHass): void {
    this.hass = hass;
    for (const fn of this.listeners) fn(hass);
  }

  // ---- WebSocket -------------------------------------------------------------

  private async callWS(msg: HassMessage): Promise<unknown> {
    const started = performance.now();
    const [lo, hi] = this.opts.latencyMs;
    const record = (ok: boolean, summary: string): void => {
      const rec = { type: msg.type, at: Date.now(), ms: Math.round(performance.now() - started), ok, summary };
      this.calls.push(rec);
      if (this.calls.length > 200) this.calls.shift();
      this.callCounts[msg.type] = (this.callCounts[msg.type] ?? 0) + 1;
      if (this.opts.debug) console.debug(`[mock-hass] ${msg.type} ${ok ? 'ok' : 'FAILED'} in ${rec.ms} ms: ${summary}`, msg);
    };
    let result: unknown;
    try {
      result = this.handle(msg);
    } catch (e) {
      await new Promise((r) => setTimeout(r, lo));
      const err = (e as HaError).code ? (e as HaError) : haError('unknown_error', String(e));
      record(false, err.message);
      throw err;
    }
    await new Promise((r) => setTimeout(r, lo + Math.random() * (hi - lo)));
    record(true, summarize(result));
    return result;
  }

  private handle(msg: HassMessage): unknown {
    switch (msg.type) {
      case 'history/history_during_period':
        return this.history(msg);
      case 'recorder/statistics_during_period':
        return this.statistics(msg);
      case 'recorder/get_statistics_metadata':
        return this.statisticsMetadata(msg);
      default:
        throw haError('unknown_command', `Unknown command: ${msg.type}`);
    }
  }

  private history(msg: HassMessage): HistoryResponse {
    const now = Date.now();
    const start = parseTime(msg.start_time, 'start_time');
    const end = Math.min(msg.end_time === undefined ? now : parseTime(msg.end_time, 'end_time'), now);
    if (!Array.isArray(msg.entity_ids) || msg.entity_ids.length === 0) throw haError('invalid_format', 'entity_ids is required');
    const minimal = msg.minimal_response === true;
    const noAttributes = msg.no_attributes === true;
    const out: HistoryResponse = {};
    if (end <= start) return out;
    for (const id of msg.entity_ids as unknown[]) {
      const def = typeof id === 'string' ? this.byId.get(id) : undefined;
      if (!def) continue; // HA omits unknown entities / entities without history
      out[def.entity_id] = this.historyFor(def, start, end, minimal, noAttributes);
    }
    return out;
  }

  private historyFor(def: EntityDef, start: number, end: number, minimal: boolean, noAttributes: boolean): HistoryState[] {
    const domain = def.entity_id.split('.')[0];
    const full = !minimal || NEED_ATTRIBUTE_DOMAINS.has(domain);
    const attrs = (t: number): Record<string, unknown> => (noAttributes ? {} : { ...def.attributes, ...def.dynamicAttributes?.(t) });
    const dynKey = (t: number): string => (def.dynamicAttributes ? JSON.stringify(def.dynamicAttributes(t)) : '');
    const sec = (t: number): number => Math.round(t) / 1000;

    // First entry: the state valid at start_time, stamped with start_time (always full).
    let prevState = def.state(start);
    let prevDyn = dynKey(start);
    let lastChange = start;
    const out: HistoryState[] = [{ s: prevState, a: attrs(start), lu: sec(start) }];

    let times: Iterable<number>;
    if (def.transitions) {
      times = def.transitions(start, end).filter((t) => t > start);
    } else {
      const step = Math.max(def.sampleMs, Math.ceil((end - start) / this.opts.maxHistoryPoints / SECOND) * SECOND);
      times = (function* () {
        for (let t = Math.floor(start / step) * step + step; t <= end; t += step) yield t;
      })();
    }

    for (const t of times) {
      const s = def.state(t);
      const d = dynKey(t);
      const stateChanged = s !== prevState;
      const attrChanged = d !== prevDyn;
      if (!stateChanged && !(full && def.dynamicAttributes && attrChanged)) continue;
      if (stateChanged) lastChange = t;
      if (full) {
        const e: HistoryState = { s, a: attrs(t), lu: sec(t) };
        if (lastChange !== t) e.lc = sec(lastChange);
        out.push(e);
      } else {
        out.push({ s, lu: sec(t) });
      }
      prevState = s;
      prevDyn = d;
    }
    return out;
  }

  private statisticsMetadata(msg: HassMessage): unknown[] {
    const ids = Array.isArray(msg.statistic_ids) ? (msg.statistic_ids as string[]) : this.entities.map((e) => e.entity_id);
    return ids
      .map((id) => this.byId.get(id))
      .filter((d): d is EntityDef => d?.statistics !== undefined)
      .map((d) => ({
        statistic_id: d.entity_id,
        source: 'recorder',
        name: null,
        statistics_unit_of_measurement: d.attributes.unit_of_measurement ?? null,
        unit_class: d.attributes.device_class ?? null,
        has_mean: d.statistics === 'measurement',
        mean_type: d.statistics === 'measurement' ? 1 : 0,
        has_sum: d.statistics === 'total_increasing',
      }));
  }

  private statistics(msg: HassMessage): StatisticsResponse {
    const now = Date.now();
    const start = parseTime(msg.start_time, 'start_time');
    const end = Math.min(msg.end_time === undefined ? now : parseTime(msg.end_time, 'end_time'), now);
    const period = msg.period as StatisticsPeriod;
    if (!PERIODS.includes(period)) throw haError('invalid_format', `Invalid period: ${String(msg.period)}`);
    if (!Array.isArray(msg.statistic_ids) || msg.statistic_ids.length === 0) throw haError('invalid_format', 'statistic_ids is required');
    const requested = Array.isArray(msg.types) ? (msg.types as StatisticType[]).filter((t) => STATISTIC_TYPES.includes(t)) : STATISTIC_TYPES;
    const types = new Set<StatisticType>(requested.length ? requested : STATISTIC_TYPES);

    const buckets = bucketsFor(period, start, end, now);
    const out: StatisticsResponse = {};
    for (const id of msg.statistic_ids as unknown[]) {
      const def = typeof id === 'string' ? this.byId.get(id) : undefined;
      if (!def?.statistics || !def.value) continue; // no long-term statistics for this id
      const rows = def.statistics === 'measurement' ? measurementRows(def, buckets, types) : totalRows(def, buckets, types, this.model.origin);
      if (rows.length) out[def.entity_id] = rows;
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Statistics helpers
// ---------------------------------------------------------------------------

/** Completed buckets with start in [start, end) (HA filters on `start >= start_time`). */
function bucketsFor(period: StatisticsPeriod, start: number, end: number, now: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const push = (s: number, e: number): boolean => {
    if (s >= end) return false;
    if (s >= start && e <= now) out.push([s, e]);
    return true;
  };
  if (period === '5minute' || period === 'hour') {
    const step = period === 'hour' ? HOUR : 5 * MINUTE;
    for (let s = Math.ceil(start / step) * step; push(s, s + step); s += step);
    return out;
  }
  let day = localDay(start);
  if (period === 'week') day -= (dayOfWeek(day) + 6) % 7; // back to Monday
  if (period === 'month') day = monthBounds(day)[0];
  for (;;) {
    const nextDay = period === 'day' ? day + 1 : period === 'week' ? day + 7 : monthBounds(day)[1];
    if (!push(localMidnight(day), localMidnight(nextDay))) break;
    day = nextDay;
  }
  return out;
}

function sampleStep(bucketMs: number): number {
  return Math.min(30 * MINUTE, Math.max(20 * SECOND, Math.round(bucketMs / 60)));
}

function measurementRows(def: EntityDef, buckets: Array<[number, number]>, types: Set<StatisticType>): StatisticValue[] {
  const rows: StatisticValue[] = [];
  const value = def.value as (t: number) => number | null;
  for (const [s, e] of buckets) {
    const step = sampleStep(e - s);
    let sum = 0;
    let n = 0;
    let min = Infinity;
    let max = -Infinity;
    for (let t = s; t < e; t += step) {
      const v = value(t);
      if (v === null) continue;
      sum += v;
      n++;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (n === 0) continue; // HA writes no row when the sensor was unavailable the whole period
    const row: StatisticValue = { start: s, end: e };
    if (types.has('mean')) row.mean = sum / n;
    if (types.has('min')) row.min = min;
    if (types.has('max')) row.max = max;
    if (types.has('state')) row.state = null;
    if (types.has('sum')) row.sum = null;
    if (types.has('change')) row.change = null;
    rows.push(row);
  }
  return rows;
}

function totalRows(def: EntityDef, buckets: Array<[number, number]>, types: Set<StatisticType>, origin: number): StatisticValue[] {
  const value = def.value as (t: number) => number | null;
  const base = value(origin) ?? 0;
  return buckets.map(([s, e]) => {
    const atEnd = value(e) ?? base;
    const atStart = value(s) ?? base;
    const row: StatisticValue = { start: s, end: e };
    if (types.has('mean')) row.mean = null;
    if (types.has('min')) row.min = null;
    if (types.has('max')) row.max = null;
    if (types.has('state')) row.state = Math.floor(atEnd);
    if (types.has('sum')) row.sum = Math.round((atEnd - base) * 1000) / 1000;
    if (types.has('change')) row.change = Math.round((atEnd - atStart) * 1000) / 1000;
    return row;
  });
}

function summarize(result: unknown): string {
  if (Array.isArray(result)) return `${result.length} items`;
  if (result && typeof result === 'object') {
    return Object.entries(result as Record<string, unknown>)
      .map(([k, v]) => `${k}=${Array.isArray(v) ? v.length : '?'}`)
      .join(', ');
  }
  return String(result);
}
