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
  `data_source: auto` switches to statistics above 72 h. When an entity has no statistics it
  falls back to history.
- Live updates straight from `hass.states`, without refetching. Redraws are throttled and pause
  while the tab is hidden. `update: <interval>` refetches on a fixed cadence and `update: none`
  loads once.
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
- Binary sensors are drawn as 0/1 step lines. `unavailable`/`unknown` states break the line.
  LTTB sampling kicks in for large series.
- Theme aware (HA light/dark, theme CSS variables). Times follow the HA profile's time zone
  (server or browser) and the locale's number and time formats.
- Sections-layout sizing (`getGridOptions`) and card-picker registration.
- Dev harness (`npm run dev`) with a mock `hass` and synthetic data. Example configs live in
  `examples/`. CI builds, a tag-driven release workflow and HACS validation are included.

[Unreleased]: https://github.com/OWNER/echart-graph-card/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/OWNER/echart-graph-card/releases/tag/v0.1.0
