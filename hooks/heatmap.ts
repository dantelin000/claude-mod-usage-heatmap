// The heatmap's arithmetic and drawings, free of `$`: days, levels, streaks,
// numbers in Chinese units, the desktop's SVG and the terminal's Raster cells.
// Days are counted as whole days since 1970-01-01 in the person's local zone,
// from the offset aggregate.py reports, never from this environment's zone.

import type { Aggregate, DayUsage } from '../types'

export type Metric = 'new' | 'all'
export type Palette = 'claude' | 'green'
export type Level = 0 | 1 | 2 | 3 | 4

const DAY_MS = 86_400_000
export const MAX_WEEKS = 53
export const MIN_WEEKS = 4
export const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'] as const

const ACCENT: Record<Palette, number> = { claude: 0xd97757, green: 0x2ea043 }
const OPACITY: readonly number[] = [0, 0.32, 0.55, 0.78, 1]

// ---------------------------------------------------------------- days

const pad = (n: number) => String(n).padStart(2, '0')

/** Days since 1970-01-01 of a `YYYY-MM-DD`. */
export function dayNumber(day: string): number {
  const [year = 1970, month = 1, date = 1] = day.split('-').map(Number)
  return Math.round(Date.UTC(year, month - 1, date) / DAY_MS)
}

export function dayString(day: number): string {
  const moment = new Date(day * DAY_MS)
  return `${moment.getUTCFullYear()}-${pad(moment.getUTCMonth() + 1)}-${pad(moment.getUTCDate())}`
}

/** Monday 0 … Sunday 6 (1970-01-01 was a Thursday). */
export function weekday(day: number): number {
  return (((day + 3) % 7) + 7) % 7
}

/** Today in the person's zone, from the clock and the offset aggregate.py saw. */
export function todayOf(nowMs: number, offsetMinutes: number): number {
  return Math.floor((nowMs + offsetMinutes * 60_000) / DAY_MS)
}

function parts(day: number) {
  const moment = new Date(day * DAY_MS)
  return { year: moment.getUTCFullYear(), month: moment.getUTCMonth() + 1, date: moment.getUTCDate() }
}

/** `2026年10月15日 周四` */
export function longDate(day: number): string {
  const { year, month, date } = parts(day)
  return `${year}年${month}月${date}日 ${WEEKDAYS[weekday(day)]}`
}

/** `10月15日`, with the year when it is not this year's. */
export function shortDate(day: number, today: number): string {
  const { year, month, date } = parts(day)
  return year === parts(today).year ? `${month}月${date}日` : `${year}年${month}月${date}日`
}

// ---------------------------------------------------------------- numbers

/** `123,456,789` */
export function grouped(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** `n` to at most `digits` decimals, trailing zeros dropped: 1.20 → `1.2`. */
function trimmed(n: number, digits: number): string {
  return String(Number(n.toFixed(digits)))
}

/** `9,876`, `12.3万`, `4.56亿` */
export function compact(n: number): string {
  if (n < 10_000) return grouped(n)
  if (n < 100_000_000) return `${trimmed(n / 10_000, n < 1_000_000 ? 1 : 0)}万`
  return `${trimmed(n / 100_000_000, n < 10_000_000_000 ? 2 : 1)}亿`
}

export function tokensOf(usage: DayUsage | undefined, metric: Metric): number {
  if (usage === undefined) return 0
  const fresh = usage.input + usage.cacheWrite + usage.output
  return metric === 'all' ? fresh + usage.cacheRead : fresh
}

export function metricName(metric: Metric): string {
  return metric === 'all' ? '全部 token' : '新 token'
}

// ---------------------------------------------------------------- grid

export type Cell = {
  day: number
  usage: DayUsage | undefined
  value: number
  level: Level
}

export type MonthLabel = { week: number; text: string }

export type Grid = {
  weeks: number
  today: number
  /** `columns[week][weekday]`; null past today. */
  columns: (Cell | null)[][]
  months: MonthLabel[]
  /** The metric's sum over the days drawn. */
  total: number
  activeDays: number
}

/**
 * Levels by percentile rank among the days with any usage, as GitHub does:
 * a quarter of the active days in each of levels 1 to 4, ties together.
 */
export function levelsOf(values: readonly number[]): (value: number) => Level {
  const sorted = values.filter(v => v > 0).sort((a, b) => a - b)
  return value => {
    if (value <= 0 || sorted.length === 0) return 0
    let low = 0
    let high = sorted.length
    while (low < high) {
      const middle = (low + high) >> 1
      if (sorted[middle]! <= value) low = middle + 1
      else high = middle
    }
    return Math.max(1, Math.min(4, Math.ceil((4 * low) / sorted.length))) as Level
  }
}

/** How many weeks fit `room` units when each week takes `perWeek` after `fixed`. */
export function weeksThatFit(room: number, fixed: number, perWeek: number): number {
  const fit = Math.floor((room - fixed) / perWeek)
  return Math.max(MIN_WEEKS, Math.min(MAX_WEEKS, fit))
}

export function buildGrid(
  aggregate: Aggregate | null,
  today: number,
  weeks: number,
  metric: Metric,
  minLabelGap = 3,
): Grid {
  const days = aggregate?.days ?? {}
  const start = today - weekday(today) - (weeks - 1) * 7
  const values: number[] = []
  for (let day = start; day <= today; day++) values.push(tokensOf(days[dayString(day)], metric))
  const level = levelsOf(values)

  const columns: (Cell | null)[][] = []
  let total = 0
  let activeDays = 0
  for (let week = 0; week < weeks; week++) {
    const column: (Cell | null)[] = []
    for (let row = 0; row < 7; row++) {
      const day = start + week * 7 + row
      if (day > today) {
        column.push(null)
        continue
      }
      const usage = days[dayString(day)]
      const value = tokensOf(usage, metric)
      total += value
      if (value > 0) activeDays += 1
      column.push({ day, usage, value, level: level(value) })
    }
    columns.push(column)
  }

  // A month is named over the first column whose Monday falls in it; a name
  // with too little room before the next one (the partial first month) goes.
  const named: MonthLabel[] = []
  let previous = -1
  for (let week = 0; week < weeks; week++) {
    const { month } = parts(start + week * 7)
    if (month !== previous) named.push({ week, text: `${month}月` })
    previous = month
  }
  const months = named.filter((label, i) => {
    const next = named[i + 1]
    return next === undefined || next.week - label.week >= minLabelGap
  })

  return { weeks, today, columns, months, total, activeDays }
}

// ---------------------------------------------------------------- stats

export type Stats = {
  total: number
  sessions: number
  currentStreak: number
  longestStreak: number
  busiest: { day: number; value: number } | null
  activeDays: number
  firstDay: number | null
}

export function statsOf(aggregate: Aggregate | null, today: number, metric: Metric): Stats {
  const active: number[] = []
  let total = 0
  let busiest: Stats['busiest'] = null
  for (const [date, usage] of Object.entries(aggregate?.days ?? {})) {
    const value = tokensOf(usage, metric)
    if (value <= 0) continue
    const day = dayNumber(date)
    total += value
    active.push(day)
    if (busiest === null || value > busiest.value || (value === busiest.value && day > busiest.day)) {
      busiest = { day, value }
    }
  }
  active.sort((a, b) => a - b)

  let longestStreak = 0
  let run = 0
  for (let i = 0; i < active.length; i++) {
    run = i > 0 && active[i] === active[i - 1]! + 1 ? run + 1 : 1
    longestStreak = Math.max(longestStreak, run)
  }

  // Today still counts toward a streak that ran through yesterday.
  const isActive = new Set(active)
  let currentStreak = 0
  let day = isActive.has(today) ? today : today - 1
  while (isActive.has(day)) {
    currentStreak += 1
    day -= 1
  }

  return {
    total,
    sessions: aggregate?.sessions ?? 0,
    currentStreak,
    longestStreak,
    busiest,
    activeDays: active.length,
    firstDay: active[0] ?? null,
  }
}

export function hasUsage(aggregate: Aggregate | null): boolean {
  return Object.values(aggregate?.days ?? {}).some(usage => usage.messages > 0)
}

// ---------------------------------------------------------------- hover text

export function cellTitle(cell: Cell, metric: Metric): string {
  const usage = cell.usage
  const head = longDate(cell.day)
  if (usage === undefined || usage.messages === 0) return `${head}\n没有用量`
  return [
    head,
    `${metricName(metric)}：${grouped(cell.value)}`,
    `输入 ${grouped(usage.input)} · 缓存写入 ${grouped(usage.cacheWrite)} · 输出 ${grouped(usage.output)}`,
    `缓存读取 ${grouped(usage.cacheRead)}`,
    `${usage.sessions} 个会话 · ${usage.messages} 次回复`,
  ].join('\n')
}

export function rangeSummary(grid: Grid, metric: Metric): string {
  const today = grid.columns.at(-1)?.find(cell => cell?.day === grid.today)
  return `近 ${grid.weeks} 周 ${metricName(metric)} ${compact(grid.total)} · 今天 ${compact(today?.value ?? 0)}`
}

// ---------------------------------------------------------------- desktop: SVG

export const SVG_CELL = 10
export const SVG_GAP = 3
export const SVG_PITCH = SVG_CELL + SVG_GAP
export const SVG_LEFT = 30
const SVG_TOP = 16
const SVG_FOOT = 24

const escapeXml = (text: string) =>
  text.replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`)

const hex = (rgb: number) => `#${rgb.toString(16).padStart(6, '0')}`

export type SvgDrawing = { source: string; width: number; height: number; alt: string }

export function heatmapSvg(grid: Grid, palette: Palette, metric: Metric): SvgDrawing {
  const accent = hex(ACCENT[palette])
  const gridWidth = grid.weeks * SVG_PITCH - SVG_GAP
  const width = SVG_LEFT + gridWidth + 1
  const gridBottom = SVG_TOP + 7 * SVG_PITCH - SVG_GAP
  const height = gridBottom + SVG_FOOT
  const out: string[] = []
  // Paint for a level, and the classes beside it (`z`: the empty cell's grey).
  const paint = (level: Level, classes: string[]) => {
    const names = level === 0 ? [...classes, 'z'] : classes
    const fill = level === 0 ? '' : ` fill="${accent}" fill-opacity="${OPACITY[level]}"`
    return (names.length > 0 ? ` class="${names.join(' ')}"` : '') + fill
  }

  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img">`,
    '<style>',
    'text{fill:#6e6e6e;font:9px -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}',
    '.z{fill:#8c8c8c;fill-opacity:.16}',
    'rect{shape-rendering:geometricPrecision}',
    '.c:hover{stroke:#8c8c8c;stroke-width:1}',
    '@media (prefers-color-scheme:dark){text{fill:#a3a3a3}.z{fill:#a3a3a3;fill-opacity:.14}}',
    '</style>',
  )

  for (const label of grid.months) {
    out.push(`<text x="${SVG_LEFT + label.week * SVG_PITCH}" y="${SVG_TOP - 5}">${label.text}</text>`)
  }
  for (const row of [0, 2, 4]) {
    out.push(`<text x="0" y="${SVG_TOP + row * SVG_PITCH + SVG_CELL - 1}">${WEEKDAYS[row]}</text>`)
  }

  grid.columns.forEach((column, week) => {
    column.forEach((cell, row) => {
      if (cell === null) return
      const x = SVG_LEFT + week * SVG_PITCH
      const y = SVG_TOP + row * SVG_PITCH
      out.push(
        `<rect x="${x}" y="${y}" width="${SVG_CELL}" height="${SVG_CELL}" rx="2"${paint(cell.level, ['c'])}>` +
          `<title>${escapeXml(cellTitle(cell, metric))}</title></rect>`,
      )
    })
  })

  // The foot: the range's sum on the left, 少 ▢▢▢▢▢ 多 on the right.
  const footY = gridBottom + 8
  const textY = footY + SVG_CELL - 1
  const swatchesEnd = width - 14
  const swatchesStart = swatchesEnd - (5 * SVG_PITCH - SVG_GAP)
  out.push(`<text x="${SVG_LEFT}" y="${textY}">${escapeXml(rangeSummary(grid, metric))}</text>`)
  out.push(`<text x="${swatchesStart - 4}" y="${textY}" text-anchor="end">少</text>`)
  for (let level = 0; level <= 4; level++) {
    out.push(
      `<rect x="${swatchesStart + level * SVG_PITCH}" y="${footY}" width="${SVG_CELL}" height="${SVG_CELL}" rx="2"${paint(level as Level, [])}/>`,
    )
  }
  out.push(`<text x="${width}" y="${textY}" text-anchor="end">多</text>`)
  out.push('</svg>')

  const alt = `每日 token 用量格子图：${rangeSummary(grid, metric)}，${grid.activeDays} 天有用量`
  return { source: out.join(''), width, height, alt }
}

// ---------------------------------------------------------------- terminal: Raster

export const GLYPHS: readonly string[] = ['·', '░', '▒', '▓', '█']
const DEFAULT_COLOR = 0x01000000
const DIM = 0x808080

/** Packs cells as `RasterProps.cells` wants: base64 of u32 LE triplets. */
export function packCells(cells: readonly (readonly [string, number, number])[]): string {
  const bytes = new Uint8Array(cells.length * 12)
  const view = new DataView(bytes.buffer)
  cells.forEach(([glyph, foreground, background], i) => {
    view.setUint32(i * 12, glyph.codePointAt(0) ?? 0x20, true)
    view.setUint32(i * 12 + 4, foreground, true)
    view.setUint32(i * 12 + 8, background, true)
  })
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x2000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x2000))
  }
  return btoa(binary)
}

function glyphCell(level: Level, palette: Palette): readonly [string, number, number] {
  return [GLYPHS[level]!, level === 0 ? DIM : ACCENT[palette], DEFAULT_COLOR]
}

export const TERMINAL_LABEL_COLUMNS = 5

export type RasterDrawing = { cells: string; columns: number; rows: number }

/** The grid as cells: a glyph per day, a blank column between weeks. */
export function heatmapRaster(grid: Grid, palette: Palette): RasterDrawing {
  const columns = grid.weeks * 2 - 1
  const cells: (readonly [string, number, number])[] = []
  for (let row = 0; row < 7; row++) {
    for (let x = 0; x < columns; x++) {
      const cell = x % 2 === 0 ? grid.columns[x / 2]?.[row] : null
      cells.push(cell ? glyphCell(cell.level, palette) : [' ', DEFAULT_COLOR, DEFAULT_COLOR])
    }
  }
  return { cells: packCells(cells), columns, rows: 7 }
}

/** The last `count` days in one row, for a band with no room for the grid. */
export function stripRaster(
  aggregate: Aggregate | null,
  today: number,
  count: number,
  metric: Metric,
  palette: Palette,
): RasterDrawing {
  const values: number[] = []
  for (let day = today - count + 1; day <= today; day++) {
    values.push(tokensOf(aggregate?.days[dayString(day)], metric))
  }
  const level = levelsOf(values)
  return { cells: packCells(values.map(value => glyphCell(level(value), palette))), columns: count, rows: 1 }
}

/** Display width on a terminal: CJK takes two columns. */
export function displayWidth(text: string): number {
  let width = 0
  for (const ch of text) width += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1
  return width
}

/** The month names laid over the Raster's columns, as one line of text. */
export function monthLine(grid: Grid): string {
  let line = ' '.repeat(TERMINAL_LABEL_COLUMNS)
  let cursor = TERMINAL_LABEL_COLUMNS
  for (const label of grid.months) {
    const at = TERMINAL_LABEL_COLUMNS + label.week * 2
    if (at < cursor) continue
    line += ' '.repeat(at - cursor) + label.text
    cursor = at + displayWidth(label.text)
  }
  return line.trimEnd()
}
