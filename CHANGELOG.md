# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/OWNER/echart-graph-card/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/OWNER/echart-graph-card/releases/tag/v0.1.0
