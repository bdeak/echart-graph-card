import { notImplemented } from '../stub';
import type { HassEntityState, HomeAssistant, Point } from '../types';

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

/**
 * Convert an HA state (or attribute value) to a number.
 * - number -> itself if finite, else null
 * - boolean -> 1/0
 * - string: trimmed, lower-cased; `''`/`unknown`/`unavailable`/`none` -> null;
 *   BINARY_STATE_MAP keys -> 0/1; otherwise Number(s) if finite, else null.
 * - anything else -> null
 */
export function stateToNumber(s: unknown): number | null {
  return notImplemented('stateToNumber', s);
}

/**
 * True if the series should render as a 0/1 step line: the entity's domain is in
 * BINARY_DOMAINS, or (when `state` is given) its current state string is a BINARY_STATE_MAP key.
 * Always false for attribute series (caller passes `attribute`).
 */
export function isBinaryEntity(entityId: string, state?: HassEntityState, attribute?: string): boolean {
  return notImplemented('isBinaryEntity', entityId, state, attribute);
}

/**
 * Fetch recorder history for `entityIds` over [start, end] in ONE WebSocket call:
 * `{ type: 'history/history_during_period', start_time, end_time, entity_ids,
 *    minimal_response: !attribute, no_attributes: !attribute, significant_changes_only: false }`
 * (see HistoryDuringPeriodMessage / HistoryResponse in types.ts).
 *
 * Returns `entity_id -> Point[]` (ascending, deduped timestamps; every requested id present,
 * `[]` when no rows). Timestamps: seconds -> ms; state series use `lc ?? lu`, attribute series
 * use `lu`; the first point is clamped to `start`. Values via stateToNumber (on the attribute
 * value when `opts.attribute` is set); unavailable/unknown become `null` (line gap).
 * Rejects if callWS rejects. Empty `entityIds` resolves to `{}` without a call.
 */
export async function fetchHistory(
  hass: HomeAssistant,
  entityIds: string[],
  start: Date,
  end: Date,
  opts: HistoryFetchOptions = {},
): Promise<Record<string, Point[]>> {
  return notImplemented('fetchHistory', hass, entityIds, start, end, opts);
}
