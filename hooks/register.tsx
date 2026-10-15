import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, PluginOptions, Register, RenderElement } from 'claude-code'

import type { Aggregate, DayUsage, LoadState } from '../types'
import {
  GLYPHS,
  SVG_LEFT,
  SVG_PITCH,
  TERMINAL_LABEL_COLUMNS,
  buildGrid,
  compact,
  dayString,
  grouped,
  hasUsage,
  heatmapRaster,
  heatmapSvg,
  metricName,
  monthLine,
  rangeSummary,
  shortDate,
  statsOf,
  stripRaster,
  todayOf,
  tokensOf,
  weeksThatFit,
} from './heatmap.ts'
import type { Metric, Palette } from './heatmap.ts'

const PANE = 'usage-heatmap'
const STORE_KEY = 'aggregate'
const REFRESH_MS = 10 * 60_000
const STALE_MS = 60_000
const SCRIPT_TIMEOUT_MS = 10 * 60_000
/** Cells of a desktop surface's monospace metric, in CSS pixels (a guess). */
const DESKTOP_CELL_PX = 8
/** Rows the terminal grid takes: months, seven days, the foot. */
const TERMINAL_GRID_ROWS = 9
const ACCENT_TEXT: Record<Palette, string> = { claude: '#d97757', green: '#2ea043' }

const aggregate = atom({ plugin: 'usage-heatmap', key: 'aggregate' } as const, null)
const load = atom({ plugin: 'usage-heatmap', key: 'load' } as const, {
  isLoading: false,
  error: null,
  refreshedAt: 0,
})
const isFirstTurnDone = atom({ plugin: 'usage-heatmap', key: 'isFirstTurnDone' } as const, false)

type Terminal = Elements['terminal']
type Remote = Elements['desktop'] | Elements['mobile'] | Elements['vscode']

/** What one drawing needs, read once per render. */
type View = {
  aggregate: Aggregate | null
  load: LoadState
  today: number
  metric: Metric
  palette: Palette
  columns: number
}

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

function isDayUsage(value: unknown): value is DayUsage {
  if (typeof value !== 'object' || value === null) return false
  const day = value as Record<string, unknown>
  return ['input', 'cacheWrite', 'cacheRead', 'output', 'messages', 'sessions'].every(key => isCount(day[key]))
}

function isAggregate(value: unknown): value is Aggregate {
  if (typeof value !== 'object' || value === null) return false
  const held = value as Record<string, unknown>
  const days = held.days
  return (
    held.version === 1 &&
    isCount(held.generatedAt) &&
    isCount(held.utcOffsetMinutes) &&
    isCount(held.sessions) &&
    typeof days === 'object' &&
    days !== null &&
    Object.entries(days).every(([day, usage]) => /^\d{4}-\d{2}-\d{2}$/.test(day) && isDayUsage(usage))
  )
}

function messageOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.trim().split('\n').at(-1)?.slice(0, 200) || '未知错误'
}

type Settings = { metric: Metric; palette: Palette; python: string }

function settingsOf(options: PluginOptions): Settings {
  const python = typeof options.python === 'string' ? options.python.trim() : ''
  return {
    metric: options.metric === 'all' ? 'all' : 'new',
    palette: options.palette === 'green' ? 'green' : 'claude',
    python: python === '' ? 'python3' : python,
  }
}

/** The run in flight, shared by every caller until it settles. */
let running: Promise<void> | undefined

async function aggregateNow($: EngineInterface, settings: Settings): Promise<void> {
  await update($, load, held => ({ ...held, isLoading: true }))
  let error: string | null = null
  try {
    const script = `${$.plugin.root}/scripts/aggregate.py`
    const done = await $.process.run([settings.python, '-I', script], { timeoutMs: SCRIPT_TIMEOUT_MS }).catch(
      (caught: unknown) => {
        throw new Error(`运行不了 ${settings.python}：${messageOf(caught)}（可在 /config 里改 python 选项）`)
      },
    )
    if (done.exitCode !== 0) {
      throw new Error(done.stderr.trim() || `aggregate.py 退出码 ${done.exitCode}`)
    }
    const parsed: unknown = JSON.parse(done.stdout)
    if (!isAggregate(parsed)) throw new Error('aggregate.py 的输出看不懂')
    await update($, aggregate, () => parsed)
    await $.store.set(STORE_KEY, parsed).catch(() => undefined)
  } catch (caught) {
    error = messageOf(caught)
  }
  const refreshedAt = await $.clock.now()
  await update($, load, () => ({ isLoading: false, error, refreshedAt }))
}

/** One run at a time; a call while one runs waits for that one. */
function refresh($: EngineInterface, settings: Settings): Promise<void> {
  running ??= aggregateNow($, settings).finally(() => {
    running = undefined
  })
  return running
}

/** Refreshes outside the calling dispatch, so no hook waits on Python. */
function refreshSoon($: EngineInterface, settings: Settings): void {
  $.clock.after(1, () => void refresh($, settings))
}

async function refreshIfStale($: EngineInterface, settings: Settings): Promise<void> {
  const { refreshedAt, isLoading } = await read($, load)
  if (!isLoading && (await $.clock.now()) - refreshedAt > STALE_MS) refreshSoon($, settings)
}

async function viewOf($: EngineInterface, columns: number, settings: Settings): Promise<View> {
  const held = await read($, aggregate)
  return {
    aggregate: held,
    load: await read($, load),
    today: todayOf(await $.clock.now(), held?.utcOffsetMinutes ?? 0),
    metric: settings.metric,
    palette: settings.palette,
    columns,
  }
}

export const register: Register = (on, options) => {
  const settings = settingsOf(options)

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'heatmap', description: '打开每日 token 用量格子图' })
    if ((await read($, aggregate)) === null) {
      // Last session's numbers, so the band shows at once while Python runs.
      const kept = await $.store.get(STORE_KEY)
      if (isAggregate(kept)) await update($, aggregate, () => kept)
    }
    if ((await $.session.turns()) > 0) await update($, isFirstTurnDone, () => true)
    refreshSoon($, settings)
    $.clock.every(REFRESH_MS, () => void refresh($, settings))

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    // After /clear the conversation is new again: the band comes back.
    if (e.reason === 'clear') await update($, isFirstTurnDone, () => false)

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const ended = await next(e)
    if (e.agentId === undefined) {
      await update($, isFirstTurnDone, () => true)
      await refreshIfStale($, settings)
    }

    return ended
  })

  on('command.run', { command: 'heatmap' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: '用量格子图' })
    await refreshIfStale($, settings)

    return {
      text: opened.isPlaced ? '已打开用量格子图。' : `用量格子图已打开，等有位置时显示（${opened.reason}）。`,
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // Another plugin's band (token-usage) is drawn first and kept on top.
    const below = await next(e)
    if (e.props.hasSurvey || (await read($, isFirstTurnDone))) return below

    const view = await viewOf($, e.props.bodyColumns, settings)
    let own: RenderElement | null
    if (e.surface === 'terminal') {
      own = terminalBand($.ui.resolve(e), view, e.props.maxRows)
    } else {
      own = remoteBand($.ui.resolve(e), view)
    }
    if (own === null) return below
    const { Box } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        {below}
        {own}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const view = await viewOf($, e.props.bodyColumns, settings)
    const press = () => refreshSoon($, settings)
    if (e.surface === 'terminal') return terminalPane($.ui.resolve(e), view, press)

    return remotePane($.ui.resolve(e), view, press)
  })
}

// ---------------------------------------------------------------- shared

/** A one-line state in place of the grid, or null when there is a grid. */
function placeholder(view: View): string | null {
  if (view.aggregate === null) {
    return view.load.error === null ? '用量格子图加载中…' : `用量格子图：读取失败（${view.load.error}）`
  }
  if (!hasUsage(view.aggregate)) return '用量格子图：还没有用量记录'
  return null
}

function updatedLine(view: View): string {
  const parts = [`口径：${metricName(view.metric)}`]
  parts.push(
    view.metric === 'all' ? '输入＋缓存写入＋缓存读取＋输出' : '未缓存输入＋缓存写入＋输出，缓存读取只在悬停提示里',
  )
  const held = view.aggregate
  if (view.load.isLoading) parts.push('更新中…')
  else if (held !== null) {
    const local = new Date(held.generatedAt + held.utcOffsetMinutes * 60_000)
    const time = `${String(local.getUTCHours()).padStart(2, '0')}:${String(local.getUTCMinutes()).padStart(2, '0')}`
    parts.push(`更新于 ${time}`)
  }
  if (view.load.error !== null && held !== null) parts.push(`上次更新失败：${view.load.error}`)
  return parts.join(' · ')
}

function placeholderBox(t: Terminal | Remote, text: string): RenderElement {
  const { Box, Text } = t

  return (
    <Box key="placeholder">
      <Text dimColor>{text}</Text>
    </Box>
  )
}

type Stat = { key: string; label: string; value: string }

function statsList(view: View): Stat[] {
  const stats = statsOf(view.aggregate, view.today, view.metric)
  return [
    { key: 'total', label: `总 token（${view.metric === 'all' ? '全部' : '新'}）`, value: compact(stats.total) },
    { key: 'sessions', label: '会话数', value: grouped(stats.sessions) },
    { key: 'current', label: '当前连续', value: `${stats.currentStreak} 天` },
    { key: 'longest', label: '最长连续', value: `${stats.longestStreak} 天` },
    {
      key: 'busiest',
      label: '最活跃的一天',
      value: stats.busiest ? `${shortDate(stats.busiest.day, view.today)} · ${compact(stats.busiest.value)}` : '—',
    },
  ]
}

// ---------------------------------------------------------------- terminal

function terminalGrid(t: Terminal, view: View): RenderElement {
  const { Box, Raster, Text } = t
  const weeks = weeksThatFit(view.columns, TERMINAL_LABEL_COLUMNS + 1, 2)
  const grid = buildGrid(view.aggregate, view.today, weeks, view.metric)
  const raster = heatmapRaster(grid, view.palette)

  return (
    <Box flexDirection="column">
      <Text dimColor>{monthLine(grid) || ' '}</Text>
      <Box flexDirection="row">
        <Box width={TERMINAL_LABEL_COLUMNS} flexShrink={0}>
          <Text dimColor>{'周一\n \n周三\n \n周五\n \n '}</Text>
        </Box>
        <Raster key="heatmap" columns={raster.columns} rows={raster.rows} cells={raster.cells} />
      </Box>
      <Box flexDirection="row" width={TERMINAL_LABEL_COLUMNS + raster.columns} justifyContent="space-between">
        <Box key="summary" flexShrink={1}>
          <Text dimColor wrap="truncate-end">
            {rangeSummary(grid, view.metric)}
          </Text>
        </Box>
        <Box key="legend" flexShrink={0}>
          <Text>
            <Text dimColor>{' 少 '}</Text>
            <Text color="#808080">{GLYPHS[0]}</Text>
            <Text color={ACCENT_TEXT[view.palette]}>{GLYPHS.slice(1).join('')}</Text>
            <Text dimColor>{' 多'}</Text>
          </Text>
        </Box>
      </Box>
    </Box>
  )
}

function terminalBand(t: Terminal, view: View, maxRows: number): RenderElement | null {
  const { Box, Raster, Text } = t
  const waiting = placeholder(view)
  if (waiting !== null) return placeholderBox(t, waiting)
  if (maxRows >= TERMINAL_GRID_ROWS) return terminalGrid(t, view)
  if (maxRows < 1) return null

  // No room for seven rows: the last days as one strip.
  const count = Math.max(7, Math.min(120, view.columns - 24))
  const strip = stripRaster(view.aggregate, view.today, count, view.metric, view.palette)
  const today = tokensOf(view.aggregate?.days[dayString(view.today)], view.metric)

  return (
    <Box flexDirection="row">
      <Text dimColor>{`近 ${count} 天 `}</Text>
      <Raster key="strip" columns={strip.columns} rows={1} cells={strip.cells} />
      <Text dimColor>{` 今天 ${compact(today)}`}</Text>
    </Box>
  )
}

function terminalPane(t: Terminal, view: View, onRefresh: () => void): RenderElement {
  const { Box, Button, Text } = t
  const waiting = placeholder(view)

  return (
    <Box flexDirection="column" gap={1}>
      {waiting === null ? (
        <Box key="stats" flexDirection="row" flexWrap="wrap" columnGap={3}>
          {statsList(view).map(stat => (
            <Box key={stat.key} flexDirection="column">
              <Text dimColor>{stat.label}</Text>
              <Text bold>{stat.value}</Text>
            </Box>
          ))}
        </Box>
      ) : (
        placeholderBox(t, waiting)
      )}
      {waiting === null && terminalGrid(t, view)}
      <Box flexDirection="row" columnGap={2}>
        <Button key="refresh" label="刷新" onPress={onRefresh} />
        <Text dimColor wrap="wrap">{updatedLine(view)}</Text>
      </Box>
    </Box>
  )
}

// ---------------------------------------------------------------- desktop, mobile, VS Code

function remoteGrid(t: Remote, view: View): RenderElement {
  const { Svg } = t
  const weeks = weeksThatFit(view.columns * DESKTOP_CELL_PX, SVG_LEFT + 1, SVG_PITCH)
  const grid = buildGrid(view.aggregate, view.today, weeks, view.metric)
  const svg = heatmapSvg(grid, view.palette, view.metric)

  return <Svg source={svg.source} alt={svg.alt} isInteractive />
}

function remoteBand(t: Remote, view: View): RenderElement {
  const waiting = placeholder(view)
  if (waiting !== null) return placeholderBox(t, waiting)

  return remoteGrid(t, view)
}

function remotePane(t: Remote, view: View, onRefresh: () => void): RenderElement {
  const { Box, Button, Text } = t
  const waiting = placeholder(view)

  return (
    <Box flexDirection="column" gap={1}>
      {waiting === null ? (
        <Box key="stats" flexDirection="row" flexWrap="wrap" columnGap={3} rowGap={1}>
          {statsList(view).map(stat => (
            <Box key={stat.key} flexDirection="column">
              <Text size="caption" dimColor>
                {stat.label}
              </Text>
              <Text weight="semibold">{stat.value}</Text>
            </Box>
          ))}
        </Box>
      ) : (
        placeholderBox(t, waiting)
      )}
      {waiting === null && remoteGrid(t, view)}
      <Box flexDirection="row" columnGap={2} alignItems="center">
        <Button key="refresh" label="刷新" onPress={onRefresh} />
        <Text size="caption" dimColor>
          {updatedLine(view)}
        </Text>
      </Box>
    </Box>
  )
}
