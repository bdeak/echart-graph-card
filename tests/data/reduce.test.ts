import { describe, expect, it } from 'vitest';
import { lowerBound, reducePoints, reducePointsDetail, windowExtrema } from '../../src/data/reduce';
import { computeExtrema } from '../../src/header';
import type { Point } from '../../src/types';

const S = 1000;
const T0 = Date.parse('2026-09-26T00:00:00Z');

function rng(seed: number): () => number {
  let x = seed;
  return () => {
    x = (x * 1103515245 + 12345) % 2147483648;
    return x / 2147483648;
  };
}

/** 1 Hz noisy power-like series with a few gaps. */
function dense(n: number, seed = 1): Point[] {
  const rand = rng(seed);
  return Array.from({ length: n }, (_, i): Point => [T0 + i * S, rand() < 0.002 ? null : Math.round(1000 + 800 * Math.sin(i / 900) + 300 * rand())]);
}

describe('reducePoints (M4 per block)', () => {
  it('keeps first, last, min, max and the first gap of every block, in time order', () => {
    const pts: Point[] = [
      [0, 5],
      [1, 9],
      [2, null],
      [3, 1],
      [4, 4], // block [0, 10)
      [10, 7],
      [11, 7], // block [10, 20)
    ];
    expect(reducePoints(pts, 10)).toEqual([
      [0, 5],
      [1, 9],
      [2, null],
      [3, 1],
      [4, 4],
      [10, 7],
      [11, 7],
    ]);
    const many: Point[] = Array.from({ length: 100 }, (_, i): Point => [i, i === 40 ? 1000 : i === 60 ? -5 : i % 7]);
    const r = reducePoints(many, 100);
    expect(r).toEqual([
      [0, 0],
      [40, 1000],
      [60, -5],
      [99, 99 % 7],
    ]);
  });

  it('reduces a day of 1 Hz samples to a few points per block and preserves the extremes', () => {
    const pts = dense(86_400);
    const blockMs = Math.ceil((86_400 * S) / 400);
    const r = reducePoints(pts, blockMs);
    expect(r.length).toBeLessThanOrEqual(401 * 5);
    expect(r.length).toBeGreaterThan(400);
    const vals = (a: Point[]) => a.map((p) => p[1]).filter((v): v is number => v !== null);
    expect(Math.max(...vals(r))).toBe(Math.max(...vals(pts)));
    expect(Math.min(...vals(r))).toBe(Math.min(...vals(pts)));
    expect(r[0]).toBe(pts[0]);
    expect(r[r.length - 1]).toBe(pts[pts.length - 1]);
    for (let i = 1; i < r.length; i++) expect(r[i][0]).toBeGreaterThan(r[i - 1][0]);
  });

  it('stays identical to a fresh computation while the array is appended to and trimmed in place', () => {
    const rand = rng(3);
    const pts = dense(5000, 5);
    const blockMs = 37 * S;
    const extremaBlock = 101 * S;
    let t = pts[pts.length - 1][0];
    for (let step = 0; step < 400; step++) {
      const r = rand();
      if (r < 0.6) {
        t += Math.round(rand() * 3 * S) + 1;
        pts.push([t, rand() < 0.05 ? null : Math.round(rand() * 2000)]);
      } else if (r < 0.8) {
        pts[pts.length - 1] = [pts[pts.length - 1][0], Math.round(rand() * 2000)]; // same-time replace
      } else {
        // LiveBuffer.trim: drop the front, re-stamp the new first point to the window start.
        const windowStart = pts[0][0] + Math.round(rand() * 120 * S);
        let k = 0;
        while (k + 1 < pts.length && pts[k + 1][0] <= windowStart) k++;
        const first: Point = [windowStart, pts[k][1]];
        pts.splice(0, k);
        pts[0] = first;
      }
      expect(reducePoints(pts, blockMs)).toEqual(reducePoints(pts.slice(), blockMs));
      const start = pts[0][0] + Math.round(rand() * 60 * S);
      const end = t + Math.round(rand() * 30 * S);
      const cached = windowExtrema(pts, start, end, extremaBlock);
      const ref = computeExtrema(pts, start, end);
      if (!ref) expect(cached).toBeUndefined();
      else {
        expect(cached?.min).toBe(ref.min);
        expect(cached?.max).toBe(ref.max);
        expect(cached?.avg).toBeCloseTo(ref.avg, 6);
      }
    }
  });

  it('starts over for a new array (reload) and for arrays that shrank at the end', () => {
    const pts = dense(1000);
    const a = reducePoints(pts, 50 * S);
    pts.length = 500; // not something LiveBuffer does, but must not return stale blocks
    expect(reducePoints(pts, 50 * S)).toEqual(reducePoints(pts.slice(), 50 * S));
    expect(a.length).toBeGreaterThan(0);
  });
});

describe('reducePointsDetail (zoomed range)', () => {
  it('uses fine blocks inside the range (plus one point beyond each edge) and coarse ones outside', () => {
    const pts = dense(10_000);
    const coarse = 100 * S;
    const from = T0 + 4000 * S;
    const to = T0 + 4200 * S;
    const r = reducePointsDetail(pts, coarse, from, to, S);
    for (let i = 1; i < r.length; i++) expect(r[i][0]).toBeGreaterThan(r[i - 1][0]);
    const inside = r.filter((p) => p[0] >= from && p[0] < to);
    expect(inside).toHaveLength(200); // every sample of the zoomed range
    expect(r).toContain(pts[lowerBound(pts, from) - 1]);
    expect(r).toContain(pts[lowerBound(pts, to)]);
    expect(r.length).toBeLessThan(200 + 2 * (10_000 / 100) * 5);
  });
});

describe('windowExtrema', () => {
  it('matches the reference scan (time-weighted, window-bounded)', () => {
    const pts: Point[] = [
      [0, 100],
      [10, 0],
      [20, null],
      [30, 10],
    ];
    expect(windowExtrema(pts, 10, 40, 5)).toEqual(computeExtrema(pts, 10, 40));
    expect(windowExtrema(pts, 5, 40, 0)).toEqual(computeExtrema(pts, 5, 40));
    expect(windowExtrema([], 0, 10, 5)).toBeUndefined();
  });
});
