// glass's state contract: what the chrome draws from.
export type GlassTurn = {
  turnId: string
  durationMs: number
  /** main-loop tool calls this turn */
  tools: number
  /** Edit, Write and NotebookEdit calls, main loop and agents alike */
  edits: number
  /** main-loop calls that ended in an error */
  failed: number
  /** input + cache read + cache creation tokens */
  inTokens: number
  /** cache read tokens alone, for the cached share */
  cacheTokens: number
  outTokens: number
  /** the session ledger's delta over the turn; null where the host keeps none */
  costUsd: number | null
  /** the id of the turn's last main-loop tool call, which draws the elbow */
  lastToolId: string | null
  /** the reply text, for the footer's Copy */
  answer: string
  /** when the turn began and ended, ms since the epoch */
  startedAt: number
  finishedAt: number
  /**
   * tools the API ran inside a request of this turn (the advisor), as
   * turn.step's result listed them (0.5.0); optional, since turns recorded
   * before 0.5.0 are still in state after a reload
   */
  serverTools?: GlassServerTool[]
}

/** one tool call the API ran itself: no tool.call fired, the engine ran nothing */
export type GlassServerTool = {
  id: string
  /** the server tool's name as the API spells it (`advisor`) */
  name: string
  /** $.clock.now() milliseconds when the API began it and when its result arrived */
  startedAt: number
  endedAt?: number
}

/** one main-loop tool call, as the dots line and the tree draw it */
export type GlassCall = {
  id: string
  tool: string
  status: 'running' | 'ok' | 'failed'
  /** wall time once known */
  ms: number | null
}

/** one prompt the person submitted: the user row finds its turn by text */
export type GlassPrompt = {
  text: string
  submittedAt: number
  /** when the turn for it began; null until it does */
  startedAt: number | null
  turnId: string | null
}

/** one subagent still running, for the band above the prompt */
export type GlassAgent = {
  agentId: string
  description: string
  /** the agent type (`Explore`, `general-purpose`) */
  kind: string
  model: string
  effort: string
  /** the last tool it called, or `thinking` */
  stage: string
  /** the path its last file tool touched, or empty */
  file: string
  /** tokens its model requests have used so far */
  tokens: number
  startedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    glass: {
      turns: GlassTurn[]
      prompts: GlassPrompt[]
      /** the main-loop calls of each turn, by turn id, in call order */
      calls: Record<string, GlassCall[]>
      agents: GlassAgent[]
      /** the band above the prompt: the box, or one strip */
      band: 'open' | 'closed'
      /** the main-loop turn now running, null between turns; kept by the host across a reload (0.5.1) */
      liveTurn: string | null
      /** the reply streaming now under the classic renderer, for the live box above the prompt (0.21.0); null otherwise */
      streaming: { id: string; text: string } | null
    }
  }
}
