import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, RenderElement, Register } from 'claude-code'

import type { GlassAgent, GlassCall, GlassPrompt, GlassTurn } from '../types'
import { cleanHint, renderHint, clockCells, isEditTool, toolText, setCwd, renderAgentLaunch, renderBand, renderBashResult, renderDiff, renderEventRow, renderGroupRow, renderMessageRow, renderNoOutput, renderSkillLoad, renderToolError, renderToolOutput, renderTreeRow, renderUserRow } from './chrome'
import type { ChangedFile, Hunk } from './chrome'
import { G } from './glyphs'
import { parseMarkdown } from './markdown'
import type { Block } from './markdown'
import { paletteNamed } from './palette'
import type { Palette } from './palette'
import { writeIntent } from './prose'
import { renderReply } from './render'

// The turns this session, newest last. A user row finds its own turn in
// here: a `read` while a render hook runs subscribes that row, so every
// `update` draws every user row again, and each must still find its data.
const turns = atom({ plugin: 'glass', key: 'turns' } as const, [] as GlassTurn[])
// the prompts the person submitted, newest last: a user row finds its turn
// by text, and the assistant header appears once the turn starts
const prompts = atom({ plugin: 'glass', key: 'prompts' } as const, [] as GlassPrompt[])
// every main-loop call by turn: the dots line, the tree's times, and which
// rows a folded turn hides
const calls = atom({ plugin: 'glass', key: 'calls' } as const, {} as Record<string, GlassCall[]>)
// subagents still running, for the band above the prompt
const agents = atom({ plugin: 'glass', key: 'agents' } as const, [] as GlassAgent[])
const band = atom({ plugin: 'glass', key: 'band' } as const, 'open' as 'open' | 'closed')

const HISTORY = 48
// finished replies whose parse is kept for their redraws
const PARSED_MAX = 64
const ANSWER_MAX = 20000

const ESC = String.fromCodePoint(0x1b)
// the engine shows this many output lines before folding the rest behind ctrl+o
const MAX_PAINTED_LINES = 3
// tools whose row never carries a body: a run of them packs without air rows
const COMPACT = new Set(['Read'])

// Live things, ticked once a second: main-loop calls still running (their
// row's clock is a Raster the ticker blits, no redraw) and subagents still
// running (the status line under the prompt). Module state, read by no
// render hook, so a tick redraws nothing in the transcript (2026-10-04).
const liveCalls = new Map<string, { tool: string; t0: number }>()
let ticker: { cancel: () => void } | null = null

async function tick($: EngineInterface, p: Palette): Promise<void> {
  const now = await $.clock.now()
  for (const [id, c] of liveCalls) {
    void $.ui.blit({ requestId: id, key: 'clock', cells: clockCells(now - c.t0, p.meta) }).catch(() => undefined)
  }
  // nothing runs: the ticker stops (no status line: the owner found it noise
  // under the prompt, 2026-10-04)
  if (liveCalls.size === 0) {
    ticker?.cancel()
    ticker = null
  }
}

// A Bash call's body as glass draws it, or null where the engine's stays.
// Drawn under the ToolUse row from its own `output` (2026-10-04): calls run
// in parallel drew their row with no ToolResult under it, so the body went
// missing; the ToolResult row then draws nothing where this is non-null.
function bashBody(t: Elements['terminal'], p: Palette, output: unknown, isErrored: boolean, cols: number): RenderElement | null {
  if (isErrored) {
    if (typeof output !== 'string' || output.trim() === '') return null
    return renderToolOutput(t, p, output.replace(/\s+$/, '').split('\n'), { columns: cols, maxLines: MAX_PAINTED_LINES })
  }
  const out = output as { stdout?: unknown; stderr?: unknown; interrupted?: unknown; bashEditDiff?: unknown } | undefined
  if (!out || typeof out !== 'object' || typeof out.stdout !== 'string' || out.interrupted === true) return null
  const stderr = typeof out.stderr === 'string' ? out.stderr : ''
  const text = [out.stdout, stderr].filter(s => s.trim() !== '').join('\n').replace(/\s+$/, '')
  const lines = text === '' ? [] : text.split('\n')
  const diff = out.bashEditDiff as { files?: unknown; moreFiles?: unknown } | undefined
  const files = Array.isArray(diff?.files)
    ? (diff!.files as ChangedFile[]).filter(f => f && typeof f.filePath === 'string' && Array.isArray(f.hunks)).map(f => ({ ...f, hunks: f.hunks.filter(h => h && typeof h.oldStart === 'number' && typeof h.newStart === 'number' && Array.isArray(h.lines)) }))
    : []
  if (files.length > 0) {
    const moreFiles = typeof diff?.moreFiles === 'number' ? diff.moreFiles : 0
    return renderBashResult(t, p, lines, files, { maxLines: MAX_PAINTED_LINES, moreFiles, columns: cols })
  }
  if (text === '') return renderNoOutput(t, p)
  if (text.includes(ESC)) return null
  return renderToolOutput(t, p, lines, { columns: cols, maxLines: MAX_PAINTED_LINES })
}

// one main-loop call recorded under its turn, replacing an earlier record
// of the same id
async function setCall($: EngineInterface, turnId: string, call: GlassCall) {
  await update($, calls, r => {
    const record = { ...(r ?? {}) }
    const list = record[turnId] ?? []
    const i = list.findIndex(c => c.id === call.id)
    record[turnId] = i < 0 ? [...list, call] : [...list.slice(0, i), call, ...list.slice(i + 1)]
    return record
  })
}

export const register: Register = (on, options) => {
  const opts = (options ?? {}) as { palette?: unknown }
  // the palette follows /config live: every hook reads this binding at
  // draw time, and the config.set hook below swaps it (rows already drawn
  // keep their colors until something redraws them)
  let palette = paletteNamed(opts.palette)
  // gutter marks are off for a turn whose prompt asked for writing: the
  // reply is then the thing itself and asks nothing of the reader
  let marks = true
  // the slash commands this session has, for the band's `/tasks` hint
  let commands = new Set<string>()
  // the names and types of subagents this session spawned: their folded
  // `Message from` rows hide, since the finished row says the same
  const spawned = new Set<string>()
  // Tree rows read these module records, never an atom: a read in a render
  // hook subscribes the row, and every write then redraws every row of the
  // turn, which strands duplicate rows above the viewport (2026-10-03).
  const callTurn = new Map<string, string>()
  const callMs = new Map<string, number>()
  // rows of a group the engine unfolded: no ToolResult of their own, so the
  // ToolUse hook draws an Edit's or a Write's card under the row
  const grouped = new Set<string>()
  // each turn's main-loop calls in order, and whether Claude wrote text
  // since the call before: the air rule below reads both
  const turnOrder = new Map<string, { id: string; tool: string; afterText: boolean }[]>()
  let textSinceCall = false
  // /fold and /expand: module state like the records above, so a render
  // hook reads them without subscribing; a hot reload opens everything again
  let foldedTurns = new Set<string>()
  let expandAllNow = false
  // the module records keep the turns the atoms keep: past HISTORY turns
  // the oldest turn's calls go, so a long session does not grow them forever
  const forgetOldTurns = () => {
    for (const [old, list] of turnOrder) {
      if (turnOrder.size <= HISTORY) break
      turnOrder.delete(old)
      foldedTurns.delete(old)
      for (const c of list) {
        callTurn.delete(c.id)
        callMs.delete(c.id)
        grouped.delete(c.id)
      }
    }
  }
  // a finished message redraws on every /fold, resize and palette change:
  // its parse is kept, the newest few by text
  const parsed = new Map<string, Block[]>()
  const parse = (text: string): Block[] => {
    const hit = parsed.get(text)
    if (hit) return hit
    const blocks = parseMarkdown(text)
    parsed.set(text, blocks)
    if (parsed.size > PARSED_MAX) parsed.delete(parsed.keys().next().value!)
    return blocks
  }

  // the live main-loop turn; a hot reload resets it, which only affects the
  // totals of the turn that reloaded
  const live = { turnId: '', startedAt: 0, tools: 0, edits: 0, failed: 0, lastToolId: null as string | null, costStart: null as number | null }

  on('config.set', { key: 'glass.palette' }, async ($, e, next) => {
    const result = await next(e)
    palette = paletteNamed(e.value)
    return result
  })

  on('session.start', async ($, e, next) => {
    // 0.4.2 to 0.4.5 pinned a status line; clear one a reload left behind
    $.ui.status(undefined)
    try {
      setCwd(await $.session.cwd())
    } catch {
      setCwd('')
    }
    try {
      commands = new Set((await $.command.list()).map(c => c.name))
    } catch {
      commands = new Set()
    }
    await $.command.register({ name: 'fold', description: 'glass: fold the tool trees of every finished turn' })
    await $.command.register({ name: 'unfold', description: 'glass: open the tool trees of every turn' })
    await $.command.register({ name: 'expand', description: 'glass: open every folded run of reads and searches' })
    await $.command.register({ name: 'collapse', description: 'glass: fold the runs of reads and searches again' })
    return next(e)
  })
  on('command.run', { command: 'expand' }, async $ => {
    expandAllNow = true
    $.ui.invalidate('ui.render')
    return { text: 'Every folded run is open. /collapse folds them again.' }
  })
  on('command.run', { command: 'collapse' }, async $ => {
    expandAllNow = false
    $.ui.invalidate('ui.render')
    return { text: 'Runs of reads and searches fold again.' }
  })

  // ---- folding on demand -------------------------------------------------
  on('command.run', { command: 'fold' }, async $ => {
    const ids = ((await read($, turns)) ?? []).map(h => h.turnId)
    foldedTurns = new Set(ids.slice(-HISTORY))
    $.ui.invalidate('ui.render')
    return { text: ids.length ? `Folded ${ids.length} turn${ids.length === 1 ? '' : 's'}. /unfold opens them again.` : 'Nothing to fold yet.' }
  })
  on('command.run', { command: 'unfold' }, async $ => {
    foldedTurns = new Set()
    $.ui.invalidate('ui.render')
    return { text: 'Every turn is open.' }
  })

  // ---- reply renderer ----------------------------------------------------
  on('ui.render', { component: 'AssistantMessage' }, ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)
    const text = e.props.text
    if (text.trim() === '') return next(e)
    const t = $.ui.resolve(e)
    // no bullet: the assistant header under the user row carries it
    return renderReply(t, parse(text), palette, {
      first: e.props.isFirstOfReply,
      columns: e.viewport?.columns ?? 80,
      marks,
    })
  })

  // ---- user row, assistant header, dots line -----------------------------
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)
    const t = $.ui.resolve(e)
    const kind = e.props.origin.kind
    // a background task's notification: one tree row, the body under it
    // when the view is expanded (a short one is expanded from the start)
    if (kind === 'task-notification') return renderEventRow(t, palette, e.requestId, e.props.text, e.props.task, e.props.isExpanded)
    // any other row (another agent's message, a scheduled trigger, a
    // bridge): one muted row; ctrl+o keeps the engine's body
    if (kind !== 'composer') {
      if (e.props.isExpanded) return next(e)
      if (spawned.has(e.props.from?.name ?? '')) return t.Box({ display: 'none', children: [] })
      return renderMessageRow(t, palette, e.props.from?.name ?? kind)
    }
    const text = e.props.text
    if (text.trim() === '') return next(e)
    const known = [...((await read($, prompts)) ?? [])].reverse().find(p => p.text === text) ?? null
    const turnId = known?.turnId ?? null
    let turn = null
    if (turnId) {
      const list = ((await read($, calls)) ?? {})[turnId] ?? []
      const done = ((await read($, turns)) ?? []).find(h => h.turnId === turnId) ?? null
      turn = {
        turnId,
        calls: list,
        done,
      }
    }
    return renderUserRow(t, palette, {
      text,
      submittedAt: known?.submittedAt ?? null,
      startedAt: known?.startedAt ?? null,
      turn,
      columns: e.viewport?.columns ?? 80,
    })
  })

  // ---- tool tree ---------------------------------------------------------
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)
    const id = e.props.tool_use_id
    const turnId = callTurn.get(id)
    // a folded turn hides its rows; a row of a turn glass never saw stays
    if (turnId && foldedTurns.has(turnId)) return $.ui.resolve(e).Box({ display: 'none', children: [] })
    const t = $.ui.resolve(e)
    const order = turnId ? turnOrder.get(turnId) : undefined
    const at = order ? order.findIndex(c => c.id === id) : -1
    // Air above every row, except a bare row that continues a run of the
    // same bodiless tool with no prose between (Read, Read, Read). A row
    // after a body, a card, prose or another tool keeps its air (2026-10-04).
    const air = !(order && at > 0 && COMPACT.has(e.props.tool) && order[at - 1]!.tool === e.props.tool && !order[at]!.afterText)
    const started = liveCalls.get(id)
    const clock = e.props.isRunning && started ? clockCells((await $.clock.now()) - started.t0, palette.meta) : undefined
    const row = renderTreeRow(t, palette, e.props, { durationMs: callMs.get(id) ?? null, air, ...(clock ? { clock } : {}) })
    if (grouped.has(id) && (e.props.tool === 'Edit' || e.props.tool === 'Write') && !e.props.isRunning && !e.props.isErrored) {
      const card = editCard(t, palette, e.props.output, e.props.input, e.viewport?.columns ?? 80)
      if (card) return t.Box({ flexDirection: 'column', children: [row, card] })
    }
    if (e.props.tool !== 'Bash' || e.props.isRunning || e.props.output === undefined) return row
    const body = bashBody(t, palette, e.props.output, e.props.isErrored, e.viewport?.columns ?? 80)
    return body ? t.Box({ flexDirection: 'column', children: [row, body] }) : row
  })

  // the engine's folded run of reads and searches: one tree row; /expand
  // opens every group where it is
  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)
    if (e.props.isExpanded) {
      remember(grouped, e.props.calls)
      return next(e)
    }
    const first = e.props.calls.find((c: { tool_use_id?: string }) => typeof c.tool_use_id === 'string')
    const turnId = first?.tool_use_id ? callTurn.get(first.tool_use_id) ?? null : null
    if (turnId && foldedTurns.has(turnId)) return $.ui.resolve(e).Box({ display: 'none', children: [] })
    const id = e.requestId
    // open after /expand, or on its own when a call in it failed: a red
    // mark must never hide behind a count
    const failed = e.props.calls.some((c: { isErrored?: boolean; isInterrupted?: boolean }) => c.isErrored || c.isInterrupted)
    if (expandAllNow || failed) {
      remember(grouped, e.props.calls)
      return next({ ...e, props: { ...e.props, isExpanded: true } })
    }
    const t = $.ui.resolve(e)
    return renderGroupRow(t, palette, e.props.calls, {
      isActive: e.props.isActive,
      key: `expand:${id}`,
    })
  })

  // Bash output body, painted the way claude-hl painted it. The engine
  // strips escape codes from a rewritten result, so the body is drawn as
  // Text, and only when it is short enough that the engine would show it
  // whole: longer output keeps the engine's collapsed body and ctrl+o.
  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)
    const turnId = callTurn.get(e.props.tool_use_id)
    if (turnId && foldedTurns.has(turnId)) return $.ui.resolve(e).Box({ display: 'none', children: [] })
    // a failed call's reason on the trunk; a failed Bash's body is the ToolUse row's
    if (e.props.isErrored && e.props.tool !== 'Bash' && typeof e.props.output === 'string') {
      const reason = e.props.output.replace(/<\/?tool_use_error>/g, '')
      if (reason.trim() !== '') return renderToolError($.ui.resolve(e), palette, reason)
    }
    // an Edit's or a Write's diff, drawn as glass draws it (owner's request, 2026-10-03)
    if ((e.props.tool === 'Edit' || e.props.tool === 'Write') && !e.props.isErrored) {
      return editCard($.ui.resolve(e), palette, e.props.output, (e.props as { input?: unknown }).input, e.viewport?.columns ?? 80) ?? next(e)
    }
    // a backgrounded agent: one trunked line in place of the engine's body
    if (e.props.tool === 'Agent' || e.props.tool === 'Task') {
      const status = (e.props.output as { status?: unknown } | undefined)?.status
      if (status === 'async_launched' || status === 'remote_launched') return renderAgentLaunch($.ui.resolve(e), palette, status === 'remote_launched')
      return next(e)
    }
    // a loaded skill: one trunked line in place of the engine's body, whose
    // corner bracket sat off the trunk (2026-10-09)
    if (e.props.tool === 'Skill' && !e.props.isErrored) return renderSkillLoad($.ui.resolve(e), palette, e.props.output)
    if (e.props.tool !== 'Bash') return next(e)
    // a backgrounded command: the same trunked line, not the engine's corner
    // bracket, which sat off the trunk (2026-10-05)
    if (typeof (e.props.output as { backgroundTaskId?: unknown } | undefined)?.backgroundTaskId === 'string' && !e.props.isErrored) return renderAgentLaunch($.ui.resolve(e), palette, false)
    // the ToolUse row draws the body glass owns; this row draws nothing then
    const body = bashBody($.ui.resolve(e), palette, e.props.output, e.props.isErrored, e.viewport?.columns ?? 80)
    return body ? $.ui.resolve(e).Box({ display: 'none', children: [] }) : next(e)
  })

  // ---- the turn's bookkeeping --------------------------------------------
  on('prompt.submit', async ($, e, next) => {
    marks = !writeIntent(e.text)
    const now = await $.clock.now()
    await update($, prompts, ps => [...(ps ?? []), { text: e.text, submittedAt: now, startedAt: null, turnId: null }].slice(-HISTORY))
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    live.turnId = e.turnId
    live.startedAt = await $.clock.now()
    live.tools = 0
    live.edits = 0
    live.failed = 0
    live.lastToolId = null
    live.costStart = null
    try {
      live.costStart = (await $.session.usage()).cost?.usd ?? null
    } catch {
      live.costStart = null
    }
    const { turnId, startedAt } = live
    // the newest prompt with this text gets its turn, which draws the
    // assistant header and the dots line under the user row
    await update($, prompts, ps => {
      const list = [...(ps ?? [])]
      for (let i = list.length - 1; i >= 0; i--) {
        const p = list[i]!
        if (p.text === e.text && p.turnId === null) {
          list[i] = { ...p, startedAt, turnId }
          break
        }
      }
      return list
    })
    await update($, calls, r => {
      const entries = Object.entries(r ?? {}).filter(([k]) => k !== turnId).slice(-(HISTORY - 1))
      return Object.fromEntries([...entries, [turnId, []]])
    })
    // a new turn always shows its tree
    foldedTurns.delete(turnId)
    forgetOldTurns()
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const main = !e.agentId
    const id = e.tool_use_id ?? ''
    const turnId = live.turnId
    if (main) {
      live.tools += 1
      if (id) live.lastToolId = id
      if (id && turnId) callTurn.set(id, turnId)
      if (id && turnId) turnOrder.set(turnId, [...(turnOrder.get(turnId) ?? []).filter(c => c.id !== id), { id, tool: e.tool, afterText: textSinceCall }])
      textSinceCall = false
      if (id && turnId) await setCall($, turnId, { id, tool: e.tool, status: 'running', ms: null })
      if (id) liveCalls.set(id, { tool: e.tool, t0: await $.clock.now() })
      if (!ticker) ticker = $.clock.every(1000, () => void tick($, palette))
    } else if (e.agentId) {
      const agentId = e.agentId
      const stage = toolText(e.tool)
      const args = e as unknown as Record<string, unknown>
      const file = typeof args.file_path === 'string' ? args.file_path : typeof args.path === 'string' ? args.path : null
      void update($, agents, as => (as ?? []).map(a => (a.agentId === agentId ? { ...a, stage, file: file ?? a.file } : a)))
    }
    if (isEditTool(e.tool)) live.edits += 1
    const t0 = await $.clock.now()
    let r
    try {
      r = await next(e)
    } finally {
      if (main && id) liveCalls.delete(id)
    }
    if (main) {
      const ms = (await $.clock.now()) - t0
      if (r.isError) live.failed += 1
      if (id) callMs.set(id, ms)
      if (id) liveCalls.delete(id)
      if (id && turnId) await setCall($, turnId, { id, tool: e.tool, status: r.isError ? 'failed' : 'ok', ms })
    }
    return r
  })

  // a subagent's model requests: its tokens and effort for the band. The
  // event streams, so the hook is a generator relaying every chunk; the
  // stop chunk carries the usage.
  on('turn.step', async function* ($, e, next) {
    const stream = next(e)
    let usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number } | null = null
    let step = await stream.next()
    while (!step.done) {
      const chunk = step.value
      if (chunk.kind === 'stop') usage = chunk.usage
      if (chunk.kind === 'text' && !e.agentId) textSinceCall = true
      yield chunk
      step = await stream.next()
    }
    if (e.agentId) {
      const agentId = e.agentId
      const effort = e.effort === undefined ? '' : String(e.effort)
      const u = usage
      const used = u ? u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens + u.output_tokens : 0
      void update($, agents, as => (as ?? []).map(a => (a.agentId === agentId ? { ...a, effort: effort || a.effort, tokens: a.tokens + used } : a)))
    }
    return step.value
  })

  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    if (e.subagentType) spawned.add(e.subagentType)
    if (typeof (e as { name?: unknown }).name === 'string') spawned.add((e as { name: string }).name)
    if (r.agentId) {
      const agent: GlassAgent = {
        agentId: r.agentId,
        description: e.description,
        kind: e.subagentType,
        model: r.model,
        effort: '',
        stage: 'thinking' + G.ellipsis,
        file: '',
        tokens: 0,
        startedAt: await $.clock.now(),
      }
      await update($, agents, as => [...(as ?? []).filter(a => a.agentId !== agent.agentId), agent])
    }
    return r
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId) {
      const agentId = e.agentId
      await update($, agents, as => (as ?? []).filter(a => a.agentId !== agentId))
      return next(e)
    }
    const u = e.usage
    let costUsd: number | null = null
    if (live.costStart !== null) {
      try {
        const now = (await $.session.usage()).cost?.usd
        if (typeof now === 'number') costUsd = Math.max(0, now - live.costStart)
      } catch {
        costUsd = null
      }
    }
    const finishedAt = await $.clock.now()
    const turn: GlassTurn = {
      turnId: e.turnId,
      durationMs: e.durationMs,
      tools: live.tools,
      edits: live.edits,
      failed: live.failed,
      inTokens: u ? u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens : 0,
      cacheTokens: u ? u.cache_read_input_tokens : 0,
      outTokens: u ? u.output_tokens : 0,
      costUsd,
      lastToolId: live.lastToolId,
      answer: e.answer.slice(0, ANSWER_MAX),
      startedAt: live.startedAt || finishedAt - e.durationMs,
      finishedAt,
    }
    await update($, turns, h => [...(h ?? []), turn].slice(-HISTORY))
    // a finished turn stays open: the tree is the evidence of what the
    // prompt did (owner's call, 2026-10-03; /fold tucks old turns away)
    return next(e)
  })

  // ---- footer ------------------------------------------------------------
  // The engine's `Baked for 12s` line is dropped by request: the dots line
  // under the user row carries the counts, and the turn's cost and
  // tokens stay in state for anything that wants them later.
  on('ui.render', { component: 'TurnDuration' }, ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)
    return $.ui.resolve(e).Box({ display: 'none', children: [] })
  })

  // ---- the hint line under the prompt: key reminders dropped ---------------
  on('ui.render', { component: 'PromptHint' }, ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)
    const h = cleanHint(e.props.hint)
    return h ? renderHint($.ui.resolve(e), palette, h) : next(e)
  })

  // ---- spinner: the action count while tools run -------------------------
  on('ui.render', { component: 'Spinner' }, ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.mode !== 'tool-use' || live.tools === 0) return next(e)
    const n = live.tools
    return next({ ...e, props: { ...e.props, suffix: `${G.ellipsis} ${G.middot} ${n} ${n === 1 ? 'action' : 'actions'}` } })
  })

  // ---- background band ---------------------------------------------------
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.hasSurvey) return next(e)
    // The band is one site for every plugin: what the plugins beneath draw
    // stays, under the agents' frame, and alone when no agent runs.
    const below = await next(e)
    const list = (await read($, agents)) ?? []
    if (list.length === 0) return below
    const t = $.ui.resolve(e)
    const state = (await read($, band)) ?? 'open'
    const frame = renderBand(t, palette, {
      agents: list,
      now: await $.clock.now(),
      columns: e.props.bodyColumns,
      open: state === 'open',
      onToggle: () => void update($, band, s => (s === 'closed' ? 'open' : 'closed')),
      tasksCommand: commands.has('tasks') ? 'tasks' : commands.has('bashes') ? 'bashes' : null,
    })
    return t.Box({ flexDirection: 'column', children: [frame, below] })
  })
}

/** Keeps the tool_use_ids of an unfolded group's calls. */
function remember(ids: Set<string>, calls: ReadonlyArray<{ tool_use_id?: string }>): void {
  for (const c of calls) if (typeof c.tool_use_id === 'string') ids.add(c.tool_use_id)
}

/**
 * An Edit's or a Write's result as glass's diff card, null when there is
 * nothing to draw. A Write that created the file has no patch: its whole
 * content draws as added lines under `Created`.
 */
function editCard(t: Elements['terminal'], palette: Palette, output: unknown, input: unknown, columns: number): RenderElement | null {
  const out = output as { structuredPatch?: unknown; filePath?: unknown; type?: unknown; content?: unknown } | undefined
  const patch = out?.structuredPatch
  const patched = Array.isArray(patch) ? (patch as Hunk[]).filter(h => h && typeof h.oldStart === 'number' && typeof h.newStart === 'number' && Array.isArray(h.lines)) : []
  const created = patched.length === 0 && out?.type === 'create' && typeof out.content === 'string'
  const hunks = created ? [{ oldStart: 0, newStart: 1, lines: (out.content as string).replace(/\n$/, '').split('\n').map(l => `+${l}`) }] : patched
  if (hunks.length === 0) return null
  const args = input as { file_path?: unknown } | undefined
  const path = typeof out?.filePath === 'string' ? out.filePath : typeof args?.file_path === 'string' ? args.file_path : ''
  return renderDiff(t, palette, hunks, { path, columns, ...(created ? { verb: 'Created' } : {}) })
}
