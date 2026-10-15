# ECharts Graph Card

Fast, clean time-series line and bar charts for Home Assistant dashboards. It suits temperature,
humidity, battery charge, power and energy, water, forecasts, and anything else that changes over
time.

`custom:echart-graph-card` is built on [Apache ECharts](https://echarts.apache.org/) and aims at
three things:

- A two-line config already looks good.
- A 24 h history of a 5-second power sensor stays smooth.
- Every option can be written in plain YAML.

```yaml
type: custom:echart-graph-card
series:
  - entity: sensor.living_room_temperature
```

[![HACS Custom](https://img.shields.io/badge/HACS-Custom-41BDF5.svg)](https://hacs.xyz/docs/faq/custom_repositories/)

## Features

- **Good defaults.** You get a smooth line, a gradient fill for one or two series, and
  locale-aware axes. The header shows the current value of each series, and those chips double as
  the legend.
- **Fast.**
  - All entities load in a single batched WebSocket call.
  - Live values are appended from state changes without refetching, and redraws are throttled.
  - Large series are reduced to their first / min / max / last value per pixel before drawing, so
    every peak survives and a redraw costs the same for a day of 1-second data as for a few
    hundred points. Zooming in re-reduces the visible range at full detail.
  - Updates pause while the browser tab is hidden. Missed states (tab hidden, view switched,
    connection lost) are fetched for just the gap.
- **History and long-term statistics.** Windows up to 72 h use recorder history; longer ones use
  long-term statistics automatically. Statistics can be `mean`, `min`, `max`, `state`, `sum` or
  `change`, for example hourly water use.
- **Sensible data handling.**
  - `unavailable` and `unknown` states break the line instead of drawing a fake value.
  - Binary sensors (and doors, locks, covers, people) are drawn as 0/1 step lines.
  - History lines extend to "now", and a value that did not change for a long time is drawn
    flat instead of as a slow ramp (Home Assistant only records changes).
- **Bars, forecasts and day windows.**
  - `type: bar` draws one bar per hour (or any bucket), e.g. energy per hour from statistics.
  - `value_key` plots list attributes such as Solcast's `detailedForecast` or a price list,
    read live from the entity.
  - `span: { start: day }` shows today from midnight to midnight, including the forecast for
    the rest of the day.
- **Multiple y-axes.** Series are assigned to axes by unit automatically. You can also configure
  axes yourself with hard or *soft* bounds, a side, and a precision.
- **Styling.**
  - Reference lines and bands (`thresholds`).
  - Value-based line colours (`color_thresholds`).
  - Dashed and dotted lines, step lines, and solid or gradient fills.
  - Colours can be `var(--theme-variable)`.
- **Grouping and transforms.** `group_by` offers time-weighted `avg`, plus `min`, `max`, `first`,
  `last`, `sum`, `delta` and `median`. `transform` supports `multiply` and `offset`.
- **Fits into Home Assistant.**
  - Follows the light/dark theme and theme variables.
  - Uses the time zone from your HA profile (server or browser).
  - Uses the number and time formats of your language.
  - Supports the sections layout and the card picker.
  - Clicking a value opens the more-info dialog.
- **Self-contained.** It ships a tree-shaken ECharts build (the whole card is about 240 kB gzipped) and does not
  depend on HA's internal chart elements, so it works on every dashboard.

## Installation

### HACS (custom repository)

1. In Home Assistant open **HACS**, then **⋮** (top right), then **Custom repositories**.
2. Add `https://github.com/bdeak/echart-graph-card` with type **Dashboard**.
3. Search HACS for **ECharts Graph Card**, open it and click **Download**.
4. Reload the browser (hard refresh). HACS adds the dashboard resource
   `/hacsfiles/echart-graph-card/echart-graph-card.js` for you.

### Manual

1. Download `echart-graph-card.js` from the latest
   [release](https://github.com/bdeak/echart-graph-card/releases), or take `dist/echart-graph-card.js`
   from this repository.
2. Copy it to `/config/www/echart-graph-card.js`.
3. Add it as a dashboard resource. Go to **Settings → Dashboards → ⋮ → Resources → Add resource**,
   enter the URL `/local/echart-graph-card.js?v=0.1.0` and choose type **JavaScript module**. In
   YAML mode, use this instead:

   ```yaml
   lovelace:
     resources:
       - url: /local/echart-graph-card.js?v=0.1.0
         type: module
   ```

   Change the `?v=` value after every update so browsers load the new file.
4. Hard-refresh the browser.

## Examples

Each file in [`examples/`](examples) is a complete card config. You can paste any of them into a
manual card (YAML) or view them all in the [dev harness](#development).

| File | Shows |
| --- | --- |
| [`minimal.yaml`](examples/minimal.yaml) | The smallest config: one entity, all defaults |
| [`temperature.yaml`](examples/temperature.yaml) | Indoor vs. outdoor over 48 h, a thermostat setpoint *attribute* as a dashed step line, min/max/avg badges |
| [`battery_soc.yaml`](examples/battery_soc.yaml) | Two batteries on a fixed 0–100 % axis, line colour by charge level, a "reserve" band |
| [`humidity.yaml`](examples/humidity.yaml) | 7 days from long-term statistics, a comfort band, soft axis bounds |
| [`energy_flow.yaml`](examples/energy_flow.yaml) | Grid / solar / battery power over 2 h with 30 s averages, a soft −3000…5000 W range, a dashed zero line (an apexcharts-card port) |
| [`water_usage.yaml`](examples/water_usage.yaml) | Hourly water consumption from statistics (`statistic: change`) as a filled step line |
| [`multi_axis.yaml`](examples/multi_axis.yaml) | Power (W, left) and state of charge (%, right) in one chart |
| [`door.yaml`](examples/door.yaml) | A binary sensor as an on/off timeline |

Energy flow, with grid import positive and battery discharge positive:

```yaml
type: custom:echart-graph-card
title: Energy Flow
span: 2h
height: 250px
group_by: { func: avg, duration: 30s }
y_axes:
  - { id: power, unit: W, soft_min: -3000, soft_max: 5000 }
thresholds:
  - { value: 0, style: dashed }
series:
  - { entity: sensor.grid_measured_total_power, name: Grid, color: "#2196F3" }
  - { entity: sensor.growatt_min_3000_tl_x_growatt_pv_power_total, name: Solar, color: "#FFC107" }
  - { entity: sensor.batteries_total_power, name: Battery, color: "#4CAF50" }
```

Battery charge with value-based colours:

```yaml
type: custom:echart-graph-card
title: Battery
y_axes:
  - { id: soc, unit: "%", min: 0, max: 100 }
thresholds:
  - { from: 0, to: 10, color: "#EF4444", label: Reserve }
series:
  - entity: sensor.marstek_venus_modbus_battery_soc
    color_thresholds:
      - { value: 0, color: "#EF4444" }
      - { value: 20, color: "#F59E0B" }
      - { value: 50, color: "#10B981" }
```

> YAML tip: quote colours (`"#2196F3"`), because `#` starts a comment. Also quote a bare `%`
> (`unit: "%"`), because YAML does not allow a plain value to start with `%`.

## Configuration

Only `type` and `series` are required. Durations accept `ms`, `s`, `m`/`min`, `h`, `d`, `w` and
combinations such as `1h30m` or `1.5h`. A bare number means seconds, except for `span`, where it
means hours. Colours can be any CSS colour (hex, `rgb()`, `hsl()`, names) or a theme variable such
as `var(--accent-color)`.

### Card options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `type` | string | **required** | `custom:echart-graph-card` |
| `series` | list | **required** | The series to plot (see [Series](#series-options)). A bare entity id is shorthand for `{ entity: <id> }`. `entities` is accepted as an alias. |
| `title` | string | – | Card title. |
| `hours_to_show` | number | `24` | Window length in hours. Ignored when `span` is set. |
| `span` | duration \| `{ start: day, duration }` | – | Window length, e.g. `2h` or `7d`. Takes precedence over `hours_to_show`. As an object the window starts at local midnight instead of ending now: `span: { start: day }` is today 00:00–24:00 (also on 23 h / 25 h DST days). `duration` defaults to `hours_to_show`, else 24 h. The card reloads when a new day begins. |
| `height` | number \| CSS length | `220px` | Chart height; a number means px. Other units: `rem`, `em`, `vh`, `vw` and the like. `%` and `auto` are not supported. In the sections layout see [below](#sections-layout). |
| `data_source` | `auto` \| `history` \| `statistics` | `auto` | `auto` uses recorder history for windows up to 72 h and long-term statistics above that (or whenever `statistics_period` is set). In `auto` mode, entities without statistics (no `state_class`) fall back to history. External statistics (`source:id`) and series with an explicit `statistic` always use statistics. |
| `statistics_period` | `5minute` \| `hour` \| `day` \| `week` \| `month` | by span | Statistics bucket size. The default is `5minute` for windows up to 2 d, `hour` up to 31 d, and `day` above that. Setting it with `data_source: auto` makes the card use statistics for any window. HA keeps 5-minute statistics only for the recorder's purge window (10 days by default). |
| `update` | `live` \| `none` \| duration \| `{ interval: duration }` | `live` | `live`: new states are appended as they arrive, history is never refetched; statistics series are refreshed right after Home Assistant compiles new statistics (every 5 min for `5minute`, hourly otherwise). A duration of at least 5 s, such as `60s`, refetches the chart on that cadence; the header values still update live. `none` loads once and keeps the window fixed. |
| `group_by` | duration \| [group_by](#group_by) | – | Default bucketing for every series. A series can override it or opt out with `group_by: false`. |
| `show` | [show](#show) | | Toggles for header, legend, tooltip, zoom and more. |
| `y_axes` | list of [y_axes](#y_axes) | auto | Configured value axes. Without it, one axis is created per unit. |
| `thresholds` | list of [thresholds](#thresholds) | – | Horizontal reference lines and bands. |

### `show`

| Option | Default | Description |
| --- | --- | --- |
| `header_states` | `true` | Header chips with each series' name and current value. Clicking a chip's name hides or shows the series; clicking the value opens more-info. With a single series the value is shown large next to the title. |
| `legend` | auto | ECharts legend below the chart. By default the header chips act as the legend, and the legend only appears for series the chips cannot toggle: series with `show_in_header: false` (or all series with `header_states: false`). `true` lists every series. |
| `tooltip` | `true` | Tooltip on hover or tap, listing every series at that time. |
| `zoom` | `false` | Zoom the time axis. Pinch or Ctrl + mouse wheel zooms, dragging pans. Without Ctrl the mouse wheel scrolls the page as usual, and on touch screens a swipe scrolls the page until you have zoomed in. Zoom in to see full detail: the visible range is redrawn from every sample. |
| `extrema` | `false` | Min / max / avg of the visible window in the header chips. With `header_states: false`, min/max markers are drawn on the lines instead. |
| `points` | `false` | Draw a dot at every data point. |
| `x_axis` | `true` | Show time axis labels. |
| `y_axis` | `true` | Show value axis labels. With both axes off the chart becomes a full-bleed sparkline. |

### Series options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `entity` | string | **required** | Entity id (`sensor.x`, lower-case like in Home Assistant; a typo such as `sensor.Living_Room` is reported with a suggestion) or an external statistic id (`source:statistic_id`, always read from long-term statistics). |
| `name` | string | friendly name | Display name. Falls back to the entity id. |
| `color` | colour | palette | Line colour. Defaults to the built-in 10-colour palette by position. |
| `unit` | string | entity unit | Overrides `unit_of_measurement`. Also used for axis matching. Set it for `attribute` series (except climate temperatures / humidity, see below) and whenever `transform` changes the unit. |
| `y_axis` | string | auto | `y_axes[].id` to plot on. By default a series uses the configured axis with the same unit, otherwise an automatic axis for its unit. |
| `attribute` | string | – | Plot this attribute instead of the state, e.g. a climate entity's `temperature` setpoint. It always comes from history, because statistics only exist for states. Attributes have no unit in Home Assistant: temperature attributes of `climate` / `water_heater` entities get your temperature unit and humidity attributes `%`; set `unit` for anything else. With `value_key` the attribute is read as a list instead. |
| `value_key` | string | – | Plot a list attribute (see [List attributes](#list-attributes)): each item of `attribute` becomes a point, with this key as its value. |
| `time_key` | string | auto | With `value_key`: the item key holding its time. Default: the first of `period_start`, `start`, `start_time`, `startsAt`, `datetime`, `time`, `from` that the items have. |
| `type` | `line` \| `bar` | `line` | `bar` draws one bar per bucket (see [Bars](#bars)). `column` is accepted as an alias. |
| `line` | [line](#line) | | Width, smoothing, steps, dash style. |
| `fill` | `none` \| `solid` \| `gradient` | `gradient` for 1–2 series, else `none` (and `none` with 2+ `color_thresholds` stops); bars `solid` | Area fill under the line. For bars: the bar's fill (`none` = outline only). |
| `fill_opacity` | 0..1 | gradient `0.35`, solid `0.2`, bars `0.45` | Fill strength. For gradients this is the opacity at the line; it fades to 0 at the baseline. |
| `group_by` | duration \| [group_by](#group_by) \| `false` | card `group_by` | Per-series bucketing. `"5m"` means `{ func: avg, duration: 5m }`. `false` ignores the card-level default. |
| `transform` | `{ multiply, offset }` | `{ multiply: 1, offset: 0 }` | Applied to every value as `value * multiply + offset`, e.g. `multiply: 0.001` with `unit: kW` for W to kW, or `multiply: -1` to invert. The unit is not changed for you. |
| `color_thresholds` | list of [color_thresholds](#color_thresholds) | – | Colour the line (and fill) by value. |
| `statistic` | `mean` \| `min` \| `max` \| `sum` \| `state` \| `change` | auto | Statistics column to plot. Auto picks `state` for `total` / `total_increasing` entities (meters) and `mean` otherwise. Use `change` for "consumption per period". Setting it makes this series use long-term statistics for any window, without falling back to history. |
| `precision` | 0..10 | display precision | Decimals in the header and tooltip. Defaults to the entity's display precision, otherwise it is chosen from the value. |
| `show_in_header` | boolean | `true` | Show a header chip for this series. |
| `hidden` | boolean | `false` | Start hidden. Clicking the header chip or legend entry shows it. |

### `line`

| Option | Default | Description |
| --- | --- | --- |
| `width` | `2` (binary: `1.5`, bars: `1`) | Stroke width in px. For bars: the border width (`0` = none). |
| `smooth` | `true` | `true`/`false`, or a smoothness factor 0..1 (`true` = 0.35). Always off for stepped lines. |
| `step` | auto | `true` (= `end`), `start`, `middle`, `end` or `false`. Auto uses `end` for binary sensors and no steps otherwise. `end` is the right choice for sample-and-hold sensor data and for bucketed values. |
| `style` | `solid` | `solid`, `dashed` or `dotted`. |

### `group_by`

```yaml
group_by: 5m                          # shorthand for { func: avg, duration: 5m }
group_by: { func: max, duration: 1h }
```

| `func` | Bucket value |
| --- | --- |
| `avg` (default) | Time-weighted average. Each state holds until the next one, so sparse sensors are averaged correctly. |
| `min` / `max` | Lowest / highest value in the bucket, including the value carried in from before it. |
| `first` / `last` | Value at the bucket start / last sample in the bucket. |
| `sum` | Sum of the samples in the bucket. |
| `delta` | Last value minus the value at the bucket start, e.g. meter increase per hour. Consecutive deltas add up to the total increase. |
| `median` | Median of the samples in the bucket. |

Each bucket is plotted at its start time (at its centre in a card with bars, see [Bars](#bars)). Buckets of 1 h and shorter start at round clock times, e.g. 5 m buckets at :00, :05 and so on, in whole-hour time zones. Longer
ones (2 h, 3 h, 4 h, 6 h, 8 h, 12 h, days, weeks from Monday) align to local wall-clock time in
the display time zone. Buckets with only `unavailable` samples stay gaps. Empty buckets between
two samples repeat the held value (0 for `sum`/`delta`). Grouping applies to live data too: the
current bucket is re-aggregated as new states arrive.

### Bars

```yaml
statistics_period: hour
series:
  - entity: sensor.solar_energy_today   # a total_increasing kWh counter
    type: bar
    statistic: change                   # energy per hour
```

A bar covers one bucket: a statistics row (`statistics_period`), a `group_by` bucket, or a list
attribute item. It is drawn centred on its bucket, 72 % of it wide, in the series colour with a
translucent fill and a 1 px border. Hours with 0 draw no bar, and an axis with bars starts at 0
unless you set its `min`. Several bar series stand side by side. In a card with bars, bucketed
lines (statistics, `group_by`, list attributes; not stepped) are drawn at their bucket centres
too, so a forecast line peaks over the bar of the same hour. Hovering a bar shows its range
("08:00 – 09:00") in the tooltip.

Bars need buckets: bars of raw history (no `group_by`, no `statistic`) get a warning. For a
current hour that fills in during the hour, use 5-minute statistics summed per hour:
`statistics_period: 5minute` plus `group_by: { func: sum, duration: 1h }` on the series.

### List attributes

Some integrations keep a whole series in one attribute: Solcast's `detailedForecast`, energy
price lists, tariff schedules. `value_key` plots such a list:

```yaml
series:
  - entity: sensor.solcast_pv_forecast_forecast_today
    attribute: detailedForecast   # [{ period_start, pv_estimate, pv_estimate10, ... }, ...]
    value_key: pv_estimate        # kW per half hour
    group_by: { func: avg, duration: 1h }   # average kW per hour = kWh per hour
    unit: kWh
```

- The list is read from the entity's **current** state, not from history, and re-read every time
  the entity changes. Items before the window are dropped; items after it (tomorrow) are not drawn.
- Each item is valid until the next one: the tooltip shows the item covering the hovered time.
- Times can be ISO strings or epoch seconds / milliseconds. Values go through the usual number
  parsing; anything non-numeric is a gap. `transform` and `group_by` apply as usual.
- Set `unit`: list items have none.
- The header chip shows the item (bucket) covering now. For forecasts that is rarely what you
  want in the header; `show_in_header: false` moves the series to the legend.

### `y_axes`

| Option | Default | Description |
| --- | --- | --- |
| `id` | **required** | Unique id, referenced by `series[].y_axis` and `thresholds[].y_axis`. |
| `unit` | – | Series with this unit (and no explicit `y_axis`) are put on this axis. |
| `name` | – | Axis title. |
| `min` / `max` | `auto` | Hard bounds (`auto` fits the data). |
| `soft_min` / `soft_max` | – | The axis always includes this value and extends further if the data does. apexcharts' `~-3000` becomes `soft_min: -3000`. |
| `position` | `left`, `right`, alternating | Side of the chart. |
| `precision` | auto | Decimals of the axis labels. |
| `show` | `true` | Show labels for this axis. |

**Axis assignment:**

1. A series with an explicit `y_axis` uses that axis.
2. Otherwise it uses the configured axis whose `unit` matches the series unit.
3. Otherwise it gets an automatic axis for its unit. The first unit goes left, the second right.

Binary sensors use their own hidden 0..1 axis.

### `thresholds`

A horizontal line when `value` is set, or a band when `from` and/or `to` is set.

| Option | Default | Description |
| --- | --- | --- |
| `value` | – | Draw a line at this value. |
| `from` / `to` | axis min / max | Band bounds. Omit one side to extend the band to the axis edge. |
| `color` | secondary text colour | Line or band colour. |
| `style` | `dashed` | `solid`, `dashed` or `dotted` (lines). |
| `width` | `1` | Line width in px. |
| `opacity` | line `0.8`, band `0.12` | |
| `label` | – | Text at the line's right end, or inside the band. |
| `y_axis` | first axis | Axis the value refers to. |

```yaml
thresholds:
  - { value: 0, style: dashed }                          # zero line
  - { from: 40, to: 60, color: "#10B981", label: Comfort }  # band
  - { from: 80, color: "#EF4444" }                       # everything above 80
```

Lines and bands with both ends always stay visible: an automatic axis grows to include them
(soft bounds too). A band with an open end does not stretch the axis. Use `y_axes` `min`/`max`
if an axis must not grow.

### `color_thresholds`

A list of `{ value, color }` stops, in any order. A stop's colour applies from its `value` up to
the next stop, and values below the lowest stop use the lowest stop's colour. The colours change
in hard steps at the stop values, with no blending between them.

A value-coloured line has no fill by default. If you set `fill`, the area takes the same colours,
as horizontal bands at the stop values.

```yaml
color_thresholds:
  - { value: 0, color: "#EF4444" }   # below 20: red
  - { value: 20, color: "#F59E0B" }  # 20..50: amber
  - { value: 50, color: "#10B981" }  # 50 and above: green
```

## How it behaves

- **Window.** The x-axis covers `[now - span, now]` and moves forward every minute. With
  `span: { start: day }` it covers the local day instead, and the part after now stays empty
  (except for list attributes such as forecasts). History lines are extended to "now" with the
  last known value.
- **Live updates** (`update: live`). New states from Home Assistant are appended as they arrive,
  without any request to the recorder. Redraws are throttled to about one per second.
  Statistics-based series update only their header value until Home Assistant has compiled the
  next statistics period; then only they are refetched. Refreshes keep your zoom and an open
  tooltip.
- **Catching up.** When the card missed states (it was on another view for more than a minute,
  the tab was hidden for 5 minutes or more, or the connection to Home Assistant dropped), it
  fetches the history of just that gap. A failed load or refresh is retried every 30 seconds.
- **Gaps.** `unavailable`, `unknown` and non-numeric states break the line.
- **Binary sensors.** Entities from `binary_sensor`, `input_boolean`, `switch` and similar
  on/off entities are plotted as 0/1 step lines, with the entity's own state names in the
  tooltip (*On*/*Off*, *Open*/*Closed*, ...). Covers are 1 unless `closed`, locks are 1 unless
  `locked` (a jammed lock counts as unlocked), and people / device trackers are 1 only at `home`
  (any other zone counts as away).
- **Sparse sensors.** Home Assistant records a state only when it changes. When a value did not
  change for much longer than the sensor usually reports (at most an hour), the line stays flat
  and then jumps, instead of ramping slowly across the gap.
- **Tooltip.** The tooltip is attached to the page body, so it is never clipped by the card, and
  it uses the theme colours.
- **Time zone and formats.** Times follow the time zone setting of your HA profile: *server*
  uses the Home Assistant time zone, *local* uses the browser's. Numbers and times follow the
  profile's language, number format and 12/24 h setting.
- **Errors.** An invalid config shows Home Assistant's error card with the exact path, e.g.
  `Invalid config: series[1].y_axis references unknown y-axis "pwr" (known: power)`. An unknown entity or a
  failed WebSocket call is shown inside the card, and the load is retried. Unknown options are
  listed inside the card as warnings, with the matching option for common apexcharts-card and
  mini-graph-card keys (for example `graph_span` → `span`).
- **Performance.** A 24 h window of three 5-second power sensors is about 50,000 points. It
  loads with one WebSocket call and is reduced to a few points per pixel before drawing. The
  reduction and the header's min / max / avg are cached and only updated at the edges as new
  states arrive, so live redraws stay cheap however long the history is.

### Sections layout

In a sections view the card sizes itself to its content (header plus `height`), like Home
Assistant's own history graph card. To make it fill a grid cell instead, give it a fixed number
of rows in the layout editor (`grid_options: { rows: 5 }`); the chart then takes whatever height
the header leaves.

## Migrating from apexcharts-card

| apexcharts-card | echart-graph-card |
| --- | --- |
| `graph_span: 2h` | `span: 2h` |
| `span: { start: day }` | `span: { start: day }` (with `graph_span` → `span.duration`); `end`, `offset` and other `start` values are not supported |
| `header: { show, title, show_states }` | `title:` and `show: { header_states: true }` |
| `update_interval: 60s` | `update: 60s` (the default is live) |
| `series[].name` / `color` / `unit` | same |
| `series[].type: line` / `area` | `line` plus `fill: gradient \| solid \| none` |
| `series[].type: column` | `type: bar` |
| `series[].data_generator` reading an attribute list | `attribute` + `value_key` (+ `time_key`), see [List attributes](#list-attributes) |
| `series[].stroke_width` | `line.width` |
| `series[].curve: smooth \| straight \| stepline` | `line.smooth: true`, `line.smooth: false`, `line.step: true` |
| `series[].stroke_dash` | `line.style: dashed \| dotted` |
| `series[].group_by: { func, duration }` | `group_by: { func, duration }` (per series or card-wide; `fill` is not needed) |
| `series[].transform: "return x * 1000;"` | `transform: { multiply: 1000 }` (JavaScript is not supported) |
| `series[].invert: true` | `transform: { multiply: -1 }` |
| `series[].statistics: { type, period }` | card `data_source: statistics`, `statistics_period`, series `statistic` |
| `series[].show: { in_header: false }` | `show_in_header: false` |
| `series[].show: { legend_value, in_chart }` | `show.legend`; use `hidden: true` to start hidden |
| `series[].float_precision` | `precision` |
| `series[].color_threshold` | `color_thresholds` |
| `series[].extend_to: now` | automatic for history series |
| `yaxis: [{ id, min: ~-3000, max: ~5000, opposite, decimals }]` | `y_axes: [{ id, soft_min: -3000, soft_max: 5000, position: right, precision }]` (`min`/`max` without `~` stay hard bounds; a leftover `~` value is rejected with this hint) |
| `series[].yaxis_id` | `y_axis` |
| `apex_config.annotations.yaxis` | `thresholds` |
| `all_series_config` | card-level `group_by`; other options are set per series |

Energy flow, before (apexcharts-card) and after:

```yaml
type: custom:apexcharts-card
graph_span: 2h
header: { show: true, title: Energy Flow, show_states: true }
yaxis:
  - min: ~-3000
    max: ~5000
apex_config:
  annotations:
    yaxis:
      - { y: 0, strokeDashArray: 4 }
all_series_config:
  group_by: { func: avg, duration: 30s }
series:
  - { entity: sensor.grid_measured_total_power, name: Grid, color: "#2196F3" }
  - { entity: sensor.growatt_min_3000_tl_x_growatt_pv_power_total, name: Solar, color: "#FFC107" }
  - { entity: sensor.batteries_total_power, name: Battery, color: "#4CAF50" }
```

```yaml
type: custom:echart-graph-card
title: Energy Flow
span: 2h
group_by: { func: avg, duration: 30s }
y_axes:
  - { id: power, unit: W, soft_min: -3000, soft_max: 5000 }
thresholds:
  - { value: 0, style: dashed }
series:
  - { entity: sensor.grid_measured_total_power, name: Grid, color: "#2196F3" }
  - { entity: sensor.growatt_min_3000_tl_x_growatt_pv_power_total, name: Solar, color: "#FFC107" }
  - { entity: sensor.batteries_total_power, name: Battery, color: "#4CAF50" }
```

## Development

You need Node.js 24 (or at least 20.19 / 22.12, as required by Vite 8) and npm.

```sh
npm ci
npm run dev        # dev harness with a mock Home Assistant at http://localhost:5173
npm test           # unit tests (Vitest, happy-dom)
npm run lint       # ESLint
npm run typecheck  # tsc --noEmit (strict)
npm run build      # dist/echart-graph-card.js (single ES module, minified)
```

### Dev harness

`npm run dev` serves [`dev/`](dev). It shows one card for every `examples/*.yaml` file, rendered
against a mock `hass` object (`dev/mock-hass.ts`):

- **Synthetic home** (`dev/synth.ts`):
  - indoor and outdoor temperature, humidity, and two battery SoC sensors
  - grid, solar and battery power, with the battery controller holding the grid near 40 W, so
    values go negative on charge and export
  - a `total_increasing` water meter, a door sensor, and a thermostat with a setpoint attribute
  - a daily PV energy counter and a Solcast-like forecast sensor with a `detailedForecast` list
    (P10 / P50 / P90 per half hour)
  - diurnal and seasonal curves, noise, and `unavailable` / `unknown` gaps
- **WebSocket:** `callWS` answers `history/history_during_period`,
  `recorder/statistics_during_period` and `recorder/get_statistics_metadata` in HA's wire
  format, with realistic latency.
- **Live states:** state changes are pushed every 2 s, the same way HA does it (a new `hass`
  object, `last_changed` / `last_updated` semantics).
- **Toolbar:** light/dark theme (swaps real HA theme variables on `:root`), pause live updates,
  reload cards, and simulate a WebSocket reconnect.

URL options:

| Parameter | Effect |
| --- | --- |
| `?dark=1` | Start with the dark theme |
| `?only=energy_flow,door` | Render only these examples |
| `?live=0` | No live updates (stable screenshots) |
| `?at=14:00` | Shift the synthetic data so "now" looks like 14:00 in Europe/Berlin |
| `?lang=de`, `?time=12`, `?tz=local` | `hass.locale` language, time format and time zone |
| `?cols=2`, `?width=520` | Grid columns or fixed card width |
| `?tick=1000`, `?latency=0`, `?seed=2` | Live update period, WebSocket latency, other data |
| `?stress=1` | Adds a 7-day raw-history card (about 120,000 points per series) |
| `?bundle=1` | Load the built `dist/echart-graph-card.js` instead of the sources |
| `?debug=1` | Log every mock WebSocket call |

Headless screenshots with a running dev server:

```sh
chrome --headless=new --hide-scrollbars --window-size=1400,1900 --virtual-time-budget=8000 \
  --screenshot=dark.png "http://localhost:5173/?dark=1&live=0&at=14:00"
```

The harness has its own self-tests: every example parses and passes config validation, and the
mock speaks the HA protocol. They run as part of `npm test` (or alone with
`npx vitest run --config dev/vitest.config.ts`).

### Project layout

```
src/index.ts            custom element + card picker registration, version banner
src/card.ts             the Lovelace card (lifecycle, timers, live updates, rendering)
src/config.ts           YAML validation + defaults -> NormalizedConfig
src/types.ts            shared types (config, runtime data, HA surface)
src/data/               history / statistics fetch, loader, group_by + transform, live buffer
src/chart/              ECharts registration, option builder, theme, formatting
src/header.ts           title + state chips
dev/                    harness: index.html, main.ts, mock-hass.ts, synth.ts, yaml.ts
examples/               example card configs
tests/                  Vitest unit tests
```

## Releasing

1. Bump `version` in `package.json` **and** `CARD_VERSION` in `src/const.ts`. A test checks that
   they match.
2. Add the release to `CHANGELOG.md`.
3. Run `npm run build` and commit `dist/echart-graph-card.js`. `dist/` is committed so HACS can
   also install from the default branch, and CI warns when it is stale.
4. Tag and push: `git tag v0.2.0 && git push origin v0.2.0`.

The **Release** workflow checks that the tag matches `package.json`, runs lint, typecheck and
tests, builds, and attaches `dist/echart-graph-card.js` to a GitHub release with generated notes.
Tags that contain a `-`, such as `v0.2.0-beta.1`, become pre-releases. HACS then offers the new
version.

CI (`.github/workflows/build.yml`) runs the same checks on every push and pull request. The
**Validate** workflow runs the HACS action (`category: plugin`). It needs a repository
description and topics set on GitHub. The `images` check is skipped until the README has
screenshots.

## License

[MIT](LICENSE) © Balint Deak
