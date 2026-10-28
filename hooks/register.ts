import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, RenderElement, Register } from 'claude-code'

import type { GlassAgent, GlassCall, GlassPrompt, GlassServerTool, GlassTurn } from '../types'
import { MAX_PAINTED_LINES, cleanHint, renderHint, clockCells, fmtToolTime, isEditTool, toolText, setCwd, renderAgentLaunch, renderBand, renderBashResult, renderDiff, renderEventRow, renderGroupRow, renderMessageRow, renderNoOutput, renderServerToolRows, renderShot, renderSkillLoad, shotCells, renderToolError, renderToolOutput, renderTreeRow, renderUserRow } from './chrome'
import type { ChangedFile, Hunk } from './chrome'
import { G } from './glyphs'
import { parseMarkdown } from './markdown'
import type { Block } from './markdown'
import { PALETTES, paletteNameOf, paletteNamed } from './palette'
import type { Palette, PaletteName } from './palette'
import { themeFileName, themeFor, themeJson, themeSetting } from './theme'
import { writeIntent } from './prose'
import { renderReply } from './render'
import { CONVERTIBLE, hashOf, namedIn, pictureOf, pictureReadOrder, readPath, shotFromPng } from './shot'
import type { Picture, Shot } from './shot'

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
// the main-loop turn now running, or null between turns. State, not module
// memory: a hot reload mid-turn rebuilds the module but the host keeps this,
// so an agent finishing inside that turn is not mistaken for one that
// finished after it (review finding, 0.5.1)
const liveTurn = atom({ plugin: 'glass', key: 'liveTurn' } as const, null as string | null)

const HISTORY = 48
// finished replies whose parse is kept for their redraws
const PARSED_MAX = 64
const ANSWER_MAX = 20000

const ESC = String.fromCodePoint(0x1b)
// the engine shows this many output lines before folding the rest behind ctrl+o
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

// A native notification for what the engine stays silent on (0.5.0): the
// engine's own idle notification covers a finished turn, so glass never
// notifies at turn end. On an engine without `$.ui.notify`, or a channel
// that did not send, the text is a toast instead. Never called from a
// render hook, a timer, or on hearing a notification.
// `$.ui.notify` is typed from 2.1.295 on; the call is spelled at the call
// site (the validator asks for `$.noun.event(...)`), typed through a cast of
// `$`, and an engine without it throws into the toast fallback.
type Notifier = { ui: { notify: (text: string, options?: { title?: string }) => Promise<{ isSent: boolean }> } }
async function notifyPerson($: EngineInterface, text: string): Promise<void> {
  try {
    const r = await ($ as unknown as Notifier).ui.notify(text, { title: 'glass' })
    if (r.isSent) return
  } catch {
    // no notify on this engine, or the channel failed: the toast below
  }
  try {
    $.ui.toast(text)
  } catch {
    // a notification is never worth a failed hook
  }
}

// Puts an agent's transcript in the main view, or the main conversation
// back (0.10.0). `$.ui.view` is typed from 2.1.300 on; the call is spelled
// at the call site through a cast of `$`, as notifyPerson's is (the
// validator refuses `$.ui` bound to a value). A `deny` (the agent is gone,
// the view moved, no view on this surface) and an engine without the method
// both end in a toast: a press is never worth a failed hook.
type Viewer = { ui: { view: (v: { agentId?: string }) => Promise<{ deny?: string } | undefined> } }
async function showView($: EngineInterface, v: { agentId?: string }): Promise<void> {
  let text: string | null = null
  try {
    const r = await ($ as unknown as Viewer).ui.view(v)
    if (r?.deny) text = `glass: ${r.deny}`
  } catch {
    text = 'glass: viewing an agent needs Claude Code 2.1.300 or newer'
  }
  if (text === null) return
  try {
    $.ui.toast(text)
  } catch {
    // a toast is never worth a failed hook
  }
}

// Writes a palette's theme to ~/.claude/themes/glass-<palette>.json and
// selects it (0.5.0). The one file glass writes outside its own folder:
// the directory comes from HOME, the name from the closed palette list, the
// content is serialised from hex-checked values. An existing entry under
// that name that is not a regular file (a link, a directory) is left alone.
// The owner's own theme files are never touched. Returns the line to show.
// The engine prefixes a command's answer with the plugin's name, so the
// lines carry none. The engine's `theme` row takes only its built-in names
// from a plugin (seen 2.1.296: `takes one of: auto, dark, light, ...`), so
// the select step is tried and, when refused, the answer names the one
// settings.json line that selects a custom theme.
async function installTheme($: EngineInterface, name: PaletteName): Promise<string> {
  const home = await $.env.get('HOME')
  if (!home || !home.startsWith('/')) return 'HOME is not set, so no theme was written'
  const dir = `${home}/.claude/themes`
  const file = themeFileName(name)
  const shown = `~/.claude/themes/${file}`
  try {
    const hit = (await $.fs.list(dir)).find(x => x.name === file)
    if (hit && (hit.isLink || hit.kind !== 'file')) return `${shown} is not a regular file; nothing written`
  } catch {
    // no themes directory yet: the write creates it
  }
  try {
    await $.fs.write(`${dir}/${file}`, themeJson(themeFor(PALETTES[name], name)))
  } catch {
    return `could not write ${shown}`
  }
  const setting = themeSetting(name)
  const byHand = `wrote ${shown}. A plugin cannot select a custom theme, so pick glass-${name} in /theme.`
  try {
    const r = await $.config.set({ key: 'theme', value: setting })
    if (r.deny) return byHand
  } catch {
    return byHand
  }
  return `theme glass-${name} on (${shown})`
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

// Screenshots draw outside tmux only (0.6.0): inside it the engine's text
// body stays, unless CLAUDE_CODE_FORCE_TERMINAL_IMAGES vouches that pictures
// reach the terminal. sluice passes the engine's kitty codes through as they
// are, so pictures draw there (live, 2026-10-28).
let inTmux = false
// the `screenshots` option (0.7.0): off, every screenshot row keeps the
// engine's text body, in tmux and out; follows /config live. Off unless
// turned on (0.17.1): a devtools run takes a screenshot a step, and drawn
// they buried the turn's result.
let shotsOn = false
const isOn = (v: unknown) => v === true || v === 'true'

// Pictures Claude looked at (0.8.0): MCP screenshots in any format, and
// image files it read. `home` and the person's recent prompts tell which
// files they fed Claude themselves; those are never drawn back.
let home = ''
// as many prompts as `$.session.messages()` hands back: a picture named
// long ago stays the person's
const PROMPTS_MAX = 4096
// prompt origins no person typed (PromptOrigin)
const MACHINE_ORIGINS = new Set(['task-notification', 'peer', 'peer-send-message', 'projects-relay', 'coordinator', 'observer', 'observer-activity', 'auto-continuation'])
const READ_PATHS_MAX = 8192

// What tells a Read picture the person fed Claude from one Claude found, per
// load: a reload starts empty and reads the conversation again.
type PictureMemory = {
  prompts: string[]
  // each Read's file, by its tool_use_id: the ToolResult row carries no
  // input, so the row learns its path here (tool.call, a ToolUse or
  // ToolGroup row, or the conversation)
  readPaths: Map<string, string>
  history: Promise<boolean> | null
  loaded: boolean
}
const pictureMemory = (): PictureMemory => ({ prompts: [], readPaths: new Map(), history: null, loaded: false })
function notePrompt(m: PictureMemory, text: string) {
  m.prompts.push(text)
  if (m.prompts.length > PROMPTS_MAX) m.prompts.shift()
}
function noteRead(m: PictureMemory, id: unknown, input: unknown) {
  const path = readPath(input)
  if (typeof id !== 'string' || path === '') return
  m.readPaths.set(id, path)
  if (m.readPaths.size > READ_PATHS_MAX) m.readPaths.delete(m.readPaths.keys().next().value!)
}
const isNamed = (m: PictureMemory, path: string) => namedIn(m.prompts, path, home)
// The conversation so far, read before the first Read picture draws: a
// resumed session's prompts and reads, which no prompt.submit or tool.call
// of this load saw. Every user message counts as named, a task
// notification's too: that only keeps a picture back. When the read fails,
// no Read picture draws, and the next draw reads again. A draw waits on the
// read HISTORY_MS at most: past that its picture keeps the engine's row and
// a later draw finds the read done.
const HISTORY_MS = 2000
function loadHistory($: EngineInterface, m: PictureMemory): Promise<boolean> {
  if (m.loaded) return Promise.resolve(true)
  m.history ??= Promise.resolve().then(() => $.session.messages()).then(messages => {
    for (const msg of messages) {
      if (msg.role === 'user' && msg.text !== '') notePrompt(m, msg.text)
      for (const u of msg.toolUses) if (u.tool === 'Read') noteRead(m, u.tool_use_id, u.input)
    }
    m.loaded = true
    return true
  }, () => {
    m.history = null
    return false
  })
  // where the clock cannot sleep (the test kit), the draw waits for the read
  const waited = $.clock.sleep(HISTORY_MS).then(() => false, () => new Promise<never>(() => {}))
  return Promise.race([m.history, waited])
}
// whether a Read's picture may draw: its file is known and the person did
// not name it
async function readDraws($: EngineInterface, m: PictureMemory, path: string | undefined): Promise<boolean> {
  return (await loadHistory($, m)) && path !== undefined && path !== '' && !isNamed(m, path)
}

// A picture's body, or null where the engine's stays.
async function pictureBody($: EngineInterface, t: Elements['terminal'], p: Palette, pic: Picture, columns: number, rows: number): Promise<RenderElement | null> {
  if (!shotsOn || inTmux) return null
  const shot = await shotFor($, pic)
  return shot ? renderShot(t, p, shot, shotCells(shot, columns, rows)) : null
}

// A PNG draws as it is; any other picture, or one over 2 MiB, is converted
// once to a PNG with macOS `sips` and kept for the session's redraws. Where
// that fails (no sips: Linux) the engine's text row stays. The key is the
// bytes Claude read, never the file's path: a file read twice may hold two
// pictures (a screenshot taken again to the same path).
const converted = new Map<string, Promise<Shot | null>>()
const CONVERTED_MAX = 64
// One conversion at a time: two started together after a reload lost one
// `$.process.run` result, and that row waited on it for good (live,
// 2026-10-28). One that has not finished in CONVERT_MS frees the queue and
// leaves the cache, so the next draw tries again; one that failed stays
// failed (no sips: Linux).
let convertQueue: Promise<unknown> = Promise.resolve()
const CONVERT_MS = 8000
const TIMED_OUT: unique symbol = Symbol('timed out')
async function shotFor($: EngineInterface, pic: Picture): Promise<Shot | null> {
  if (pic.mime === 'image/png') {
    const shot = shotFromPng(pic.data)
    if (shot) return shot
  }
  if (!CONVERTIBLE.test(pic.mime)) return null
  const key = hashOf(pic.data)
  let job = converted.get(key)
  if (!job) {
    // the budget starts when the job does, not while it waits its turn;
    // where the clock cannot sleep (the test kit), nothing times out
    const run = convertQueue.then(() => Promise.race([
      convertPicture($, pic.data, key).catch(() => null),
      $.clock.sleep(CONVERT_MS).then((): typeof TIMED_OUT => TIMED_OUT, () => new Promise<never>(() => {})),
    ]))
    convertQueue = run.catch(() => undefined)
    job = run.then(shot => {
      if (shot !== TIMED_OUT) return shot
      converted.delete(key)
      return null
    })
    converted.set(key, job)
    if (converted.size > CONVERTED_MAX) converted.delete(converted.keys().next().value!)
  }
  return job
}

// A private folder for converted pictures, made once per load: per user,
// mode 700, owned by this user and not a link; files a day old go.
let shotDirJob: Promise<string | null> | null = null
function shotDir($: EngineInterface): Promise<string | null> {
  shotDirJob ??= $.process.run(['sh', '-c', [
    'base="${TMPDIR:-/tmp}"; base="${base%/}"; d="$base/glass-pictures-$(id -u)"',
    'mkdir -m 700 -p "$d" 2>/dev/null',
    '[ -d "$d" ] && [ ! -L "$d" ] && [ -O "$d" ] || exit 1',
    'find "$d" -type f -mtime +1 -delete 2>/dev/null; printf "%s" "$d"',
  ].join('\n')]).then(r => (r.exitCode === 0 && r.stdout.startsWith('/') ? r.stdout.trim() : null), () => null)
  return shotDirJob
}

// the most a converted PNG may weigh on disk to draw as bytes
const PNG_BYTES_MAX = 2 * 1024 * 1024
async function convertPicture($: EngineInterface, data: string, name: string): Promise<Shot | null> {
  const dir = await shotDir($)
  if (!dir) return null
  const out = `${dir}/${name}.png`
  // converted before, by this load or an earlier one (a resume, a reload):
  // the name is the bytes' own, so the PNG is the same; read it back
  if (await $.fs.stat(out).then(s => s.kind === 'file' && s.size <= PNG_BYTES_MAX, () => false)) {
    const { base64 } = (await $.fs.read(out, { as: 'bytes' })) as { base64: string }
    const shot = shotFromPng(base64)
    if (shot) return shot
  }
  // Each run writes its own scratch files: a run that timed out keeps going,
  // and its retry, or another session converting the same bytes, must not
  // rewrite the source under its sips (a truncated read draws grey).
  const run = `${dir}/${name}.${Math.random().toString(36).slice(2, 10)}`
  try {
    return await convertRun($, data, `${run}.src`, `${run}.part.png`, out)
  } finally {
    await $.process.run(['rm', '-f', `${run}.src`, `${run}.part.png`]).catch(() => undefined)
  }
}

async function convertRun($: EngineInterface, data: string, input: string, part: string, out: string): Promise<Shot | null> {
  // from the bytes Claude read, never the file on disk, which may have
  // changed since; through stdin, which takes any size (argv stops near 1 MiB)
  const w = await $.process.run(['sh', '-c', 'base64 -D > "$0"', input], { stdin: data })
  if (w.exitCode !== 0) return null
  // the longest side, so every retry shrinks: `-Z` alone would also blow a
  // small picture up
  const g = await $.process.run(['sips', '-g', 'pixelWidth', '-g', 'pixelHeight', input])
  const sides = [...g.stdout.matchAll(/pixel(?:Width|Height): (\d+)/g)].map(m => Number(m[1]))
  if (g.exitCode !== 0 || sides.length !== 2) return null
  const longest = Math.max(...sides)
  // as it is first, then smaller while the PNG weighs over 2 MiB; written
  // under the part name and moved into place once it draws, so a read of
  // `out` (another session's) never sees half a PNG
  for (const scale of [1, 0.75, 0.5, 0.35]) {
    const side = Math.max(1, Math.round(longest * scale))
    const r = await $.process.run(['sips', '-s', 'format', 'png', ...(scale < 1 ? ['-Z', String(side)] : []), input, '--out', part])
    if (r.exitCode !== 0) return null
    // past the limit the bytes cannot draw: shrink without reading them
    const size = await $.fs.stat(part).then(s => s.size, () => Infinity)
    if (size > PNG_BYTES_MAX) continue
    const { base64 } = (await $.fs.read(part, { as: 'bytes' })) as { base64: string }
    const shot = shotFromPng(base64)
    if (!shot) return null
    await $.process.run(['mv', '-f', part, out]).catch(() => undefined)
    return shot
  }
  return null
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
  const opts = (options ?? {}) as { palette?: unknown; notify?: unknown; screenshots?: unknown }
  // the palette follows /config live: every hook reads this binding at
  // draw time, and the config.set hook below swaps it (rows already drawn
  // keep their colors until something redraws them)
  let palette = paletteNamed(opts.palette)
  let paletteName = paletteNameOf(opts.palette)
  // notifications (0.5.0): on unless the option says otherwise; follows /config live
  let notifyOn = opts.notify !== false
  shotsOn = isOn(opts.screenshots)
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
  // each group's one Read whose picture draws (0.8.0)
  const pictureReads = new Set<string>()
  const mem = pictureMemory()
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
        pictureReads.delete(c.id)
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
  const live = {
    turnId: '',
    // true from turn.start to the main loop's turn.complete: an agent that
    // finishes outside that window finished after its turn (0.5.0)
    active: false,
    startedAt: 0,
    tools: 0,
    edits: 0,
    failed: 0,
    lastToolId: null as string | null,
    lastFailedTool: null as string | null,
    costStart: null as number | null,
    // tools the API ran inside this turn's requests (0.5.0)
    serverTools: [] as GlassServerTool[],
  }

  on('config.set', { key: 'glass.palette' }, async ($, e, next) => {
    const result = await next(e)
    palette = paletteNamed(e.value)
    paletteName = paletteNameOf(e.value)
    // a glass theme follows the palette (0.5.0); any other theme is left alone
    try {
      const row = (await $.config.list()).find(r => r.key === 'theme')
      if (typeof row?.value === 'string' && row.value.startsWith('custom:glass-')) $.ui.toast('glass: ' + (await installTheme($, paletteName)))
    } catch {
      // the theme stays as it was
    }
    return result
  })

  on('command.run', { command: 'glass-theme' }, async $ => ({ text: await installTheme($, paletteName) }))

  on('config.set', { key: 'glass.screenshots' }, async ($, e, next) => {
    const result = await next(e)
    shotsOn = isOn(e.value)
    $.ui.invalidate('ui.render')
    return result
  })

  on('config.set', { key: 'glass.notify' }, async ($, e, next) => {
    const result = await next(e)
    notifyOn = e.value !== false
    return result
  })

  on('session.start', async ($, e, next) => {
    // 0.4.2 to 0.4.5 pinned a status line; clear one a reload left behind
    $.ui.status(undefined)
    // forced on, the person vouches that pictures reach the terminal
    const forced = Boolean(await $.env.get('CLAUDE_CODE_FORCE_TERMINAL_IMAGES').catch(() => undefined))
    inTmux = !forced && Boolean(await $.env.get('TMUX').catch(() => undefined))
    home = (await $.env.get('HOME').catch(() => undefined)) ?? ''
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
    await $.command.register({ name: 'glass-theme', description: 'glass: write a theme for the current palette to ~/.claude/themes and select it' })
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
      // a compaction summary (read-only flag, passed on untouched; typed from
      // 2.1.295 on, so read loosely for older type layouts)
      summary: (e.props as { isSummary?: unknown }).isSummary === true,
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
    const answer = turn?.done?.answer ?? ''
    return renderUserRow(t, palette, {
      text,
      submittedAt: known?.submittedAt ?? null,
      startedAt: known?.startedAt ?? null,
      turn,
      columns: e.viewport?.columns ?? 80,
      // 0.5.0 (gated on the live press retest): the chevron folds this one
      // turn, Copy takes the finished answer
      ...(turnId
        ? {
            folded: foldedTurns.has(turnId),
            onFold: () => {
              if (foldedTurns.has(turnId)) foldedTurns.delete(turnId)
              else foldedTurns.add(turnId)
              $.ui.invalidate('ui.render')
            },
            onCopy: answer ? (press: { surface: 'terminal' | 'desktop' | 'vscode' | 'mobile' }) => void $.ui.copy({ text: answer, surface: press.surface }).catch(() => undefined) : null,
          }
        : {}),
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
    // a grouped MCP call's screenshot draws under its row, as the Edit card
    // does; a grouped Read's picture too when it is the group's chosen one,
    // or every one after /expand (0.8.0)
    if (e.props.tool === 'Read') noteRead(mem, id, e.props.input)
    const pictured = e.props.tool.startsWith('mcp__') ||
      (e.props.tool === 'Read' && (expandAllNow || pictureReads.has(id)) && grouped.has(id) && pictureOf(e.props.output) !== null && (await readDraws($, mem, readPath(e.props.input))))
    if (grouped.has(id) && pictured && !e.props.isRunning && !e.props.isErrored) {
      const pic = pictureOf(e.props.output, e.props.tool === 'Read' ? readPath(e.props.input) : undefined)
      const body = pic ? await pictureBody($, t, palette, pic, e.viewport?.columns ?? 80, e.viewport?.rows ?? 40) : null
      if (body) return t.Box({ flexDirection: 'column', children: [row, body] })
    }
    if (e.props.tool !== 'Bash' || e.props.isRunning || e.props.output === undefined) return row
    const body = bashBody(t, palette, e.props.output, e.props.isErrored, e.viewport?.columns ?? 80)
    return body ? t.Box({ flexDirection: 'column', children: [row, body] }) : row
  })

  // the engine's folded run of reads and searches: one tree row; /expand
  // opens every group where it is
  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)
    // the group's one Read picture (0.8.0): drawn under the folded row, or
    // under its own row once the group is open
    for (const c of e.props.calls) if (c.tool === 'Read') noteRead(mem, c.tool_use_id, c.input)
    // a group with no Read picture never waits on the conversation
    const readPictures = shotsOn && !inTmux && e.props.calls.some((c: { tool: string; output?: unknown }) => c.tool === 'Read' && pictureOf(c.output) !== null)
    // the newest Read picture that draws: a JPEG with no sips gives way to
    // an older PNG rather than leave the group with none
    let chosen: string | null = null
    if (readPictures && (await loadHistory($, mem))) {
      for (const id of pictureReadOrder(e.props.calls, path => isNamed(mem, path))) {
        const c = e.props.calls.find((call: { tool_use_id?: string }) => call.tool_use_id === id)
        const pic = c ? pictureOf(c.output, readPath(c.input)) : null
        if (pic && (await shotFor($, pic))) {
          chosen = id
          break
        }
      }
    }
    // one picture per group: a Read chosen while the group was shorter gives
    // way to the one chosen now
    for (const c of e.props.calls) if (c.tool === 'Read' && typeof c.tool_use_id === 'string' && c.tool_use_id !== chosen) pictureReads.delete(c.tool_use_id)
    // a choice made after the chosen Read's own row drew (an open group's
    // rows draw as each call ends): redraw once so that row takes the picture
    const fresh = chosen !== null && !pictureReads.has(chosen)
    if (chosen) pictureReads.add(chosen)
    if (e.props.isExpanded) {
      remember(grouped, e.props.calls)
      if (fresh) $.ui.invalidate('ui.render')
      return next(e)
    }
    const first = e.props.calls.find((c: { tool_use_id?: string }) => typeof c.tool_use_id === 'string')
    const turnId = first?.tool_use_id ? callTurn.get(first.tool_use_id) ?? null : null
    if (turnId && foldedTurns.has(turnId)) return $.ui.resolve(e).Box({ display: 'none', children: [] })
    const id = e.requestId
    // open after /expand, or on its own when a call in it failed: a red
    // mark must never hide behind a count
    const failed = e.props.calls.some((c: { isErrored?: boolean; isInterrupted?: boolean }) => c.isErrored || c.isInterrupted)
    // and when a call returned a screenshot that draws: the picture never
    // hides behind a count (0.6.0); one glass cannot draw keeps the group folded
    let shot = false
    if (shotsOn && !inTmux) {
      for (const c of e.props.calls) {
        if (!c.tool.startsWith('mcp__') || c.isRunning) continue
        const pic = pictureOf(c.output)
        if (pic && (await shotFor($, pic))) {
          shot = true
          break
        }
      }
    }
    if (expandAllNow || failed || shot) {
      remember(grouped, e.props.calls)
      if (fresh) $.ui.invalidate('ui.render')
      return next({ ...e, props: { ...e.props, isExpanded: true } })
    }
    const t = $.ui.resolve(e)
    const groupRow = renderGroupRow(t, palette, e.props.calls, {
      isActive: e.props.isActive,
      key: `expand:${id}`,
    })
    const read = chosen ? e.props.calls.find((c: { tool_use_id?: string }) => c.tool_use_id === chosen) : undefined
    const pic = read ? pictureOf(read.output, readPath(read.input)) : null
    const body = pic ? await pictureBody($, t, palette, pic, e.viewport?.columns ?? 80, e.viewport?.rows ?? 40) : null
    return body ? t.Box({ flexDirection: 'column', children: [groupRow, body] }) : groupRow
  })

  // Bash output body, painted. The engine
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
    // an MCP screenshot or a Read image: the picture Claude read, in place of
    // its text body (0.6.0; a Read and any format, 0.8.0)
    // the row carries no input: its Read's file is the one recorded for its id,
    // and a Read whose file is unknown keeps the engine's row
    // a Read of an image only: a text Read never waits on the conversation
    const isRead = e.props.tool === 'Read' && pictureOf(e.props.output) !== null
    // the conversation read once per draw: its file (a resumed Read's) and
    // whether the person named it
    const loaded = isRead && (await loadHistory($, mem))
    const path = loaded ? mem.readPaths.get(e.props.tool_use_id) : undefined
    const mayDraw = loaded && path !== undefined && !isNamed(mem, path)
    // a grouped call's picture is its ToolUse row's (the transcript view
    // draws both rows): this row hides where that one drew it, else keeps
    // the engine's, and never draws it twice
    if (grouped.has(e.props.tool_use_id) && (isRead || e.props.tool.startsWith('mcp__'))) {
      const owns = !e.props.isErrored && (!isRead || ((expandAllNow || pictureReads.has(e.props.tool_use_id)) && mayDraw))
      const pic = owns ? pictureOf(e.props.output, path) : null
      const drawn = pic !== null && shotsOn && !inTmux && (await shotFor($, pic)) !== null
      return drawn ? $.ui.resolve(e).Box({ display: 'none', children: [] }) : next(e)
    }
    if ((e.props.tool.startsWith('mcp__') || (isRead && mayDraw)) && !e.props.isErrored) {
      const pic = pictureOf(e.props.output, path)
      const body = pic ? await pictureBody($, $.ui.resolve(e), palette, pic, e.viewport?.columns ?? 80, e.viewport?.rows ?? 40) : null
      if (body) return body
    }
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
    // a prompt names its pictures unless a machine wrote it: a task
    // notification or another agent's message does not; an origin the engine
    // cannot attest still counts, which only keeps a picture back
    if (!MACHINE_ORIGINS.has(e.origin?.kind ?? '')) notePrompt(mem, e.text)
    const now = await $.clock.now()
    await update($, prompts, ps => [...(ps ?? []), { text: e.text, submittedAt: now, startedAt: null, turnId: null }].slice(-HISTORY))
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    // 2.1.299: turn.start also fires for subagents' and teammates' turns; the
    // live turn is the main loop's (the typings gain agentId with that engine)
    if ((e as { agentId?: string }).agentId) return next(e)
    live.turnId = e.turnId
    live.active = true
    await update($, liveTurn, () => e.turnId)
    live.startedAt = await $.clock.now()
    live.tools = 0
    live.edits = 0
    live.failed = 0
    live.lastToolId = null
    live.lastFailedTool = null
    live.serverTools = []
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
    if (e.tool === 'Read') noteRead(mem, id, e)
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
      if (r.isError) {
        live.failed += 1
        live.lastFailedTool = e.tool
      }
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
    // tools the API ran inside this request (the advisor): the step's result
    // lists them; the main loop's are drawn after the reply (0.5.0)
    if (!e.agentId) {
      const result = step.value as unknown as { serverToolUses?: ReadonlyArray<{ id: string; name: string; startedAt: number; endedAt?: number }> } | undefined
      for (const s of result?.serverToolUses ?? []) {
        if (typeof s.id !== 'string' || typeof s.name !== 'string' || typeof s.startedAt !== 'number') continue
        if (live.serverTools.some(x => x.id === s.id)) continue
        live.serverTools.push({ id: s.id, name: s.name, startedAt: s.startedAt, ...(typeof s.endedAt === 'number' ? { endedAt: s.endedAt } : {}) })
      }
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
      const done = ((await read($, agents)) ?? []).find(a => a.agentId === agentId)
      await update($, agents, as => (as ?? []).filter(a => a.agentId !== agentId))
      // an agent that finished after its turn ended: the engine says nothing,
      // so glass does (0.5.0); one that finished inside a turn is on screen.
      // The live turn is read from state, which survives a reload (0.5.1).
      const mainLive = ((await read($, liveTurn)) ?? null) !== null
      if (done && !mainLive && notifyOn) {
        const ms = (await $.clock.now()) - done.startedAt
        const label = done.description.length > 60 ? done.description.slice(0, 59) + G.ellipsis : done.description
        await notifyPerson($, ms >= 100 ? `${label} ${G.middot} ${fmtToolTime(ms)}` : label)
      }
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
      ...(live.serverTools.length ? { serverTools: [...live.serverTools] } : {}),
    }
    await update($, turns, h => [...(h ?? []), turn].slice(-HISTORY))
    live.active = false
    await update($, liveTurn, () => null)
    // a turn that ended with failed calls: the engine's idle notification
    // does not say so (0.5.0)
    if (live.failed > 0 && notifyOn) {
      await notifyPerson($, `${live.failed} ${live.failed === 1 ? 'call' : 'calls'} failed${live.lastFailedTool ? ` ${G.middot} ${toolText(live.lastFailedTool)}` : ''}`)
    }
    // a finished turn stays open: the tree is the evidence of what the
    // prompt did (owner's call, 2026-10-03; /fold tucks old turns away)
    return next(e)
  })

  // ---- footer ------------------------------------------------------------
  // The engine's `Baked for 12s` line is dropped by request: the dots line
  // under the user row carries the counts, and the turn's cost and
  // tokens stay in state for anything that wants them later.
  on('ui.render', { component: 'TurnDuration' }, async ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)
    const t = $.ui.resolve(e)
    // the one per-turn row after the reply: it carries the tools the API ran
    // itself, when the turn had any (0.5.0). It finds its turn by duration,
    // as the footer did; this read subscribes one row per turn.
    const list = (await read($, turns)) ?? []
    let mine: GlassTurn | null = null
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i]!.durationMs === e.props.durationMs) {
        mine = list[i]!
        break
      }
    }
    const tools = mine?.serverTools ?? []
    if (tools.length === 0) return t.Box({ display: 'none', children: [] })
    return renderServerToolRows(t, palette, tools)
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
    // 0.10.0: `view` puts the agent's transcript in the main view and `back`
    // returns, through `$.ui.view` (engine 2.1.300) in showView. The site
    // says which agent is in view.
    const frame = renderBand(t, palette, {
      agents: list,
      now: await $.clock.now(),
      columns: e.props.bodyColumns,
      open: state === 'open',
      onToggle: () => void update($, band, s => (s === 'closed' ? 'open' : 'closed')),
      tasksCommand: commands.has('tasks') ? 'tasks' : commands.has('bashes') ? 'bashes' : null,
      viewing: e.props.view?.agentId ?? null,
      onView: (agentId: string) => void showView($, { agentId }),
      onBack: () => void showView($, {}),
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
