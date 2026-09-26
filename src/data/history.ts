import type {
  HassEntityState,
  HistoryDuringPeriodMessage,
  HistoryResponse,
  HistoryState,
  HomeAssistant,
  Point,
} from '../types';

/** Options for fetchHistory. */
export interface HistoryFetchOptions {
  /**
   * Read this attribute instead of the state for ALL `entityIds` in the call. Forces
   * `no_attributes: false` and `minimal_response: false` (minimal rows carry no attributes)
   * and uses `lu` (last_updated) as the timestamp. The loader issues one call per distinct
   * attribute plus one call for all state-based series.
   */
  attribute?: string;
}

/** Domains whose on/off-style states are plotted as 0/1 step lines. */
export const BINARY_DOMAINS: readonly string[] = [
  'binary_sensor',
  'input_boolean',
  'switch',
  'light',
  'fan',
  'automation',
  'schedule',
  'lock',
  'cover',
  'person',
  'device_tracker',
];

/** Raw state string -> 0/1 for binary-ish states (lower-cased keys). */
export const BINARY_STATE_MAP: Readonly<Record<string, 0 | 1>> = {
  on: 1,
  off: 0,
  true: 1,
  false: 0,
  open: 1,
  opening: 1,
  closed: 0,
  closing: 0,
  home: 1,
  not_home: 0,
  unlocked: 1,
  locked: 0,
  detected: 1,
  clear: 0,
};

/** States that mean "no value" (line gap). */
const NULL_STATES = new Set(['', 'unknown', 'unavailable', 'none', 'null', 'nan']);

/** Plain decimal / scientific number (rejects hex, `Infinity`, `1_000`, `12abc`, ...). */
const NUMERIC_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/;

/**
 * HA's `valid_entity_id` (homeassistant/core.py): lower-case `domain.object_id` slugs.
 * history/history_during_period rejects the WHOLE call (`invalid_entity_ids`) when any requested
 * id is neither in hass.states nor matches this.
 */
const VALID_ENTITY_ID = /^(?!.+__)(?!_)[\da-z_]+(?<!_)\.(?!_)[\da-z_]+(?<!_)$/;
/** HA's `valid_statistic_id` for external statistics (`source:statistic_id`). */
const VALID_STATISTIC_ID = /^(?!.+__)(?!_)[\da-z_]+(?<!_):(?!_)[\da-z_]+(?<!_)$/;

/** True for ids Home Assistant accepts as entity ids (`sensor.living_room`). */
export function isValidEntityId(id: string): boolean {
  return VALID_ENTITY_ID.test(id);
}

/** True for external statistic ids (`source:statistic_id`); these only exist in long-term statistics. */
export function isExternalStatistic(id: string): boolean {
  return VALID_STATISTIC_ID.test(id);
}

/**
 * Convert an HA state (or attribute value) to a number.
 * - number -> itself if finite, else null
 * - boolean -> 1/0
 * - string: trimmed, lower-cased; `''`/`unknown`/`unavailable`/`none` -> null;
 *   BINARY_STATE_MAP keys -> 0/1; otherwise a plain decimal number, else null.
 * - anything else (objects, arrays, undefined) -> null
 */
export function stateToNumber(s: unknown): number | null {
  if (typeof s === 'number') return Number.isFinite(s) ? s : null;
  if (typeof s === 'boolean') return s ? 1 : 0;
  if (typeof s !== 'string') return null;
  const k = s.trim().toLowerCase();
  if (NULL_STATES.has(k)) return null;
  const b = BINARY_STATE_MAP[k];
  if (b !== undefined) return b;
  if (!NUMERIC_RE.test(k)) return null;
  const n = Number(k);
  return Number.isFinite(n) ? n : null;
}

/**
 * Domains whose state set is richer than on/off, mapped to the one state that means 0; every
 * other available state means 1 (and vice versa for person/device_tracker: only `home` is 1).
 * - cover: `closed` = 0; open / opening / closing / stopped = 1 (not closed yet).
 * - lock: `locked` = 0; unlocked / unlocking / locking / jammed / open / opening = 1.
 * - person / device_tracker: `home` = 1; not_home and named zones ("Work") = 0.
 */
const DOMAIN_ZERO_STATE: Readonly<Record<string, string>> = { cover: 'closed', lock: 'locked' };
const DOMAIN_ONE_STATE: Readonly<Record<string, string>> = { person: 'home', device_tracker: 'home' };

/**
 * The two native states a binary series of `entityId` switches between, as `[state for 0,
 * state for 1]` (used to translate 0/1 back with hass.formatEntityState): cover closed/open,
 * lock locked/unlocked, person/device_tracker not_home/home, other on/off-like states their own
 * pair (`current` = the entity's current state picks e.g. closed/open for a template sensor),
 * else off/on.
 */
export function binaryStatePair(entityId: string, current?: string): [string, string] {
  switch (domainOf(entityId)) {
    case 'cover':
      return ['closed', 'open'];
    case 'lock':
      return ['locked', 'unlocked'];
    case 'person':
    case 'device_tracker':
      return ['not_home', 'home'];
    default:
      break;
  }
  const k = current?.trim().toLowerCase();
  if (k !== undefined && BINARY_STATE_MAP[k] !== undefined) {
    for (const pair of BINARY_PAIRS) if (pair.includes(k)) return pair;
  }
  return ['off', 'on'];
}

/** On/off-like state pairs `[0, 1]` of BINARY_STATE_MAP. */
const BINARY_PAIRS: ReadonlyArray<[string, string]> = [
  ['off', 'on'],
  ['false', 'true'],
  ['closed', 'open'],
  ['not_home', 'home'],
  ['locked', 'unlocked'],
  ['clear', 'detected'],
];

/**
 * Number for the STATE of `entityId` (attribute series use stateToNumber on the attribute
 * value instead). Like stateToNumber, but domain aware for entities with more than two states
 * (see DOMAIN_ZERO_STATE / DOMAIN_ONE_STATE): a person in the "Work" zone is 0 (away), a
 * `jammed` lock or a `stopped` cover is 1, instead of a line gap. `unavailable` / `unknown`
 * stay null.
 */
export function entityStateToNumber(entityId: string, s: unknown): number | null {
  const domain = domainOf(entityId);
  const zero = DOMAIN_ZERO_STATE[domain];
  const one = DOMAIN_ONE_STATE[domain];
  if ((zero === undefined && one === undefined) || typeof s !== 'string') return stateToNumber(s);
  const k = s.trim().toLowerCase();
  if (NULL_STATES.has(k)) return null;
  if (zero !== undefined) return k === zero ? 0 : 1;
  return k === one ? 1 : 0;
}

/** Value of series state/attribute `raw` (domain aware for state series). */
export function seriesValue(entityId: string, raw: unknown, attribute?: string): number | null {
  return attribute ? stateToNumber(raw) : entityStateToNumber(entityId, raw);
}

/** `sensor.x` -> `sensor`; external statistic ids (`source:id`) have no domain -> `''`. */
export function domainOf(entityId: string): string {
  const dot = entityId.indexOf('.');
  return dot > 0 && !entityId.slice(0, dot).includes(':') ? entityId.slice(0, dot) : '';
}

/**
 * True if the series should render as a 0/1 step line: the entity's domain is in
 * BINARY_DOMAINS, or (when `state` is given) its current state string is a BINARY_STATE_MAP key.
 * Always false for attribute series (caller passes `attribute`).
 */
export function isBinaryEntity(entityId: string, state?: HassEntityState, attribute?: string): boolean {
  if (attribute) return false;
  if (BINARY_DOMAINS.includes(domainOf(entityId))) return true;
  if (state && typeof state.state === 'string') {
    return BINARY_STATE_MAP[state.state.trim().toLowerCase()] !== undefined;
  }
  return false;
}

/** Epoch seconds (float) -> ms; NaN for missing/invalid. */
function secToMs(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 1000) : Number.NaN;
}

/**
 * Convert the compressed history rows of ONE entity to points (ascending, unique timestamps,
 * clamped to `startMs`). `entityId` makes state values domain aware (entityStateToNumber).
 * Exported for tests / reuse.
 */
export function historyRowsToPoints(rows: HistoryState[] | undefined, startMs: number, attribute?: string, entityId = ''): Point[] {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const pts: Point[] = [];
  let sorted = true;
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    // State series: last_changed (lc is omitted when equal to lu; minimal rows carry it in lu).
    // Attribute series: last_updated (attribute changes don't touch last_changed).
    const raw = attribute ? secToMs(row.lu) : secToMs(row.lc ?? row.lu);
    if (Number.isNaN(raw)) continue;
    const t = raw < startMs ? startMs : raw;
    const v = attribute ? stateToNumber(row.a?.[attribute]) : entityStateToNumber(entityId, row.s);
    if (pts.length && t < pts[pts.length - 1][0]) sorted = false;
    pts.push([t, v]);
  }
  if (!sorted) pts.sort((a, b) => a[0] - b[0]); // stable: equal timestamps keep response order
  // Dedupe equal timestamps, keeping the last value.
  const out: Point[] = [];
  for (const p of pts) {
    if (out.length && out[out.length - 1][0] === p[0]) out[out.length - 1] = p;
    else out.push(p);
  }
  return out;
}

/**
 * Fetch recorder history for `entityIds` over [start, end] in ONE WebSocket call:
 * `{ type: 'history/history_during_period', start_time, end_time, entity_ids,
 *    minimal_response: !attribute, no_attributes: !attribute, significant_changes_only: false }`
 * (see HistoryDuringPeriodMessage / HistoryResponse in types.ts).
 *
 * Returns `entity_id -> Point[]` (ascending, deduped timestamps; every requested id present,
 * `[]` when no rows). Timestamps: seconds -> ms; state series use `lc ?? lu`, attribute series
 * use `lu`; points before `start` (the state valid at the window start) are clamped to `start`.
 * Values via stateToNumber (on the attribute value when `opts.attribute` is set);
 * unavailable/unknown/non-numeric become `null` (line gap). No synthetic trailing point is added
 * (buildOptions extends history lines to `now`).
 * Rejects if callWS rejects. Empty `entityIds` resolves to `{}` without a call.
 */
export async function fetchHistory(
  hass: HomeAssistant,
  entityIds: string[],
  start: Date,
  end: Date,
  opts: HistoryFetchOptions = {},
): Promise<Record<string, Point[]>> {
  const ids = [...new Set(entityIds)];
  if (ids.length === 0) return {};
  const attribute = opts.attribute || undefined;
  const msg: HistoryDuringPeriodMessage = {
    type: 'history/history_during_period',
    start_time: start.toISOString(),
    end_time: end.toISOString(),
    entity_ids: ids,
    minimal_response: !attribute,
    no_attributes: !attribute,
    significant_changes_only: false,
  };
  const res = await hass.callWS<HistoryResponse | null>(msg);
  const startMs = start.getTime();
  const out: Record<string, Point[]> = {};
  for (const id of ids) out[id] = historyRowsToPoints(res?.[id], startMs, attribute, id);
  return out;
}
