// `claude plugin test .` — the mod's hooks against the engine, Python faked.
// What aggregate.py itself counts (one response over many lines counted once,
// days in the local zone) is tested in tests/test_aggregate.py; here the
// script's output is handed in as `process.run`'s answer.

import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock, Plugin } from 'claude-code/testing'
import type { On, RenderPropsOf } from 'claude-code'

import type { Aggregate, DayUsage } from '../types'
import {
  buildGrid,
  compact,
  dayNumber,
  dayString,
  heatmapSvg,
  levelsOf,
  statsOf,
  todayOf,
  weekday,
} from '../hooks/heatmap.ts'

const PLUGIN = 'usage-heatmap'
const SURFACES = ['terminal', 'desktop'] as const

/** 2026-10-15 16:30 UTC: already 10-16 in Shanghai, still 10-15 in Los Angeles. */
const NOW = Date.UTC(2026, 9, 15, 16, 30)
const SHANGHAI = 480
const LOS_ANGELES = -420

const BAND: RenderPropsOf['AbovePrompt'] = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 20,
  bodyColumns: 120,
  scroll: { offset: 0, bodyRows: 19 },
  view: {},
}

const PANE_PROPS: RenderPropsOf['Pane'] = {
  title: '用量格子图',
  isFocused: false,
  bodyColumns: 110,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
}

function day(output: number, rest: Partial<DayUsage> = {}): DayUsage {
  return { input: 0, cacheWrite: 0, cacheRead: 0, output, messages: 1, sessions: 1, ...rest }
}

function aggregateOf(days: Record<string, DayUsage>, utcOffsetMinutes = SHANGHAI, sessions = 3): Aggregate {
  return {
    version: 1,
    generatedAt: NOW,
    utcOffsetMinutes,
    days,
    sessions,
    files: 3,
    parsedFiles: 3,
    elapsedMs: 12,
  }
}

type World = {
  /** What aggregate.py prints; a string is printed as is. */
  output?: Aggregate | string
  exitCode?: number
  stderr?: string
  /** Answer only once the clock has moved this far. */
  lateMs?: number
  turns?: number
  stored?: Aggregate
  /** The command does not start: `process.run` rejects with this. */
  cannotStart?: string
}

type Started = { clock: MockClock; runs: string[][] }

/** The world beneath the plugin; registered before the first call on `$`. */
function world(on: On, given: World): Started {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, given.stored === undefined ? {} : { aggregate: given.stored })
  const runs: string[][] = []
  on('process.run', async (_$, e) => {
    runs.push([...e.argv])
    if (given.cannotStart !== undefined) throw new Error(given.cannotStart)
    if (given.lateMs !== undefined) await clock.sleep(given.lateMs)
    const output = given.output ?? aggregateOf({})
    return {
      value: {
        exitCode: given.exitCode ?? 0,
        stdout: typeof output === 'string' ? output : JSON.stringify(output),
        stderr: given.stderr ?? '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  on('session.turns', () => ({ value: given.turns ?? 0 }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'engine', ref: 0 }))
  return { clock, runs }
}

async function start($: Engine, started: Started): Promise<void> {
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  // The first refresh is a timer 1 ms out, off the session.start dispatch.
  await started.clock.advance(1)
}

type Drawing = { surface: string; find: (q: { type?: string; key?: string }) => Promise<{ props: Record<string, unknown>; text: string; type: string } | undefined> }

/** The heatmap element: a Raster on the terminal, an Svg elsewhere. */
function gridOf(ui: Drawing) {
  return ui.find({ type: ui.surface === 'terminal' ? 'Raster' : 'Svg' })
}

function band($: Engine, surface: (typeof SURFACES)[number], props: Partial<RenderPropsOf['AbovePrompt']> = {}) {
  return $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: { ...BAND, ...props } })
}

function pane($: Engine, surface: (typeof SURFACES)[number]) {
  return $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: 'usage-heatmap', props: PANE_PROPS })
}

/** Every `<title>` of a desktop drawing's SVG. */
async function titlesOf(ui: Drawing) {
  const svg = await ui.find({ type: 'Svg' })
  const source = String(svg?.props.source ?? '')
  return [...source.matchAll(/<title>([^<]*)<\/title>/g)].map(match => match[1]!)
}

/** The Raster's cells back as glyphs, one string per row. */
function glyphRows(cells: string, columns: number, rows: number): string[] {
  const binary = atob(cells)
  const view = new DataView(new Uint8Array([...binary].map(ch => ch.charCodeAt(0))).buffer)
  const lines: string[] = []
  for (let row = 0; row < rows; row++) {
    let line = ''
    for (let column = 0; column < columns; column++) {
      line += String.fromCodePoint(view.getUint32((row * columns + column) * 12, true))
    }
    lines.push(line)
  }
  return lines
}

// Stand-ins for the person's token-usage mod, which draws in the band too:
// one beneath this mod that draws alone, one above that keeps what is beneath.
const TOKEN_USAGE_BENEATH: Plugin = {
  name: 'token-usage-beneath',
  tier: 'append',
  register(on) {
    on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
      const { Text } = $.ui.resolve(e)
      return <Text key="token-usage">5 小时额度 12% · 7 天额度 30%</Text>
    })
  },
}

const TOKEN_USAGE_ABOVE: Plugin = {
  name: 'token-usage-above',
  tier: 'prepend',
  register(on) {
    on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
      const below = await next(e)
      const { Box, Text } = $.ui.resolve(e)
      return (
        <Box flexDirection="column">
          <Text key="token-usage">5 小时额度 12% · 7 天额度 30%</Text>
          {below}
        </Box>
      )
    })
  },
}

// ---------------------------------------------------------------- the arithmetic

describe('days and levels', () => {
  test('today follows the offset aggregate.py reported, not this environment', () => {
    expect(dayString(todayOf(NOW, SHANGHAI))).toBe('2026-10-16')
    expect(dayString(todayOf(NOW, 0))).toBe('2026-10-15')
    expect(dayString(todayOf(NOW, LOS_ANGELES))).toBe('2026-10-15')
    expect(dayString(todayOf(Date.UTC(2026, 9, 15, 6, 59), LOS_ANGELES))).toBe('2026-10-14')
  })

  test('weeks run Monday to Sunday', () => {
    expect(weekday(dayNumber('2026-10-12'))).toBe(0)
    expect(weekday(dayNumber('2026-10-15'))).toBe(3)
    expect(weekday(dayNumber('2026-10-18'))).toBe(6)
    expect(dayString(dayNumber('2024-02-29'))).toBe('2024-02-29')
  })

  test('levels split the active days in quarters, not linearly', () => {
    const level = levelsOf([0, 10, 20, 30, 40, 1_000_000_000])
    expect([0, 10, 20, 30, 40, 1_000_000_000].map(level)).toEqual([0, 1, 2, 3, 4, 4])
    expect(levelsOf([0, 0])(0)).toBe(0)
    expect(levelsOf([5])(5)).toBe(4)
  })

  test('the grid ends today and leaves the rest of the week blank', () => {
    const today = dayNumber('2026-10-15')
    const grid = buildGrid(aggregateOf({ '2026-10-15': day(5) }), today, 53, 'new')
    expect(grid.columns).toHaveLength(53)
    const last = grid.columns[52]!
    expect(last.slice(0, 4).map(cell => (cell ? dayString(cell.day) : null))).toEqual([
      '2026-10-12',
      '2026-10-13',
      '2026-10-14',
      '2026-10-15',
    ])
    expect(last.slice(4)).toEqual([null, null, null])
    expect(dayString(grid.columns[0]![0]!.day)).toBe('2025-10-13')
    expect(grid.total).toBe(5)
  })

  test('the metric leaves cache reads out unless asked', () => {
    const usage = { '2026-10-15': day(10, { input: 1, cacheWrite: 100, cacheRead: 1_000_000 }) }
    const today = dayNumber('2026-10-15')
    expect(buildGrid(aggregateOf(usage), today, 4, 'new').total).toBe(111)
    expect(buildGrid(aggregateOf(usage), today, 4, 'all').total).toBe(1_000_111)
  })

  test('stats: streaks, the busiest day, sessions', () => {
    const days = {
      '2026-10-01': day(50),
      '2026-10-02': day(70),
      '2026-10-03': day(10),
      '2026-10-10': day(1),
      '2026-10-13': day(1),
      '2026-10-14': day(1),
    }
    const today = dayNumber('2026-10-15')
    const stats = statsOf(aggregateOf(days, 0, 9), today, 'new')
    expect(stats.longestStreak).toBe(3)
    // Nothing yet today: the streak through yesterday still stands.
    expect(stats.currentStreak).toBe(2)
    expect(stats.busiest).toEqual({ day: dayNumber('2026-10-02'), value: 70 })
    expect(stats.total).toBe(133)
    expect(stats.sessions).toBe(9)
    expect(statsOf(aggregateOf(days), today + 2, 'new').currentStreak).toBe(0)
  })

  test('the SVG is well formed and stays under the 131072-character limit', () => {
    // Every day of a full year busy, with the longest numbers a title holds.
    const days: Record<string, DayUsage> = {}
    const today = dayNumber('2026-10-15')
    for (let d = today - 400; d <= today; d++) {
      const big = 9_999_999_999
      days[dayString(d)] = { input: big, cacheWrite: big, cacheRead: big, output: d % 5 === 0 ? 0 : big - d, messages: 99_999, sessions: 999 }
    }
    days[dayString(today - 3)] = day(0, { messages: 0 })
    const svg = heatmapSvg(buildGrid(aggregateOf(days), today, 53, 'new'), 'claude', 'new')
    expect(svg.source.length).toBeLessThan(131_072)
    expect(svg.source.startsWith('<svg ')).toBe(true)
    expect(svg.source.endsWith('</svg>')).toBe(true)
    for (const [tag] of svg.source.matchAll(/<[a-z][^>]*>/g)) {
      const names = [...tag.matchAll(/\s([\w:-]+)="[^"]*"/g)].map(match => match[1])
      expect(new Set(names).size, tag).toBe(names.length)
    }
    for (const text of svg.source.split(/<[^>]*>/)) {
      expect(text, text).not.toMatch(/[<>]|&(?!#\d+;)/)
    }
    expect(svg.source).toContain('class="c z"')
    expect(svg.source.match(/<title>/g)).toHaveLength(52 * 7 + 4)
  })

  test('numbers in 万 and 亿', () => {
    expect(compact(0)).toBe('0')
    expect(compact(9_876)).toBe('9,876')
    expect(compact(12_345)).toBe('1.2万')
    expect(compact(3_456_789)).toBe('346万')
    expect(compact(123_456_789)).toBe('1.23亿')
    expect(compact(1_000_010)).toBe('100万')
    expect(compact(200_000)).toBe('20万')
    expect(compact(100_000_000)).toBe('1亿')
    expect(compact(12_000_000_000)).toBe('120亿')
  })
})

// ---------------------------------------------------------------- the band

describe('the band above the prompt', () => {
  test('a new conversation shows the grid, on the terminal and the desktop', async ($, on) => {
    const started = world(on, { output: aggregateOf({ '2026-10-16': day(1_234), '2026-10-01': day(10) }) })
    await start($, started)
    expect(started.runs).toHaveLength(1)
    expect(started.runs[0]!.slice(1, 2)).toEqual(['-I'])
    expect(started.runs[0]![2]).toMatch(/scripts\/aggregate\.py$/)

    const terminal = await band($, 'terminal')
    const raster = await gridOf(terminal)
    expect(raster?.type).toBe('Raster')
    expect(raster?.props.columns).toBe(53 * 2 - 1)
    expect(raster?.props.rows).toBe(7)
    expect((await terminal.find({ key: 'summary' }))?.text).toBe('近 53 周 新 token 1,244 · 今天 1,234')
    expect(await terminal.find({ type: 'Text', text: /少/ })).toBeDefined()

    const desktop = await band($, 'desktop')
    const svg = await gridOf(desktop)
    expect(svg?.type).toBe('Svg')
    expect(svg?.props.isInteractive).toBe(true)
    expect(String(svg?.props.source)).toContain('<svg')
    const titles = await titlesOf(desktop)
    expect(titles.some(title => title.startsWith('2026年10月16日 周五\n新 token：1,234'))).toBe(true)
  })

  test('a narrow band holds fewer weeks', async ($, on) => {
    await start($, world(on, { output: aggregateOf({ '2026-10-16': day(1) }) }))
    const terminal = await band($, 'terminal', { bodyColumns: 46 })
    expect((await gridOf(terminal))?.props.columns).toBe(20 * 2 - 1)
  })

  test('a short band draws one strip of days', async ($, on) => {
    await start($, world(on, { output: aggregateOf({ '2026-10-16': day(1) }) }))
    const terminal = await band($, 'terminal', { maxRows: 3, bodyColumns: 80 })
    expect(await terminal.find({ key: 'heatmap' })).toBeUndefined()
    const strip = await terminal.find({ key: 'strip' })
    expect(strip?.props.rows).toBe(1)
    const glyphs = glyphRows(String(strip?.props.cells), Number(strip?.props.columns), 1)[0]!
    expect(glyphs.at(-1)).toBe('█')
  })

  test('stacks under a plugin beneath it', { plugins: [TOKEN_USAGE_BENEATH] }, async ($, on) => {
    await start($, world(on, { output: aggregateOf({ '2026-10-16': day(5) }) }))
    for (const surface of SURFACES) {
      const ui = await band($, surface)
      const drawn = JSON.stringify(await ui.drawn())
      expect(drawn).toContain('5 小时额度')
      expect(await gridOf(ui)).toBeDefined()
      expect(drawn.indexOf('5 小时额度')).toBeLessThan(drawn.indexOf('"Raster"') + drawn.indexOf('"Svg"') + 1)
    }
  })

  test('stacks under a plugin above it that keeps what is beneath', { plugins: [TOKEN_USAGE_ABOVE] }, async ($, on) => {
    await start($, world(on, { output: aggregateOf({ '2026-10-16': day(5) }) }))
    for (const surface of SURFACES) {
      const ui = await band($, surface)
      expect(JSON.stringify(await ui.drawn())).toContain('5 小时额度')
      expect(await gridOf(ui)).toBeDefined()
    }
  })

  test('gone once the first turn ends, back after /clear', async ($, on) => {
    await start($, world(on, { output: aggregateOf({ '2026-10-16': day(5) }) }))
    const ui = await band($, 'terminal')
    expect(await gridOf(ui)).toBeDefined()

    await $.turn.complete({ answer: 'hi', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' })
    expect(await gridOf(ui)).toBeUndefined()

    await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } } as never)
    expect(await gridOf(ui)).toBeDefined()
  })

  test('a subagent finishing does not count as the first turn', async ($, on) => {
    await start($, world(on, { output: aggregateOf({ '2026-10-16': day(5) }) }))
    const ui = await band($, 'terminal')
    await $.turn.complete({ answer: '', durationMs: 5, isAborted: false, turnId: 't2', reason: 'answer', agentId: 'a1' })
    expect(await gridOf(ui)).toBeDefined()
  })

  test('a resumed conversation does not show it', async ($, on) => {
    await start($, world(on, { output: aggregateOf({ '2026-10-16': day(5) }), turns: 4 }))
    expect(await gridOf(await band($, 'terminal'))).toBeUndefined()
  })

  test('yields to a survey', async ($, on) => {
    await start($, world(on, { output: aggregateOf({ '2026-10-16': day(5) }) }))
    expect(await gridOf(await band($, 'desktop', { hasSurvey: true }))).toBeUndefined()
  })

  test('loading, then the grid', async ($, on) => {
    const started = world(on, { output: aggregateOf({ '2026-10-16': day(5) }), lateMs: 5_000 })
    await start($, started)
    for (const surface of SURFACES) {
      const ui = await band($, surface)
      expect((await ui.find({ key: 'placeholder' }))?.text).toBe('用量格子图加载中…')
    }
    await started.clock.advance(5_000)
    for (const surface of SURFACES) {
      expect(await gridOf(await band($, surface))).toBeDefined()
    }
  })

  test('last session’s numbers show while Python runs', async ($, on) => {
    const stored = aggregateOf({ '2026-10-16': day(77) })
    await start($, world(on, { stored, output: aggregateOf({ '2026-10-16': day(88) }), lateMs: 5_000 }))
    const ui = await band($, 'terminal')
    expect((await ui.find({ key: 'summary' }))?.text).toContain('今天 77')
  })

  test('no usage at all: an empty state', async ($, on) => {
    await start($, world(on, { output: aggregateOf({}) }))
    for (const surface of SURFACES) {
      const ui = await band($, surface)
      expect(await gridOf(ui)).toBeUndefined()
      expect((await ui.find({ key: 'placeholder' }))?.text).toBe('用量格子图：还没有用量记录')
    }
  })

  test('Python failing is said, not thrown', async ($, on) => {
    await start($, world(on, { exitCode: 1, stderr: 'Traceback …\nPermissionError: projects' }))
    for (const surface of SURFACES) {
      const ui = await band($, surface)
      expect((await ui.find({ key: 'placeholder' }))?.text).toBe('用量格子图：读取失败（PermissionError: projects）')
    }
  })

  test('a missing interpreter is named', async ($, on) => {
    const started = world(on, { cannotStart: 'ENOENT: python3' })
    await start($, started)
    const ui = await band($, 'terminal')
    expect((await ui.find({ key: 'placeholder' }))?.text).toContain('运行不了 python3')
  })

  test('output it cannot read is said too', async ($, on) => {
    await start($, world(on, { output: '{"version": 2}' }))
    const ui = await band($, 'terminal')
    expect((await ui.find({ key: 'placeholder' }))?.text).toContain('读取失败')
  })
})

// ---------------------------------------------------------------- days across zones

describe('days across time zones', () => {
  test('the same moment is a different today east and west', async ($, on) => {
    // aggregate.py put the 10-16 usage in Shanghai's day; at 16:30 UTC that
    // is today there, while in Los Angeles today is still 10-15.
    const usage = { '2026-10-15': day(300), '2026-10-16': day(40) }
    await start($, world(on, { output: aggregateOf(usage, SHANGHAI) }))
    const terminal = await band($, 'terminal')
    expect((await terminal.find({ key: 'summary' }))?.text).toContain('今天 40')
    const raster = await gridOf(terminal)
    const rows = glyphRows(String(raster?.props.cells), Number(raster?.props.columns), 7)
    // Friday's row ends with today's cell; Saturday's ends blank.
    expect(rows[3]!.at(-1)).not.toBe(' ')
    expect(rows[4]!.at(-1)).not.toBe(' ')
    expect(rows[5]!.at(-1)).toBe(' ')
    const titles = await titlesOf(await band($, 'desktop'))
    expect(titles.at(-1)).toMatch(/^2026年10月16日 周五\n新 token：40/)
  })

  test('west of Greenwich the day has not turned yet', async ($, on) => {
    const usage = { '2026-10-15': day(300) }
    await start($, world(on, { output: aggregateOf(usage, LOS_ANGELES) }))
    const terminal = await band($, 'terminal')
    expect((await terminal.find({ key: 'summary' }))?.text).toContain('今天 300')
    const raster = await gridOf(terminal)
    const rows = glyphRows(String(raster?.props.cells), Number(raster?.props.columns), 7)
    expect(rows[3]!.at(-1)).toBe('█')
    expect(rows[4]!.at(-1)).toBe(' ')
    const titles = await titlesOf(await band($, 'desktop'))
    expect(titles.at(-1)).toMatch(/^2026年10月15日 周四/)
  })
})

// ---------------------------------------------------------------- the pane and /heatmap

describe('the pane', () => {
  test('/heatmap opens it, with the summary', async ($, on) => {
    const days = {
      '2026-10-14': day(100, { cacheRead: 9_000_000 }),
      '2026-10-15': day(250_000),
      '2026-10-16': day(10),
      '2026-09-01': day(5),
    }
    await start($, world(on, { output: aggregateOf(days, SHANGHAI, 12) }))
    const ran = await $.command.run({
      command: 'heatmap',
      args: '',
      origin: { kind: 'person' },
      presentation: { isFullscreen: true, columns: 160 },
    } as never)
    expect(ran.text).toBe('已打开用量格子图。')

    for (const surface of SURFACES) {
      const ui = await pane($, surface)
      expect((await ui.find({ key: 'total' }))?.text).toContain('25万')
      expect((await ui.find({ key: 'sessions' }))?.text).toContain('12')
      expect((await ui.find({ key: 'current' }))?.text).toContain('3 天')
      expect((await ui.find({ key: 'longest' }))?.text).toContain('3 天')
      expect((await ui.find({ key: 'busiest' }))?.text).toContain('10月15日 · 25万')
      expect(await gridOf(ui)).toBeDefined()
      expect(await ui.find({ key: 'refresh' })).toBeDefined()
    }
  })

  test('the refresh button runs the script again', async ($, on) => {
    const started = world(on, { output: aggregateOf({ '2026-10-16': day(1) }) })
    await start($, started)
    const ui = await pane($, 'terminal')
    await ui.press({ key: 'refresh' })
    await started.clock.advance(1)
    expect(started.runs).toHaveLength(2)
  })

  test('the empty state in the pane', async ($, on) => {
    await start($, world(on, { output: aggregateOf({}) }))
    for (const surface of SURFACES) {
      const ui = await pane($, surface)
      expect((await ui.find({ key: 'placeholder' }))?.text).toBe('用量格子图：还没有用量记录')
      expect(await ui.find({ key: 'refresh' })).toBeDefined()
    }
  })

  test('the all-token metric counts cache reads', { options: { metric: 'all' } }, async ($, on) => {
    await start($, world(on, { output: aggregateOf({ '2026-10-16': day(10, { cacheRead: 1_000_000 }) }) }))
    const ui = await pane($, 'terminal')
    expect((await ui.find({ key: 'total' }))?.text).toContain('100万')
  })

  test('the python option names the interpreter', { options: { python: '/usr/bin/python3' } }, async ($, on) => {
    const started = world(on, {})
    await start($, started)
    expect(started.runs[0]![0]).toBe('/usr/bin/python3')
  })
})
