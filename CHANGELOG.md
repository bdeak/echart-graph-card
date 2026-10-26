# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.3.0] - 2026-10-26

### Added

- Value-only header chips: `show_in_chart: false` on a series shows the entity's current value
  in the header (in its config position, no dot, no show/hide toggle, never struck through) and
  nothing in the chart: it is not fetched or drawn and gets no axis, legend or tooltip entry.
  Typical use: a day's forecast total next to hourly bars. apexcharts-card's
  `show: { in_chart: false }` maps to it.
- `examples/solar_forecast.yaml` shows the forecast total for today as such a chip.

## [0.2.0] - 2026-10-15

### Added

- Bar series: `type: bar` (alias `column`). One bar per bucket (statistics row, `group_by`
  bucket or list item), centred on it, with a translucent fill, a 1 px border and rounded top
  corners. Zero values draw no bar; an auto axis with bars starts at 0. In cards with bars,
  bucketed lines are drawn at bucket centres, and the tooltip header shows the hovered bar's range.
- List attribute series: `attribute` + `value_key` (+ optional `time_key`) plot a list held in
  one attribute, e.g. Solcast's `detailedForecast` or an energy price list. Read from the current
  state (no history call) and re-read on every change of the entity.
- Day-aligned window: `span: { start: day, duration? }` shows the local day from midnight
  (23 h / 25 h on DST days) and may reach into the future; the card reloads when a new day begins.
- Example `examples/solar_forecast.yaml` (hourly PV energy with the Solcast P10 / P50 / P90
  forecast) and matching mock entities in the dev harness.

## [0.1.0] - unreleased

First version.

### Added

- `custom:echart-graph-card`: time-based line charts built on a tree-shaken Apache ECharts 6
  that ships inside the card, so it has no dependency on Home Assistant's internal chart elements.
- Minimal config (`type` + `series: [{ entity }]`) with good defaults: a 24 h window, a smooth
  line with gradient fill, live updates, and header chips with the current value that double as
  the legend.
- Data sources: recorder history (`history/history_during_period`) and long-term statistics
  (`recorder/statistics_during_period`, with `mean`/`min`/`max`/`state`/`sum`/`change`).
  `data_source: auto` switches to statistics above 72 h (or when `statistics_period` is set).
  When an entity has no statistics it falls back to history. External statistics and series
  with an explicit `statistic` always use statistics. Statistics kept in another unit than the
  entity's state are converted (or labelled with their own unit).
- Live updates straight from `hass.states`, without refetching history. Redraws are throttled
  and pause while the tab is hidden; gaps (hidden tab, view switch, reconnect) are backfilled
  with one history call for just the gap. Statistics series refresh after each compiled period.
  `update: <interval>` refetches on a fixed cadence and `update: none` loads once.
- Series options:
  - `name`, `color` (including `var(--x)`), `unit`, `attribute`
  - `line` (`width`, `smooth`, `step`, `style`), `fill` (`none`/`solid`/`gradient`), `fill_opacity`
  - `group_by` (`avg`/`min`/`max`/`first`/`last`/`sum`/`delta`/`median`)
  - `transform` (`multiply`/`offset`), `color_thresholds`, `statistic`, `precision`
  - `show_in_header`, `hidden`
- Multiple y-axes, auto-assigned by unit or configured with `y_axes`. Axes support hard
  `min`/`max`, `soft_min`/`soft_max`, `position` and `precision`.
- `thresholds`: horizontal reference lines (`value`) and bands (`from`/`to`) with labels.
- `show` toggles: `legend`, `tooltip`, `header_states`, `zoom`, `extrema`, `points`, `x_axis`,
  `y_axis`.
- Binary sensors (and covers, locks, people) are drawn as 0/1 step lines. `unavailable`/`unknown`
  states break the line; long unchanged periods are drawn flat instead of as ramps.
- Large series are reduced to first / min / max / last per pixel (cached, updated incrementally);
  the zoomed range is redrawn at full detail.
- Thresholds always stay visible (the auto axis includes them); band labels sit above the lines.
- Unknown options are reported inside the card, with hints for apexcharts-card and
  mini-graph-card keys.
- Theme aware (HA light/dark, theme CSS variables). Times follow the HA profile's time zone
  (server or browser) and the locale's number and time formats.
- Sections-layout sizing (`getGridOptions`: content height by default, fills the cell with
  `grid_options.rows`) and card-picker registration.
- Dev harness (`npm run dev`) with a mock `hass` and synthetic data. Example configs live in
  `examples/`. CI builds, a tag-driven release workflow and HACS validation are included.

[Unreleased]: https://github.com/bdeak/echart-graph-card/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/bdeak/echart-graph-card/releases/tag/v0.1.0
