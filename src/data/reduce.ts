import type { Point } from '../types';

/**
 * Point reduction for drawing, and window extrema, over large live-updated series.
 *
 * Points are grouped into time blocks aligned to multiples of `blockMs` (epoch based, so blocks
 * stay stable while the window slides). Per block we keep
 * - an M4 reduction: its first, min, max and last sample plus its first gap (null), in time
 *   order. Drawn as a line (or step line) this is pixel-identical to drawing every sample when a
 *   block is at most one pixel wide, and it keeps every peak;
 * - exact statistics (min, max, sum, count and the time-weighted sum of the segments that start
 *   in the block) for the header's min / max / avg.
 *
 * Blocks are cached per points array. The cache relies on how LiveBuffer mutates arrays:
 * appends only change points at or after the previous last point's time, and trims only remove
 * points at the front (re-stamping the new first point). So on every call only the first block
 * (trimmed / re-stamped) and the blocks from the one holding the previous last point onwards
 * are recomputed; everything in between is reused. New arrays (reloads) start a new cache.
 */

interface Block {
  /** Aligned start (multiple of blockMs). */
  start: number;
  /** M4 samples of the block, time order. */
  pts: Point[];
  min: number;
  max: number;
  sum: number;
  count: number;
  /** Σ v·(t_next − t) over the non-null samples whose successor exists, and Σ (t_next − t). */
  wsum: number;
  w: number;
  /** Time of the sample after the block's last sample (NaN if there is none). */
  segEnd: number;
}

interface Cache {
  blockMs: number;
  /** Blocks before `openFrom` (none contains the first sample), ascending. */
  closed: Block[];
  /** Start of the block holding the last sample at the previous call. */
  openFrom: number;
}

const MAX_CACHES_PER_ARRAY = 4;
const caches = new WeakMap<Point[], Cache[]>();

/** First index with `points[i][0] >= t` (points ascending). */
export function lowerBound(points: readonly Point[], t: number): number {
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid][0] < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const isNum = (v: number | null): v is number => v !== null && Number.isFinite(v);

/** Blocks of `points[i0..i1)` (successors may lie beyond i1 and still count for segments). */
function computeBlocks(points: readonly Point[], i0: number, i1: number, blockMs: number): Block[] {
  const out: Block[] = [];
  const n = points.length;
  let i = i0;
  while (i < i1) {
    const start = Math.floor(points[i][0] / blockMs) * blockMs;
    const end = start + blockMs;
    let minI = -1;
    let maxI = -1;
    let nullI = -1;
    let min = Infinity;
    let max = -Infinity;
    let sum = 0;
    let count = 0;
    let wsum = 0;
    let w = 0;
    let j = i;
    for (; j < i1 && points[j][0] < end; j++) {
      const v = points[j][1];
      if (!isNum(v)) {
        if (nullI < 0) nullI = j;
        continue;
      }
      if (v < min) {
        min = v;
        minI = j;
      }
      if (v > max) {
        max = v;
        maxI = j;
      }
      sum += v;
      count++;
      if (j + 1 < n) {
        const dt = points[j + 1][0] - points[j][0];
        wsum += v * dt;
        w += dt;
      }
    }
    const idx = [i, j - 1, minI, maxI, nullI].filter((k) => k >= 0).sort((a, b) => a - b);
    const pts: Point[] = [];
    let prev = -1;
    for (const k of idx) {
      if (k !== prev) pts.push(points[k]);
      prev = k;
    }
    out.push({ start, pts, min, max, sum, count, wsum, w, segEnd: j < n ? points[j][0] : Number.NaN });
    i = j;
  }
  return out;
}

function cacheFor(points: Point[], blockMs: number): Cache | undefined {
  return caches.get(points)?.find((c) => c.blockMs === blockMs);
}

function storeCache(points: Point[], cache: Cache): void {
  const list = caches.get(points) ?? [];
  list.push(cache);
  if (list.length > MAX_CACHES_PER_ARRAY) list.shift();
  caches.set(points, list);
}

/** All blocks of `points` (ascending), using / updating the cache. */
function blocksOf(points: Point[], blockMs: number): Block[] {
  const n = points.length;
  if (n === 0) return [];
  const cache = cacheFor(points, blockMs);
  if (!cache || points[n - 1][0] < cache.openFrom) {
    const all = computeBlocks(points, 0, n, blockMs);
    if (cache) {
      cache.closed = all.slice(0, -1);
      cache.openFrom = all[all.length - 1].start;
    } else {
      storeCache(points, { blockMs, closed: all.slice(0, -1), openFrom: all[all.length - 1].start });
    }
    return all;
  }

  // Tail: everything from the previously open block on may have changed.
  const tail = computeBlocks(points, lowerBound(points, cache.openFrom), n, blockMs);
  for (let k = 0; k < tail.length - 1; k++) cache.closed.push(tail[k]);
  const open = tail[tail.length - 1];
  cache.openFrom = open.start;

  // Head: the first block may have lost samples / had its first sample re-stamped (trim).
  const firstBlock = Math.floor(points[0][0] / blockMs) * blockMs;
  let drop = 0;
  while (drop < cache.closed.length && cache.closed[drop].start <= firstBlock) drop++;
  if (drop) cache.closed.splice(0, drop);
  if (firstBlock >= cache.openFrom) return tail; // everything is in the open block
  const headEnd = cache.closed.length ? cache.closed[0].start : cache.openFrom;
  const head = computeBlocks(points, 0, lowerBound(points, headEnd), blockMs);
  const out = head.concat(cache.closed);
  out.push(open);
  return out;
}

/**
 * M4 reduction of `points` into blocks of `blockMs` (see the module comment); cached and
 * incrementally updated for arrays LiveBuffer extends. Returns a new array (points are the
 * original tuples) in time order.
 */
export function reducePoints(points: Point[], blockMs: number): Point[] {
  if (!(blockMs > 0) || points.length === 0) return points.slice();
  const out: Point[] = [];
  for (const b of blocksOf(points, blockMs)) for (const p of b.pts) out.push(p);
  return out;
}

/**
 * Like reducePoints, but with finer blocks of `detailMs` inside [from, to] (a zoomed-in view),
 * including one point beyond each edge so the line reaches the edges. Outside the range the
 * (cached) coarse blocks are used, so panning shows data right away.
 */
export function reducePointsDetail(points: Point[], blockMs: number, from: number, to: number, detailMs: number): Point[] {
  if (!(blockMs > 0) || !(detailMs > 0) || points.length === 0) return points.slice();
  const out: Point[] = [];
  const push = (p: Point): void => {
    if (!out.length || p[0] > out[out.length - 1][0]) out.push(p);
  };
  const blocks = blocksOf(points, blockMs);
  let k = 0;
  for (; k < blocks.length && blocks[k].start + blockMs <= from; k++) for (const p of blocks[k].pts) push(p);
  const i0 = Math.max(0, lowerBound(points, from) - 1);
  const i1 = Math.min(points.length, lowerBound(points, to) + 1);
  for (const b of computeBlocks(points, i0, i1, detailMs)) for (const p of b.pts) push(p);
  for (; k < blocks.length; k++) if (blocks[k].start >= to) for (const p of blocks[k].pts) push(p);
  return out;
}

export interface WindowExtrema {
  min: number;
  max: number;
  avg: number;
}

/**
 * Min / max / time-weighted average of the non-null values visible in [start, end]; each value
 * holds until the next point (sample-and-hold), the last one until `end`. Same result as a
 * full scan, but closed blocks inside the window come from the cache, so repeated calls on a
 * live series only scan its first and last block. `blockMs` 0 / invalid = plain scan.
 */
export function windowExtrema(points: Point[], start: number, end: number, blockMs: number): WindowExtrema | undefined {
  const n = points.length;
  if (n === 0) return undefined;
  const acc = { min: Infinity, max: -Infinity, sum: 0, count: 0, wsum: 0, w: 0 };
  const scan = (i0: number, i1: number): void => {
    for (let i = i0; i < i1; i++) {
      const [t, v] = points[i];
      if (t > end) break;
      const nextT = i + 1 < n ? Math.min(points[i + 1][0], end) : end;
      if (!isNum(v) || (t < start && nextT <= start)) continue;
      if (v < acc.min) acc.min = v;
      if (v > acc.max) acc.max = v;
      acc.sum += v;
      acc.count++;
      const span = nextT - Math.max(t, start);
      if (span > 0) {
        acc.wsum += v * span;
        acc.w += span;
      }
    }
  };

  const blocks = blockMs > 0 ? blocksOf(points, blockMs) : [];
  // Cached blocks usable as a whole: fully after `start`, closed, with segments ending by `end`.
  let a = 0;
  while (a < blocks.length && blocks[a].start < start) a++;
  let z = blocks.length - 2;
  while (z >= a && !(blocks[z].segEnd <= end)) z--;
  if (z < a) {
    scan(0, n);
  } else {
    scan(0, lowerBound(points, blocks[a].start));
    for (let k = a; k <= z; k++) {
      const b = blocks[k];
      if (b.min < acc.min) acc.min = b.min;
      if (b.max > acc.max) acc.max = b.max;
      acc.sum += b.sum;
      acc.count += b.count;
      acc.wsum += b.wsum;
      acc.w += b.w;
    }
    scan(lowerBound(points, blocks[z].start + blockMs), n);
  }
  if (acc.count === 0) return undefined;
  return { min: acc.min, max: acc.max, avg: acc.w > 0 ? acc.wsum / acc.w : acc.sum / acc.count };
}
