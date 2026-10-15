/**
 * Deterministic synthetic "home" for the dev harness.
 *
 * Every value is a pure function of time (plus a seed), so the history, statistics and live
 * states the mock serves always agree with each other. The model covers a small house in
 * Germany (Europe/Berlin): diurnal/seasonal temperatures, humidity, a ~2 kWp-in-September PV
 * system, two home batteries driven by a feed-forward controller targeting 40 W grid draw, a
 * water meter, a front door and a thermostat. It also has 'unavailable' / 'unknown' gaps
 * (radio dropouts, Modbus link loss).
 *
 * All public functions take *model* time in epoch ms. `buildEntities()` maps real time to
 * model time (the `?at=HH:MM` harness option shifts the model so screenshots always look like
 * a given time of day).
 */
import type { HassEntityAttributes } from '../src/types';

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
export const TIME_ZONE = 'Europe/Berlin';

/** Battery controller grid target (W) and system constants. */
const GRID_TARGET_W = 40;
const BATTERY_CAPACITY_WH = 10_240;
const BATTERY_MAX_W = 2_500;
const BATTERY_FLOOR_PCT = 11;
const WATER_METER_BASE_L = 482_310;
/** Lifetime PV energy at the model origin (kWh). */
const SOLAR_BASE_KWH = 9_412;
/** PV energy integration step. */
const SOLAR_STEP_MS = 5 * 60_000;
/** How far back the battery simulation / water meter integration starts. */
const MODEL_DAYS = 400;
const SOC_STEP_MS = 2 * MINUTE;

// ---------------------------------------------------------------------------
// Hashing and smooth noise
// ---------------------------------------------------------------------------

/** Integer hash -> [0, 1). Stable for any (seed, i), including very large i. */
export function hash01(seed: number, i: number): number {
  let h = Math.imul((seed | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(i | 0, 0xc2b2ae35) ^ Math.imul((i / 4294967296) | 0, 0x27d4eb2f);
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Smooth value noise in [-1, 1] with features of roughly `period` ms. */
function noise(t: number, period: number, seed: number): number {
  const x = t / period;
  const i = Math.floor(x);
  const f = x - i;
  const a = hash01(seed, i) * 2 - 1;
  const b = hash01(seed, i + 1) * 2 - 1;
  const u = f * f * (3 - 2 * f);
  return a + (b - a) * u;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

// ---------------------------------------------------------------------------
// Time zone helpers (Europe/Berlin, DST aware)
// ---------------------------------------------------------------------------

const tzFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});
const offsetCache = new Map<number, number>();

/** UTC offset of Europe/Berlin at `t` in ms (cached per hour; DST switches on full hours). */
export function tzOffsetMs(t: number): number {
  const key = Math.floor(t / HOUR);
  let o = offsetCache.get(key);
  if (o === undefined) {
    const p: Record<string, number> = {};
    for (const part of tzFormat.formatToParts(new Date(key * HOUR))) {
      if (part.type !== 'literal') p[part.type] = Number(part.value);
    }
    o = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - key * HOUR;
    offsetCache.set(key, o);
  }
  return o;
}

/** Local (Berlin) calendar day number: days since 1970-01-01 in local time. */
export function localDay(t: number): number {
  return Math.floor((t + tzOffsetMs(t)) / DAY);
}

/** Local hour of day as a fraction, 0 <= h < 24. */
export function localHour(t: number): number {
  const l = t + tzOffsetMs(t);
  return (((l % DAY) + DAY) % DAY) / HOUR;
}

/** UTC epoch ms of local midnight starting local day `day`. */
export function localMidnight(day: number): number {
  const guess = day * DAY - tzOffsetMs(day * DAY);
  return day * DAY - tzOffsetMs(guess);
}

/** 0 = Sunday ... 6 = Saturday for a local day number (1970-01-01 was a Thursday). */
export function dayOfWeek(day: number): number {
  return (((day + 4) % 7) + 7) % 7;
}

/** First local day of the month containing `day`, and of the following month. */
export function monthBounds(day: number): [number, number] {
  const d = new Date(day * DAY);
  const first = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / DAY;
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / DAY;
  return [first, next];
}

// ---------------------------------------------------------------------------
// Day plans (appliance, water and door events)
// ---------------------------------------------------------------------------

interface Span {
  start: number;
  end: number;
  /** Watts for load events, liters for water events. */
  v: number;
}

interface DayPlan {
  day: number;
  midnight: number;
  /** 0 (winter solstice) .. 1 (summer solstice). */
  season: number;
  /** Day of year 0..365. */
  doy: number;
  /** 0 clear .. ~0.95 overcast. */
  cloud: number;
  load: Span[];
  water: Span[];
  showers: Span[];
  door: Array<[number, number]>;
  /** Cheap-tariff (Tibber) night charging window, if planned. */
  cheap: Span | null;
  waterTotal: number;
}

export interface SolarForecastItem {
  period_start: string;
  pv_estimate: number;
  pv_estimate10: number;
  pv_estimate90: number;
}

/** Attributes of a Solcast "forecast today" sensor (kWh totals, kW per half hour). */
export interface SolarForecast {
  estimate: number;
  estimate10: number;
  estimate90: number;
  detailedForecast: SolarForecastItem[];
}

export interface HomeModelOptions {
  seed?: number;
  /** Model "now"; anchors the simulation start and the guaranteed demo gaps. */
  now?: number;
}

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

export class HomeModel {
  readonly seed: number;
  readonly originDay: number;
  readonly origin: number;
  /** Rounded-to-the-hour construction time; guaranteed demo gaps are placed relative to it. */
  private readonly anchor: number;
  private readonly plans = new Map<number, DayPlan>();
  private waterCum = new Float64Array(1);
  private waterCumLen = 1;
  private soc = new Float32Array(0);
  private socLen = 0;
  /** Per local day: PV energy (kWh) from midnight to each SOLAR_STEP_MS step. */
  private readonly solarSteps = new Map<number, Float64Array>();
  /** solarDayStart[k] = lifetime PV energy at the start of day originDay + k. */
  private solarDayStart = new Float64Array([SOLAR_BASE_KWH]);
  private readonly forecasts = new Map<number, SolarForecast>();
  private readonly fridgePhase: number;

  constructor(opts: HomeModelOptions = {}) {
    this.seed = opts.seed ?? 1;
    const now = opts.now ?? Date.now();
    this.originDay = localDay(now) - MODEL_DAYS;
    this.origin = localMidnight(this.originDay);
    this.anchor = Math.floor(now / HOUR) * HOUR;
    this.fridgePhase = hash01(this.seed, 7) * 52;
  }

  // ---- plans -------------------------------------------------------------

  plan(day: number): DayPlan {
    let p = this.plans.get(day);
    if (!p) {
      p = this.makePlan(day);
      this.plans.set(day, p);
    }
    return p;
  }

  private makePlan(day: number): DayPlan {
    const midnight = localMidnight(day);
    let n = 0;
    const r = (): number => hash01(this.seed * 1_000_003 + day, n++);
    const at = (h: number): number => midnight + h * HOUR;
    const d = new Date(day * DAY);
    const doy = (day * DAY - Date.UTC(d.getUTCFullYear(), 0, 1)) / DAY;
    const season = 0.5 * (1 + Math.cos((2 * Math.PI * (doy - 172)) / 365.25));
    const dow = dayOfWeek(day);
    const weekend = dow === 0 || dow === 6;
    const cloud = Math.pow(r(), 1.4) * 0.95;

    const load: Span[] = [];
    const water: Span[] = [];
    const showers: Span[] = [];
    const add = (list: Span[], startH: number, durMin: number, v: number): Span => {
      const s = { start: at(startH), end: at(startH) + durMin * MINUTE, v };
      list.push(s);
      return s;
    };

    // Morning routine.
    const wake = weekend ? 7.4 + r() * 1.4 : 6.1 + r() * 0.5;
    add(load, wake + 0.1, 3 + r() * 1.5, 2000); // kettle
    add(load, wake + 0.15, 25, 250 + r() * 200); // coffee machine, lights, radio
    if (r() < 0.5) add(load, wake + 0.35, 3, 850); // toaster
    showers.push(add(water, wake + 0.05, 7 + r() * 4, 45 + r() * 25));
    if (r() < 0.6) showers.push(add(water, wake + 0.45 + r() * 0.3, 6 + r() * 3, 35 + r() * 20));

    // Toilet flushes and kitchen tap throughout the day.
    const flushes = 7 + Math.floor(r() * 5);
    for (let i = 0; i < flushes; i++) add(water, wake + r() * (22.8 - wake), 1, 6 + r() * 2);
    for (let i = 0; i < 12; i++) add(water, wake + r() * (22.5 - wake), 0.5 + r(), 0.8 + r() * 2.5);

    // Lunch (weekends mostly), random kettle runs.
    if (weekend || r() < 0.3) add(load, 11.8 + r() * 0.5, 35 + r() * 20, 1100 + r() * 400);
    const kettles = 1 + Math.floor(r() * 3);
    for (let i = 0; i < kettles; i++) add(load, 9 + r() * 12, 3, 2000);

    // Washing machine: heating phase, motor phase, water fills.
    if (r() < (weekend ? 0.6 : 0.3)) {
      const s = 9.5 + r() * 2;
      add(load, s, 18, 2050);
      add(load, s + 0.3, 65, 250);
      for (let k = 0; k < 5; k++) add(water, s + k * 0.25, 2, 9 + r() * 3);
    }

    // Dinner.
    const dinner = 17.8 + r() * 1.2;
    add(load, dinner, 30 + r() * 25, 1400 + r() * 500);
    add(water, dinner + 0.6, 2, 3 + r() * 3);

    // Dishwasher: two heating phases plus three fills.
    if (r() < 0.75) {
      const s = 20.2 + r() * 0.8;
      add(load, s, 110, 60);
      add(load, s + 0.05, 20, 2000);
      add(load, s + 0.9, 15, 1900);
      for (let k = 0; k < 3; k++) add(water, s + k * 0.5, 1.5, 3.5);
    }

    // TV / evening lights, evening shower, summer garden watering.
    add(load, 19.3 + r() * 0.5, 180 + r() * 40, 110 + r() * 60);
    if (r() < 0.35) showers.push(add(water, 21 + r() * 1.2, 6 + r() * 3, 35 + r() * 20));
    if (season > 0.55 && cloud < 0.5 && r() < 0.7) add(water, 19.5 + r() * 0.5, 25, 110 + r() * 40);

    // Front door openings (non-overlapping, at least 30 s apart).
    const openings: Array<[number, number]> = [];
    const count = 5 + Math.floor(r() * 6);
    for (let i = 0; i < count; i++) {
      const start = at(wake + 0.5 + r() * (22.4 - wake - 0.5));
      openings.push([start, start + (10 + r() * 150) * SECOND]);
    }
    if (r() < 0.3) {
      const start = at(10 + r() * 8);
      openings.push([start, start + (8 + r() * 7) * MINUTE]);
    }
    openings.sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < openings.length; i++) {
      const prevEnd = openings[i - 1][1];
      if (openings[i][0] < prevEnd + 30 * SECOND) {
        const dur = openings[i][1] - openings[i][0];
        openings[i][0] = prevEnd + 30 * SECOND;
        openings[i][1] = openings[i][0] + dur;
      }
    }

    // Some nights the controller charges from the grid during the cheapest Tibber hours.
    const cheap = r() < 0.3 ? { start: at(2 + r()), end: at(4.5), v: -2200 } : null;

    return {
      day,
      midnight,
      season,
      doy,
      cloud,
      load,
      water,
      showers,
      door: openings,
      cheap,
      waterTotal: water.reduce((s, e) => s + e.v, 0),
    };
  }

  // ---- gaps --------------------------------------------------------------

  /** At most one gap of [minMs, maxMs) per block, with probability `prob`. */
  private gap(t: number, blockMs: number, prob: number, minMs: number, maxMs: number, seed: number): boolean {
    const k = Math.floor(t / blockMs);
    const h = hash01(this.seed * 31 + seed, k);
    if (h >= prob) return false;
    const start = k * blockMs + (h / prob) * (blockMs - maxMs);
    const dur = minMs + hash01(this.seed * 31 + seed + 1, k) * (maxMs - minMs);
    return t >= start && t < start + dur;
  }

  /** A gap placed relative to the construction time so every default window shows one. */
  private demoGap(t: number, agoMs: number, durMs: number): boolean {
    const start = this.anchor - agoMs;
    return t >= start && t < start + durMs;
  }

  /** Battery Modbus bridge (EW11A) link loss: SoC and battery power go 'unavailable'. */
  modbusDown(t: number): boolean {
    return this.gap(t, 12 * HOUR, 0.4, 3 * MINUTE, 9 * MINUTE, 61) || this.demoGap(t, 55 * MINUTE, 4 * MINUTE);
  }

  /** Outdoor sensor radio dropout. */
  outdoorDown(t: number): boolean {
    return this.gap(t, 6 * HOUR, 0.3, 12 * MINUTE, 40 * MINUTE, 62) || this.demoGap(t, 5 * HOUR, 35 * MINUTE);
  }

  /** Humidity sensor reporting 'unknown'. */
  humidityUnknown(t: number): boolean {
    return this.gap(t, 8 * HOUR, 0.18, 5 * MINUTE, 15 * MINUTE, 63) || this.demoGap(t, 9 * HOUR, 20 * MINUTE);
  }

  // ---- energy ------------------------------------------------------------

  /** House consumption in W. */
  loadW(t: number): number {
    const p = this.plan(localDay(t));
    let w = 165 + 35 * noise(t, 30 * MINUTE, this.seed + 11) + 12 * noise(t, 9 * SECOND, this.seed + 12);
    if ((t / MINUTE + this.fridgePhase) % 52 < 17) w += 85 + 4 * noise(t, 40 * SECOND, this.seed + 13);
    for (const e of p.load) if (t >= e.start && t < e.end) w += e.v;
    return Math.max(40, w);
  }

  /** Clear-sky PV output in W (before clouds), 0 at night. */
  private solarClearW(t: number): number {
    const p = this.plan(localDay(t));
    const h = localHour(t);
    const daylight = 8.2 + 8.3 * p.season;
    const noon = 12.2 + tzOffsetMs(t) / HOUR - 1;
    const x = (h - (noon - daylight / 2)) / daylight;
    if (x <= 0 || x >= 1) return 0;
    return Math.pow(Math.sin(Math.PI * x), 1.35) * (1250 + 1650 * p.season);
  }

  /** PV output in W (Growatt MIC 3000 TL-X, clipped at 3000 W). */
  solarW(t: number): number {
    const clear = this.solarClearW(t);
    if (clear === 0) return 0;
    const p = this.plan(localDay(t));
    const passing = 0.5 + 0.5 * noise(t, 11 * MINUTE, this.seed + 21);
    const factor = 1 - p.cloud * (0.35 + 0.6 * passing) + 0.04 * noise(t, 70 * SECOND, this.seed + 22);
    const w = Math.round(clear * clamp(factor, 0.06, 1.05));
    return w < 15 ? 0 : Math.min(3000, w);
  }

  /** Controller decision (W, positive = discharge) for a given SoC. */
  private batteryDecision(t: number, soc: number, lagMs: number): number {
    const p = this.plan(localDay(t));
    if (p.cheap && t >= p.cheap.start && t < p.cheap.end && soc < 72) return p.cheap.v;
    let d = this.loadW(t - lagMs) - this.solarW(t - lagMs) - GRID_TARGET_W;
    if (Math.abs(d) < 25) d = 0;
    d = clamp(d, -BATTERY_MAX_W, BATTERY_MAX_W);
    if (d > 0 && soc <= BATTERY_FLOOR_PCT) return 0;
    if (d < 0 && soc >= 99.8) return 0;
    return d;
  }

  private ensureSoc(t: number): void {
    const need = Math.ceil((t - this.origin) / SOC_STEP_MS) + 2;
    if (need <= this.socLen) return;
    const target = need + Math.round(DAY / SOC_STEP_MS);
    if (target > this.soc.length) {
      const next = new Float32Array(Math.max(target, this.soc.length * 2));
      next.set(this.soc.subarray(0, this.socLen));
      this.soc = next;
    }
    let soc = this.socLen > 0 ? this.soc[this.socLen - 1] : 50;
    for (let i = this.socLen; i < target; i++) {
      if (i > 0) {
        const tt = this.origin + (i - 1) * SOC_STEP_MS;
        const bat = this.batteryDecision(tt, soc, 0);
        const wh = (bat > 0 ? bat / 0.95 : bat * 0.94) * (SOC_STEP_MS / HOUR);
        soc = clamp(soc - (wh / BATTERY_CAPACITY_WH) * 100, 0, 100);
      }
      this.soc[i] = soc;
    }
    this.socLen = target;
  }

  /** Combined battery state of charge in % (continuous). */
  socPct(t: number): number {
    if (t <= this.origin) return 50;
    this.ensureSoc(t);
    const x = (t - this.origin) / SOC_STEP_MS;
    const i = Math.floor(x);
    const f = x - i;
    return this.soc[i] + (this.soc[i + 1] - this.soc[i]) * f;
  }

  /** Per-battery SoC (integer %, like the Marstek Modbus register). */
  batterySocPct(t: number, which: 1 | 2): number {
    const base = this.socPct(t);
    const off = which === 1 ? 0.9 + 1.1 * noise(t, 5 * HOUR, this.seed + 31) : -1.6 + 1.1 * noise(t, 5 * HOUR, this.seed + 32);
    return clamp(Math.round(base + off), 0, 100);
  }

  /** Battery power in W: positive = discharge, negative = charge. The controller lags ~4 s. */
  batteryW(t: number): number {
    const b = this.batteryDecision(t, this.socPct(t), 4 * SECOND);
    return b === 0 ? 0 : Math.round(b + 6 * noise(t, 7 * SECOND, this.seed + 33));
  }

  /** Grid power in W: positive = import, negative = export. Hovers around the 40 W target. */
  gridW(t: number): number {
    const v = this.loadW(t) - this.solarW(t) - this.batteryW(t) + 10 * noise(t, 5 * SECOND, this.seed + 34);
    return Math.round(v) || 0;
  }

  // ---- climate -----------------------------------------------------------

  outdoorC(t: number): number {
    const p = this.plan(localDay(t));
    const h = localHour(t);
    const mean = 9.3 - 9.6 * Math.cos((2 * Math.PI * (p.doy - 20)) / 365.25);
    const amp = (3.2 + 2.8 * p.season) * (1 - 0.55 * p.cloud);
    return (
      mean +
      amp * Math.cos((2 * Math.PI * (h - 15)) / 24) +
      2.2 * noise(t, 9 * HOUR, this.seed + 41) +
      0.25 * noise(t, 25 * MINUTE, this.seed + 42) +
      0.05 * noise(t, 3 * MINUTE, this.seed + 43)
    );
  }

  /** Thermostat setpoint: 21.5 °C from 06:00 to 22:30, 19 °C at night. */
  setpointC(t: number): number {
    const h = localHour(t);
    return h >= 6 && h < 22.5 ? 21.5 : 19;
  }

  indoorC(t: number): number {
    const h = localHour(t);
    const night = 19.4;
    const dayT = 21.3;
    const wake = 6;
    const sleep = 22.5;
    let temp: number;
    if (h >= wake && h < sleep) {
      const coolest = night + (dayT - night) * Math.exp(-(wake + 24 - sleep) / 2.6);
      temp = dayT - (dayT - coolest) * Math.exp(-(h - wake) / 0.7);
    } else {
      const since = h >= sleep ? h - sleep : h + 24 - sleep;
      temp = night + (dayT - night) * Math.exp(-since / 2.6);
    }
    temp += (0.9 * this.solarW(t - 40 * MINUTE)) / 2500;
    return temp + 0.25 * noise(t, 2 * HOUR, this.seed + 44) + 0.04 * noise(t, 4 * MINUTE, this.seed + 45);
  }

  humidityPct(t: number): number {
    const p = this.plan(localDay(t));
    let v = 53 - 1.8 * (this.indoorC(t) - 21) + 4.5 * noise(t, 5 * HOUR, this.seed + 51) + 0.4 * noise(t, 12 * MINUTE, this.seed + 52);
    for (const s of p.showers) {
      if (t > s.start && t < s.end + 3 * HOUR) {
        const x = (t - s.end) / (35 * MINUTE);
        v += t < s.end ? 7 * ((t - s.start) / (s.end - s.start)) : 7 * Math.exp(-x * x);
      }
    }
    return clamp(v, 25, 90);
  }

  // ---- solar energy / forecast ------------------------------------------

  private solarStepsOf(day: number): Float64Array {
    let a = this.solarSteps.get(day);
    if (!a) {
      const m = localMidnight(day);
      const n = Math.round((localMidnight(day + 1) - m) / SOLAR_STEP_MS);
      a = new Float64Array(n + 1);
      let prev = this.solarW(m);
      for (let k = 0; k < n; k++) {
        const next = this.solarW(m + (k + 1) * SOLAR_STEP_MS);
        a[k + 1] = a[k] + ((prev + next) / 2) * (SOLAR_STEP_MS / HOUR) / 1000;
        prev = next;
      }
      this.solarSteps.set(day, a);
    }
    return a;
  }

  /** PV energy since local midnight (kWh), exact to the integration step. */
  solarTodayKWh(t: number): number {
    const day = localDay(t);
    const a = this.solarStepsOf(day);
    const x = (t - localMidnight(day)) / SOLAR_STEP_MS;
    const k = Math.max(0, Math.min(a.length - 2, Math.floor(x)));
    return a[k] + (a[k + 1] - a[k]) * Math.min(1, Math.max(0, x - k));
  }

  /**
   * Lifetime PV energy (kWh) as the long-term statistics of a daily counter would sum it up:
   * completed days plus today in 0.1 kWh steps (the inverter's resolution).
   */
  solarTotalKWh(t: number): number {
    if (t <= this.origin) return SOLAR_BASE_KWH;
    const k = localDay(t) - this.originDay;
    if (this.solarDayStart.length <= k) {
      const next = new Float64Array(k + 1);
      next.set(this.solarDayStart);
      for (let i = this.solarDayStart.length; i <= k; i++) {
        const prev = this.solarStepsOf(this.originDay + i - 1);
        next[i] = next[i - 1] + Math.floor(prev[prev.length - 1] * 10) / 10;
      }
      this.solarDayStart = next;
    }
    return this.solarDayStart[k] + Math.floor(this.solarTodayKWh(t) * 10) / 10;
  }

  /**
   * Solcast-like forecast of local day `day`: 48 half hours of average kW (P10 / P50 / P90).
   * The P50 misses the actual production by a per-day error of -10..+15 %. `shiftMs` is
   * subtracted from the period starts (model -> real time). Cached: the same object per day.
   */
  solarForecast(day: number, shiftMs = 0): SolarForecast {
    const key = day * 1e9 + shiftMs;
    let f = this.forecasts.get(key);
    if (!f) {
      const p = this.plan(day);
      const bias = 0.9 + 0.25 * hash01(this.seed * 7 + day, 99);
      const m = localMidnight(day);
      const n = Math.round((localMidnight(day + 1) - m) / (30 * MINUTE));
      const items: SolarForecastItem[] = [];
      let e = 0;
      let e10 = 0;
      let e90 = 0;
      const r4 = (v: number): number => Math.round(v * 10_000) / 10_000;
      for (let i = 0; i < n; i++) {
        const t0 = m + i * 30 * MINUTE;
        let clear = 0;
        for (let k = 0; k < 6; k++) clear += this.solarClearW(t0 + (k + 0.5) * 5 * MINUTE) / 6;
        const p50 = Math.min(3000, clear * (1 - 0.65 * p.cloud) * bias) / 1000;
        const p10 = p50 * (0.55 + 0.25 * (1 - p.cloud));
        const p90 = Math.min(3, Math.max(p50, Math.min((clear * 1.05) / 1000, p50 * (1.25 + 0.35 * p.cloud))));
        items.push({ period_start: new Date(t0 - shiftMs).toISOString(), pv_estimate: r4(p50), pv_estimate10: r4(p10), pv_estimate90: r4(p90) });
        e += p50 / 2;
        e10 += p10 / 2;
        e90 += p90 / 2;
      }
      f = { estimate: r4(e), estimate10: r4(e10), estimate90: r4(e90), detailedForecast: items };
      this.forecasts.set(key, f);
    }
    return f;
  }

  // ---- water / door ------------------------------------------------------

  /** Water meter reading in liters (continuous, monotonic). */
  waterL(t: number): number {
    if (t <= this.origin) return WATER_METER_BASE_L;
    const day = localDay(t);
    const k = day - this.originDay;
    while (this.waterCumLen <= k) {
      if (this.waterCumLen >= this.waterCum.length) {
        const next = new Float64Array(this.waterCum.length * 2 + 64);
        next.set(this.waterCum.subarray(0, this.waterCumLen));
        this.waterCum = next;
      }
      const i = this.waterCumLen;
      this.waterCum[i] = this.waterCum[i - 1] + this.plan(this.originDay + i - 1).waterTotal;
      this.waterCumLen++;
    }
    let used = this.waterCum[k];
    for (const e of this.plan(day).water) {
      if (t >= e.end) used += e.v;
      else if (t > e.start) used += (e.v * (t - e.start)) / (e.end - e.start);
    }
    return WATER_METER_BASE_L + used;
  }

  doorOpen(t: number): boolean {
    return this.plan(localDay(t)).door.some(([a, b]) => t >= a && t < b);
  }

  /** Exact open/close instants in [start, end). */
  doorTransitions(start: number, end: number): number[] {
    const out: number[] = [];
    for (let d = localDay(start); d <= localDay(end); d++) {
      for (const [a, b] of this.plan(d).door) {
        if (a >= start && a < end) out.push(a);
        if (b >= start && b < end) out.push(b);
      }
    }
    return out.sort((x, y) => x - y);
  }
}

// ---------------------------------------------------------------------------
// Entity catalog
// ---------------------------------------------------------------------------

export interface EntityDef {
  entity_id: string;
  /** Static attributes (friendly_name, unit, classes). */
  attributes: HassEntityAttributes;
  /** State string at real time `t`. */
  state(t: number): string;
  /** Attributes that change over time (climate). */
  dynamicAttributes?(t: number): Record<string, unknown>;
  /** Numeric value for long-term statistics; null while unavailable. */
  value?(t: number): number | null;
  /** Native reporting cadence used when synthesizing history (ms). */
  sampleMs: number;
  /** Exact state change instants in [start, end) for event-driven entities (real time). */
  transitions?(start: number, end: number): number[];
  /** Long-term statistics kind; undefined = entity has no statistics (like HA). */
  statistics?: 'measurement' | 'total_increasing';
  /** Entity registry display_precision. */
  displayPrecision?: number;
}

const num = (v: number, decimals: number): string => {
  const s = v.toFixed(decimals);
  return /^-0(\.0+)?$/.test(s) ? s.slice(1) : s;
};

const parse = (s: string): number | null => {
  const n = Number(s);
  return s.trim() !== '' && Number.isFinite(n) ? n : null;
};

/** Build the mock entity catalog. `shiftMs` maps real time to model time (model = real + shift). */
export function buildEntities(model: HomeModel, shiftMs = 0): EntityDef[] {
  const m = (t: number): number => t + shiftMs;
  const numeric = (def: Omit<EntityDef, 'value'>): EntityDef => ({ ...def, value: (t) => parse(def.state(t)) });

  return [
    numeric({
      entity_id: 'sensor.living_room_temperature',
      attributes: {
        friendly_name: 'Living room temperature',
        unit_of_measurement: '°C',
        device_class: 'temperature',
        state_class: 'measurement',
      },
      state: (t) => num(model.indoorC(m(t)), 1),
      sampleMs: MINUTE,
      statistics: 'measurement',
      displayPrecision: 1,
    }),
    numeric({
      entity_id: 'sensor.outdoor_temperature',
      attributes: {
        friendly_name: 'Outdoor temperature',
        unit_of_measurement: '°C',
        device_class: 'temperature',
        state_class: 'measurement',
      },
      state: (t) => (model.outdoorDown(m(t)) ? 'unavailable' : num(model.outdoorC(m(t)), 1)),
      sampleMs: MINUTE,
      statistics: 'measurement',
      displayPrecision: 1,
    }),
    numeric({
      entity_id: 'sensor.living_room_humidity',
      attributes: {
        friendly_name: 'Living room humidity',
        unit_of_measurement: '%',
        device_class: 'humidity',
        state_class: 'measurement',
      },
      state: (t) => (model.humidityUnknown(m(t)) ? 'unknown' : num(model.humidityPct(m(t)), 1)),
      sampleMs: MINUTE,
      statistics: 'measurement',
      displayPrecision: 0,
    }),
    numeric({
      entity_id: 'sensor.marstek_venus_modbus_battery_soc',
      attributes: {
        friendly_name: 'Marstek Venus battery SoC',
        unit_of_measurement: '%',
        device_class: 'battery',
        state_class: 'measurement',
      },
      state: (t) => (model.modbusDown(m(t)) ? 'unavailable' : String(model.batterySocPct(m(t), 1))),
      sampleMs: MINUTE,
      statistics: 'measurement',
      displayPrecision: 0,
    }),
    numeric({
      entity_id: 'sensor.marstek_venus_modbus_device_2_battery_soc',
      attributes: {
        friendly_name: 'Marstek Venus 2 battery SoC',
        unit_of_measurement: '%',
        device_class: 'battery',
        state_class: 'measurement',
      },
      state: (t) => (model.modbusDown(m(t)) ? 'unavailable' : String(model.batterySocPct(m(t), 2))),
      sampleMs: MINUTE,
      statistics: 'measurement',
      displayPrecision: 0,
    }),
    numeric({
      entity_id: 'sensor.grid_measured_total_power',
      attributes: {
        friendly_name: 'Grid measured total power',
        unit_of_measurement: 'W',
        device_class: 'power',
        state_class: 'measurement',
      },
      state: (t) => String(model.gridW(m(t))),
      sampleMs: 5 * SECOND,
      statistics: 'measurement',
      displayPrecision: 0,
    }),
    numeric({
      entity_id: 'sensor.growatt_min_3000_tl_x_growatt_pv_power_total',
      attributes: {
        friendly_name: 'Growatt PV power total',
        unit_of_measurement: 'W',
        device_class: 'power',
        state_class: 'measurement',
      },
      state: (t) => String(model.solarW(m(t))),
      sampleMs: 5 * SECOND,
      statistics: 'measurement',
      displayPrecision: 0,
    }),
    numeric({
      entity_id: 'sensor.batteries_total_power',
      attributes: {
        friendly_name: 'Batteries total power',
        unit_of_measurement: 'W',
        device_class: 'power',
        state_class: 'measurement',
      },
      state: (t) => (model.modbusDown(m(t)) ? 'unavailable' : String(model.batteryW(m(t)))),
      sampleMs: 5 * SECOND,
      statistics: 'measurement',
      displayPrecision: 0,
    }),
    {
      entity_id: 'sensor.water_meter_total',
      attributes: {
        friendly_name: 'Water meter',
        unit_of_measurement: 'L',
        device_class: 'water',
        state_class: 'total_increasing',
        icon: 'mdi:water',
      },
      state: (t) => String(Math.floor(model.waterL(m(t)))),
      value: (t) => model.waterL(m(t)),
      sampleMs: 10 * SECOND,
      statistics: 'total_increasing',
      displayPrecision: 0,
    },
    {
      entity_id: 'sensor.growatt_min_3000_tl_x_growatt_today_s_power_generation',
      attributes: {
        friendly_name: "Growatt today's power generation",
        unit_of_measurement: 'kWh',
        device_class: 'energy',
        state_class: 'total_increasing',
      },
      state: (t) => num(Math.floor(model.solarTodayKWh(m(t)) * 10) / 10, 1),
      value: (t) => model.solarTotalKWh(m(t)),
      sampleMs: MINUTE,
      statistics: 'total_increasing',
      displayPrecision: 1,
    },
    {
      entity_id: 'sensor.solcast_pv_forecast_forecast_today',
      attributes: { friendly_name: 'Solcast forecast today', unit_of_measurement: 'kWh', device_class: 'energy' },
      state: (t) => num(model.solarForecast(localDay(m(t)), shiftMs).estimate, 4),
      dynamicAttributes: (t) => ({ ...model.solarForecast(localDay(m(t)), shiftMs) }),
      sampleMs: 30 * MINUTE,
    },
    {
      entity_id: 'binary_sensor.front_door',
      attributes: { friendly_name: 'Front door', device_class: 'door' },
      state: (t) => (model.doorOpen(m(t)) ? 'on' : 'off'),
      sampleMs: MINUTE,
      transitions: (start, end) => model.doorTransitions(m(start), m(end)).map((x) => x - shiftMs),
    },
    {
      entity_id: 'climate.living_room',
      attributes: {
        friendly_name: 'Living room thermostat',
        hvac_modes: ['off', 'heat', 'auto'],
        min_temp: 7,
        max_temp: 30,
        target_temp_step: 0.5,
        supported_features: 385,
      },
      state: () => 'heat',
      dynamicAttributes: (t) => {
        const current = Math.round(model.indoorC(m(t)) * 10) / 10;
        const target = model.setpointC(m(t));
        return { current_temperature: current, temperature: target, hvac_action: current < target - 0.15 ? 'heating' : 'idle' };
      },
      sampleMs: MINUTE,
    },
  ];
}
