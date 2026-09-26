import { notImplemented } from '../stub';
import type { GroupByFunc, NormalizedTransform, Point } from '../types';

/**
 * Start of the bucket containing `t`: `Math.floor(t / durationMs) * durationMs` (UTC-epoch
 * aligned, so buckets are stable across refetches and live appends).
 */
export function bucketStart(t: number, durationMs: number): number {
  return notImplemented('bucketStart', t, durationMs);
}

/**
 * Aggregate one bucket's values (nulls already removed by the caller; non-empty).
 * avg = mean, median = middle (mean of the two middles), first/last by position,
 * sum, min, max, delta = last - first.
 */
export function aggregate(values: number[], func: GroupByFunc): number {
  return notImplemented('aggregate', values, func);
}

/**
 * Bucket `points` (ascending) into fixed windows of `durationMs` (see bucketStart).
 * Emits one point per non-empty bucket at the bucket START: `[bucketStart, aggregate(values)]`.
 * Null values are ignored; a bucket containing only nulls emits `[bucketStart, null]` (keeps
 * the gap). Empty buckets emit nothing. Pure; never mutates the input. `durationMs <= 0`
 * returns a copy of the input.
 */
export function groupBy(points: Point[], func: GroupByFunc, durationMs: number): Point[] {
  return notImplemented('groupBy', points, func, durationMs);
}

/**
 * Apply `v * multiply + offset` to every non-null value. Pure: returns a new array, or the
 * same array reference when `t` is the identity (`multiply 1, offset 0`).
 */
export function applyTransform(points: Point[], t: NormalizedTransform): Point[] {
  return notImplemented('applyTransform', points, t);
}

/** Scalar version of applyTransform (null stays null). Used for live values / header. */
export function transformValue(v: number | null, t: NormalizedTransform): number | null {
  return notImplemented('transformValue', v, t);
}
