/** One local day's totals, as scripts/aggregate.py prints them. */
export type DayUsage = {
  /** Uncached input tokens. */
  input: number
  /** Cache-write (cache creation) input tokens. */
  cacheWrite: number
  /** Cache-read input tokens. */
  cacheRead: number
  output: number
  /** API responses, each counted once however many lines it spans. */
  messages: number
  /** Sessions with at least one response that day. */
  sessions: number
}

/** What scripts/aggregate.py prints: every day with usage, keyed YYYY-MM-DD. */
export type Aggregate = {
  version: number
  /** When the script ran, ms since the epoch. */
  generatedAt: number
  /** The local zone's offset from UTC when the script ran, in minutes. */
  utcOffsetMinutes: number
  days: Record<string, DayUsage>
  /** Distinct sessions, all time. */
  sessions: number
  files: number
  parsedFiles: number
  elapsedMs: number
}

export type LoadState = {
  isLoading: boolean
  /** Why the last refresh failed, or null. */
  error: string | null
  /** When the last refresh finished, ms since the epoch; 0 before the first. */
  refreshedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'usage-heatmap': {
      aggregate: Aggregate | null
      load: LoadState
      /** True once this conversation's first turn has ended: the band goes. */
      isFirstTurnDone: boolean
    }
  }
}
