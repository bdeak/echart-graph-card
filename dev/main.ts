/// <reference types="vite/client" />
/**
 * Dev harness entry, served by `npm run dev` (vite root = dev/).
 *
 * Renders one card per examples/*.yaml against a mock `hass` (./mock-hass.ts) with synthetic
 * data (./synth.ts), pushes live state changes every ~2 s, and toggles HA light/dark theme
 * variables on :root. Query parameters are listed in index.html (footer) and the README.
 */
import './ha-card';
import { CARD_NAME, CARD_VERSION } from '../src/const';
import type { CardConfig, HomeAssistant } from '../src/types';
import { applyHaTheme } from './ha-theme';
import { MockHassController } from './mock-hass';
import type { MockHass } from './mock-hass';
import { HOUR, MINUTE, TIME_ZONE, localHour } from './synth';
import { parseYaml } from './yaml';

interface LovelaceCard extends HTMLElement {
  hass?: HomeAssistant;
  setConfig(config: CardConfig): void;
  getCardSize?(): number | Promise<number>;
  updateComplete?: Promise<unknown>;
}

interface Example {
  name: string;
  file: string;
  source: string;
  config?: CardConfig;
  error?: string;
}

interface Harness {
  controller: MockHassController;
  cards: LovelaceCard[];
  examples: Example[];
  setDark(dark: boolean): void;
  setLive(live: boolean): void;
  reload(): void;
  disconnect(ms?: number): void;
}

declare global {
  interface Window {
    __harness?: Harness;
  }
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

const params = new URLSearchParams(location.search);
const flag = (name: string, fallback: boolean): boolean => {
  const v = params.get(name);
  if (v === null) return fallback;
  return v === '' || v === '1' || v === 'true' || v === 'yes' || v === 'on';
};
const numberParam = (name: string): number | undefined => {
  const v = params.get(name);
  const n = v === null || v.trim() === '' ? Number.NaN : Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/** `?at=14:30` -> shift so the synthetic data "now" looks like 14:30 in Europe/Berlin. */
function shiftFor(at: string | null): number {
  const m = at ? /^(\d{1,2})(?::(\d{2}))?$/.exec(at.trim()) : null;
  if (!m) return 0;
  const target = Number(m[1]) + Number(m[2] ?? 0) / 60;
  const current = localHour(Date.now());
  const diffH = (((target - current) % 24) + 24) % 24;
  return Math.round((diffH * HOUR) / MINUTE) * MINUTE;
}

let dark = flag('dark', false);
const stress = flag('stress', false);
const latency = numberParam('latency');
const timeParam = params.get('time');
const shiftMs = shiftFor(params.get('at'));
applyHaTheme(dark);

const controller = new MockHassController({
  dark,
  language: params.get('lang') ?? 'en',
  timeZone: params.get('tz') === 'local' ? 'local' : 'server',
  timeFormat: timeParam === '12' || timeParam === '24' || timeParam === 'language' || timeParam === 'system' ? timeParam : '24',
  seed: numberParam('seed') ?? 1,
  shiftMs,
  tickMs: Math.max(250, numberParam('tick') ?? 2000),
  latencyMs: latency === undefined ? undefined : [Math.max(0, latency / 3), Math.max(0, latency)],
  maxHistoryPoints: stress ? Number.POSITIVE_INFINITY : undefined,
  debug: flag('debug', false),
});

// ---------------------------------------------------------------------------
// Examples (the real examples/*.yaml files)
// ---------------------------------------------------------------------------

const ORDER = ['energy_flow', 'temperature', 'battery_soc', 'humidity', 'water_usage', 'multi_axis', 'minimal', 'door'];

const STRESS_YAML = `# Harness only (?stress=1): 7 days of raw 5 s history, ~120k points per series.
type: custom:echart-graph-card
title: Stress test (7 d raw history)
span: 7d
data_source: history
series:
  - sensor.grid_measured_total_power
  - sensor.growatt_min_3000_tl_x_growatt_pv_power_total
  - sensor.batteries_total_power
`;

function toExample(path: string, source: string): Example {
  const file = path.slice(path.lastIndexOf('/') + 1);
  const name = file.replace(/\.ya?ml$/, '');
  try {
    const parsed = parseYaml(source);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('the top level must be a mapping');
    return { name, file, source, config: parsed as CardConfig };
  } catch (e) {
    return { name, file, source, error: (e as Error).message };
  }
}

const sources = import.meta.glob<string>('../examples/*.yaml', { query: '?raw', import: 'default', eager: true });
const rank = (name: string): number => {
  const i = ORDER.indexOf(name);
  return i < 0 ? ORDER.length : i;
};
const only = params
  .get('only')
  ?.split(',')
  .map((s) => s.trim().replace(/\.ya?ml$/, ''))
  .filter(Boolean);

const examples: Example[] = Object.entries(sources)
  .map(([path, source]) => toExample(path, source))
  .sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
if (stress) examples.push(toExample('stress.yaml', STRESS_YAML));
const shown = only?.length ? examples.filter((e) => only.includes(e.name)) : examples;

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

const grid = document.getElementById('grid') as HTMLElement;
const status = document.getElementById('status') as HTMLElement;
const darkBtn = document.getElementById('toggle-dark') as HTMLButtonElement;
const liveBtn = document.getElementById('toggle-live') as HTMLButtonElement;
const reloadBtn = document.getElementById('reload') as HTMLButtonElement;
const reconnectBtn = document.getElementById('reconnect') as HTMLButtonElement;
(document.getElementById('version') as HTMLElement).textContent = `v${CARD_VERSION}`;

const cols = numberParam('cols');
const width = numberParam('width');
if (cols) grid.style.gridTemplateColumns = `repeat(${Math.round(cols)}, minmax(0, 1fr))`;
else if (width) grid.style.gridTemplateColumns = `repeat(auto-fill, ${Math.round(width)}px)`;

let cards: LovelaceCard[] = [];

function hrefWith(key: string, value: string | null): string {
  const p = new URLSearchParams(location.search);
  if (value === null) p.delete(key);
  else p.set(key, value);
  const q = p.toString();
  return q ? `?${q}` : location.pathname;
}

function errorCard(message: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'error-card';
  el.textContent = message;
  return el;
}

function renderCell(ex: Example, hass: MockHass): HTMLElement {
  const cell = document.createElement('section');
  cell.className = 'cell';
  cell.dataset.example = ex.name;

  const head = document.createElement('div');
  head.className = 'cell-head';
  const link = document.createElement('a');
  link.href = hrefWith('only', ex.name);
  link.textContent = ex.file;
  link.title = 'Show only this example';
  head.append(link);
  cell.append(head);

  if (ex.config) {
    const card = document.createElement(CARD_NAME) as unknown as LovelaceCard;
    try {
      card.setConfig(ex.config); // Lovelace order: setConfig, then hass, then attach
      card.hass = hass;
      cell.append(card);
      cards.push(card);
    } catch (e) {
      cell.append(errorCard((e as Error).message));
    }
  } else {
    cell.append(errorCard(`${ex.file}: ${ex.error ?? 'invalid YAML'}`));
  }

  const details = document.createElement('details');
  details.className = 'yaml';
  const summary = document.createElement('summary');
  summary.textContent = 'YAML';
  const pre = document.createElement('pre');
  pre.textContent = ex.source.trimEnd();
  details.append(summary, pre);
  cell.append(details);
  return cell;
}

function renderAll(): void {
  cards = [];
  grid.replaceChildren(...shown.map((ex) => renderCell(ex, controller.hass)));
  if (!shown.length) grid.append(errorCard(`No example matches ?only=${params.get('only') ?? ''}`));
  document.documentElement.dataset.ready = 'false';
  void Promise.all(cards.map((c) => c.updateComplete)).then(() =>
    setTimeout(() => {
      document.documentElement.dataset.ready = 'true';
    }, 1500),
  );
}

const fmtTime = new Intl.DateTimeFormat('en-GB', { timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });

function updateStatus(): void {
  const ws = Object.entries(controller.callCounts)
    .map(([type, n]) => `${type.split('/').pop() ?? type} ×${n}`)
    .join(', ');
  const last = controller.calls[controller.calls.length - 1];
  status.textContent = [
    `now ${fmtTime.format(Date.now())} ${TIME_ZONE}${shiftMs ? ` (data as of ${fmtTime.format(Date.now() + shiftMs).slice(0, 5)})` : ''}`,
    controller.hass.connected ? (controller.running ? `live, ${controller.ticks} ticks` : 'live paused') : 'DISCONNECTED',
    ws ? `WS: ${ws}${last ? ` (last ${last.ms} ms${last.ok ? '' : ', failed'})` : ''}` : 'WS: -',
  ].join(' · ');
}

function setDark(value: boolean): void {
  dark = value;
  applyHaTheme(dark); // CSS variables first, so the card reads the new theme on darkMode change
  controller.setDarkMode(dark);
  darkBtn.setAttribute('aria-pressed', String(dark));
  darkBtn.textContent = dark ? 'Dark theme' : 'Light theme';
  history.replaceState(null, '', hrefWith('dark', dark ? '1' : null));
}

function setLive(live: boolean): void {
  if (live) controller.start();
  else controller.stop();
  liveBtn.setAttribute('aria-pressed', String(live));
  liveBtn.textContent = live ? 'Live updates on' : 'Live updates paused';
  updateStatus();
}

controller.subscribe((hass) => {
  for (const card of cards) card.hass = hass;
  updateStatus();
});

darkBtn.addEventListener('click', () => setDark(!dark));
liveBtn.addEventListener('click', () => setLive(!controller.running));
reloadBtn.addEventListener('click', () => renderAll());
reconnectBtn.addEventListener('click', () => controller.simulateDisconnect(3000));
setInterval(updateStatus, 1000);

// ---------------------------------------------------------------------------
// Boot: load the card (source by default, the built bundle with ?bundle=1), then render.
// ---------------------------------------------------------------------------

async function loadCard(): Promise<string> {
  if (flag('bundle', false)) {
    // @ts-expect-error -- untyped build output; run `npm run build` first
    await import('../dist/echart-graph-card.js');
    return 'dist bundle';
  }
  await import('../src/index');
  return 'src';
}

loadCard()
  .then(async (from) => {
    await customElements.whenDefined(CARD_NAME);
    document.title = `${CARD_NAME} dev (${from})`;
    darkBtn.setAttribute('aria-pressed', String(dark));
    darkBtn.textContent = dark ? 'Dark theme' : 'Light theme';
    renderAll();
    setLive(flag('live', true));
  })
  .catch((e: unknown) => {
    grid.replaceChildren(errorCard(`Failed to load the card module: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`));
  });

window.__harness = {
  controller,
  get cards() {
    return cards;
  },
  examples,
  setDark,
  setLive,
  reload: renderAll,
  disconnect: (ms?: number) => controller.simulateDisconnect(ms),
};
