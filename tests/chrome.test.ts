import { expect, mock, test } from 'claude-code/testing'
import type { Elements, RenderElement, RenderNode } from 'claude-code'

import { CLOCK_CELLS, callScope, clockCells, renderAgentLaunch, fmtCost, fmtToolTime, renderBand, renderBashResult, renderDiff, renderEventRow, renderGroupRow, renderMessageRow, renderToolOutput, renderTreeRow, renderUserRow, safeText } from '../hooks/chrome'
import { G } from '../hooks/glyphs'
import { highlight, langOf } from '../hooks/highlight'
import { parseMarkdown } from '../hooks/markdown'
import { quoteRows, renderReply } from '../hooks/render'
import type { CodeSpan } from '../hooks/highlight'
import { PALETTES } from '../hooks/palette'
import { cellWidth } from '../hooks/width'

const p = PALETTES.tidepool
const cp = (n: number) => String.fromCodePoint(n)

// a plain-data table: the renderers only build trees, so a test can walk
// them without a surface
const el = (type: string) => (props: Record<string, unknown>) => ({ type, props }) as unknown as RenderElement
const t = { Box: el('Box'), Text: el('Text'), Button: el('Button'), Link: el('Link'), Code: el('Code'), Markdown: el('Markdown') } as unknown as Elements['terminal']

// every string in a tree, in drawing order; a Button contributes its label
function strings(node: RenderNode): string[] {
  if (typeof node === 'string') return [node]
  const props = ((node as { props?: unknown }).props ?? {}) as { children?: RenderNode[]; label?: string }
  if (node.type === 'Button') return [props.label ?? '']
  return (props.children ?? []).flatMap(strings)
}
const flat = (node: RenderNode) => strings(node).join('')
// the rows of a column box, each flattened
const lines = (node: RenderElement) => (((node as { props?: { children?: RenderNode[] } }).props?.children ?? []) as RenderNode[]).map(flat)

test('the new glyphs are one cell each', async () => {
  for (const g of [G.tee, G.elbow, G.pipe, G.tick, G.cross, G.hollow, G.fisheye, G.diamond, G.dotted, G.square, G.right, G.down, G.arcTL, G.arcTR, G.arcBL, G.arcBR, G.disc, G.smile, G.copy, G.eye, G.loop, G.fork, G.times, G.middot, G.ellipsis, G.connector]) {
    expect(cellWidth(g)).toBe(1)
  }
})

test('formats: tool times in tenths under ten seconds, costs by Empryo rule, text bounded', async () => {
  expect(fmtToolTime(800)).toBe('0.8s')
  expect(fmtToolTime(9000)).toBe('9.0s')
  expect(fmtToolTime(10_000)).toBe('10s')
  expect(fmtToolTime(64_000)).toBe('1m 04s')
  expect(fmtCost(0.0042)).toBe('$0.004')
  expect(fmtCost(0.58)).toBe('$0.58')
  expect(safeText('a\x1b[31mb\r\nc')).toBe('a[31mb\nc')
  expect(safeText('x'.repeat(20), 10).length).toBe(10)
})

const turn = {
  turnId: 'x', durationMs: 146_000, tools: 17, edits: 3, failed: 2, inTokens: 1_800_000, cacheTokens: 1_620_000, outTokens: 5300,
  costUsd: 0.58, lastToolId: 't9', answer: 'done', startedAt: 0, finishedAt: 146_000,
}

test('a user row: its time, then the assistant header and the dots line once the turn runs', async () => {
  const before = flat(renderUserRow(t, p, { text: 'hello', submittedAt: null, startedAt: null, turn: null, columns: 80 }))
  // one titled rule: the name, then the rule out to the measure
  expect(before.startsWith(G.diamond + ' You ' + G.rule)).toBe(true)
  expect(cellWidth(before.split('hello')[0]!)).toBe(78)
  expect(before).toContain('hello')
  expect(before).not.toContain('Claude')
  const calls = [
    { id: 'a', tool: 'Bash', status: 'ok' as const, ms: 800 },
    { id: 'b', tool: 'Bash', status: 'failed' as const, ms: 50 },
    { id: 'c', tool: 'Read', status: 'running' as const, ms: null },
  ]
  // live: the counts by tool, no chevron, no Copy
  const liveRow = flat(renderUserRow(t, p, { text: 'hello', submittedAt: 0, startedAt: 60_000, turn: { turnId: 'x', calls, done: null, onCopy: null }, columns: 80 }))
  expect(liveRow).toContain(G.fisheye + ' Claude')
  expect(liveRow).toContain(G.disc + G.cross + ' ' + G.hollow)
  expect(liveRow).toContain('1 failed')
  expect(liveRow).toContain('Bash ' + G.times + '2')
  expect(liveRow).not.toContain(G.down)
  expect(liveRow).not.toContain(G.right)
  expect(liveRow).not.toContain('Copy')
  // done: the totals and Copy
  const unfolded = flat(renderUserRow(t, p, { text: 'hello', submittedAt: 0, startedAt: 60_000, turn: { turnId: 'x', calls, done: turn, onCopy: () => {} }, columns: 80 }))
  expect(unfolded).not.toContain('Copy')
  expect(unfolded).toContain('17 actions')
  expect(unfolded).toContain('3 edits')
  expect(unfolded).toContain('2 failed')
})

test('a tree row: hollow mark while live, tick and line count once done, elbow on the last', async () => {
  const base = { tool_use_id: 't1', tool: 'Bash', input: { command: 'git status' }, isErrored: false, isInterrupted: false }
  const live = flat(renderTreeRow(t, p, { ...base, isRunning: true }, { last: false, durationMs: null }))
  expect(live.startsWith(G.pipe + G.tee + G.rule + ' ' + G.hollow + ' Bash')).toBe(true)
  expect(live).toContain('git status')
  expect(live).not.toContain('lines')
  const done = flat(renderTreeRow(t, p, { ...base, isRunning: false, output: { stdout: 'a\nb\nc\n', stderr: '' } }, { last: true, durationMs: 800 }))
  expect(done.startsWith(G.pipe + G.elbow + G.rule + ' ' + G.tick + ' Bash')).toBe(true)
  expect(done).toContain('3 lines')
  expect(done.endsWith('0.8s')).toBe(true)
  const failed = flat(renderTreeRow(t, p, { ...base, isRunning: false, isErrored: true }, { last: false, durationMs: 50 }))
  expect(failed).toContain(G.cross + ' Bash')
})

test('a folded group counts edits and failures and names ctrl+o', async () => {
  const calls = [
    { tool: 'Read', isRunning: false, isErrored: false, isInterrupted: false },
    { tool: 'Edit', isRunning: false, isErrored: true, isInterrupted: false },
    { tool: 'Grep', isRunning: false, isErrored: false, isInterrupted: false },
  ]
  const folded = flat(renderGroupRow(t, p, calls, { isActive: false, key: 'expand:g1', onExpand: () => {} }))
  expect(folded).toContain('Read' + ' ' + G.middot + ' Edit ' + G.middot + ' Grep')
  expect(folded).toContain('[1 edit]')
  expect(folded).toContain('1 failed')
  expect(folded).not.toContain('ctrl+o to expand')
  expect(folded).not.toContain('Click')
  const active = flat(renderGroupRow(t, p, [...calls, { tool: 'Read', isRunning: true, isErrored: false, isInterrupted: false }], { isActive: true, key: null, onExpand: null }))
  expect(active).toContain('1 running' + G.ellipsis)
  expect(active).not.toContain('Click')
})

test('the band: a frame the band wide with five agents and a fold, or one strip when closed', async () => {
  const agents = Array.from({ length: 7 }, (_, i) => ({
    agentId: `a${i}`, description: `Hunt ${i}`, kind: 'Explore', model: 'claude-opus-5-5', effort: 'high', stage: i % 2 ? 'Read' : 'thinking' + G.ellipsis, file: i % 2 ? 'hooks/render.ts' : '', tokens: 1500 * i, startedAt: 1000 * i,
  }))
  const box = renderBand(t, p, { agents, now: 60_000, columns: 100, open: true, onToggle: () => {}, tasksCommand: 'tasks' })
  const rows = lines(box)
  // top edge, five agents, the fold, bottom edge
  expect(rows.length).toBe(8)
  for (const row of rows) expect(cellWidth(row)).toBe(96)
  expect(rows[0]).toContain('background')
  expect(rows[0]).toContain('7')
  expect(rows[0]).toContain('1m 00s')
  expect(rows[0]!.startsWith(G.arcTL)).toBe(true)
  expect(rows[0]!.endsWith(G.arcTR)).toBe(true)
  expect(rows[1]).toContain('Hunt 2')
  expect(rows[1]).toContain('(' + G.disc + G.smile + G.disc + ')')
  expect(rows[2]).toContain('(' + G.disc + G.down + G.disc + ')')
  expect(rows[2]).toContain('opus-5-5')
  expect(rows[2]).toContain('hooks/render.ts')
  expect(rows[6]).toContain('+2 more')
  expect(rows[7]).toContain('They outlive this turn')
  expect(rows[7]).toContain('/tasks')
  expect(rows[7]!.endsWith(G.arcBR)).toBe(true)
  const strip = flat(renderBand(t, p, { agents, now: 60_000, columns: 100, open: false, onToggle: () => {}, tasksCommand: null }))
  expect(cellWidth(strip)).toBe(96)
  expect(strip).toContain('background')
  expect(strip).toContain('Hunt 6')
  expect(strip).toContain('1m 00s')
})

test('an event row: a tick and the first line, a cross on a failed task, the duration at the right', async () => {
  const ok = flat(renderEventRow(t, p, 'Agent "Hunt widths" finished\nmore detail', { status: 'completed', durationMs: 72_000 }))
  expect(ok.startsWith(G.pipe + G.tee + G.rule + ' ' + G.tick + ' Agent  Hunt widths')).toBe(true)
  expect(ok).not.toContain('more detail')
  expect(ok.endsWith('1m 12s')).toBe(true)
  const bad = flat(renderEventRow(t, p, 'Agent died', { status: 'failed' }))
  expect(bad).toContain(G.cross + ' Agent died')
  expect(bad.endsWith('Agent died')).toBe(true)
  // expanded, the body follows the row
  const full = flat(renderEventRow(t, p, 'Agent finished\nthe report', { status: 'completed' }, true))
  expect(full).toContain('the report')
  const msg = flat(renderMessageRow(t, p, 'Explore'))
  expect(msg.startsWith(G.pipe + G.tee + G.rule + ' ' + G.ring + ' Message from @Explore')).toBe(true)
  expect(msg.endsWith('ctrl+o')).toBe(true)
})

test('painted Bash output: the connector, then each line with its words in their colors', async () => {
  const out = renderToolOutput(t, p, ['M hooks/render.ts', '14 passed, 0 failed', 'third', 'fourth'], { columns: 80, maxLines: 3 })
  const text = flat(out)
  expect(text.startsWith(G.pipe + 'M hooks/render.ts')).toBe(true)
  expect(text).toContain(G.pipe + 'third')
  expect(text).not.toContain('fourth')
  expect(text).toContain(G.pipe + G.ellipsis + ' +1 line')
  // under the turn's last row the trunk column is blank
  expect(flat(renderToolOutput(t, p, ['x'], { columns: 80, maxLines: 3, last: true })).startsWith(' x')).toBe(true)
  expect(text).toContain('M hooks/render.ts')
  expect(text).toContain('14 passed, 0 failed')
  // the path and the status words carry their palette colors
  const colors: string[] = []
  const walk = (n: RenderNode) => {
    if (typeof n === 'string') return
    const props = ((n as { props?: unknown }).props ?? {}) as { color?: string; children?: RenderNode[] }
    if (props.color) colors.push(props.color)
    ;(props.children ?? []).forEach(walk)
  }
  walk(out)
  expect(colors).toContain(p.path)
  expect(colors).toContain(p.ok)
  expect(colors).toContain(p.err)
})

// the trees go through the engine's validator: a refused tree would fall
// back to the engine's own drawing in a session
test('mounted: a user row, a tree row, a folded group and the band validate on the terminal', async $ => {
  const user = await $.ui.mount({
    plugin: 'glass',
    surface: 'terminal',
    component: 'UserMessage',
    props: { text: 'spawn the hunters', origin: { kind: 'composer' }, isExpanded: false },
  })
  expect(await user.find({ type: 'Text', text: /You/ })).toBeDefined()
  await user.unmount()

  const row = await $.ui.mount({
    plugin: 'glass',
    surface: 'terminal',
    component: 'ToolUse',
    props: { tool_use_id: 'toolu_1', tool: 'Bash', input: { command: 'ls -la' }, isRunning: false, isErrored: false, isInterrupted: false, output: { stdout: 'a\n', stderr: '' } },
  })
  expect(await row.find({ type: 'Text', text: /^Bash$/ })).toBeDefined()
  expect(await row.find({ type: 'Text', text: /1 line/ })).toBeDefined()
  await row.unmount()

  const group = await $.ui.mount({
    plugin: 'glass',
    surface: 'terminal',
    component: 'ToolGroup',
    props: {
      calls: [
        { tool_use_id: 'toolu_2', tool: 'Read', input: { file_path: 'a.ts' }, isRunning: false, isErrored: false, isInterrupted: false },
        { tool_use_id: 'toolu_3', tool: 'Grep', input: { pattern: 'x' }, isRunning: false, isErrored: false, isInterrupted: false },
      ],
      isActive: false,
      isExpanded: false,
    },
  })
  expect(await group.find({ type: 'Text', text: /a\.ts/ })).toBeDefined()
  await group.unmount()

  // a task's notification and another agent's message: both rows carry a
  // hover, so both need a key or the validator refuses them
  const event = await $.ui.mount({
    plugin: 'glass',
    surface: 'terminal',
    component: 'UserMessage',
    props: { text: 'Agent "Hunt widths" finished', origin: { kind: 'task-notification' }, isExpanded: true, task: { status: 'completed', durationMs: 9000 } },
  })
  expect(await event.find({ type: 'Text', text: /Hunt widths/ })).toBeDefined()
  expect(await event.find({ type: 'Text', text: /9\.0s/ })).toBeDefined()
  await event.unmount()

  const message = await $.ui.mount({
    plugin: 'glass',
    surface: 'terminal',
    component: 'UserMessage',
    props: { text: 'the report body', origin: { kind: 'peer' }, isExpanded: false, from: { name: 'Explore' } },
  })
  expect(await message.find({ type: 'Text', text: /Message from @Explore/ })).toBeDefined()
  await message.unmount()
})

test('an Edit diff: one number column, a plus row in ok on addBg, a minus row in err on delBg, code painted', async () => {
  const hunks = [
    { oldStart: 268, newStart: 274, lines: ['  const right = x', '-  return t.Box({', '+  return spaced(t, p, t.Box({', '   key: 1'] },
    { oldStart: 288, newStart: 294, lines: ['-  })', '+  }))'] },
  ]
  const out = renderDiff(t, p, hunks, { path: 'hooks/chrome.ts', columns: 120 })
  const text = flat(out)
  expect(text).toContain('274    const right = x')
  expect(text).toContain('269 -   return t.Box({')
  expect(text).toContain('275 +   return spaced(t, p, t.Box({')
  expect(text).toContain('276     key: 1')
  expect(text).toContain(G.ellipsis)
  expect(text).toContain('288 -   })')
  expect(text).toContain('294 +   }))')
  const colors: string[] = []
  const bgs: string[] = []
  const walk = (n: RenderNode) => {
    if (typeof n === 'string') return
    const props = ((n as { props?: unknown }).props ?? {}) as { color?: string; backgroundColor?: string; borderStyle?: string; children?: RenderNode[] }
    if (props.color) colors.push(props.color)
    if (props.backgroundColor) bgs.push(props.backgroundColor)
    ;(props.children ?? []).forEach(walk)
  }
  walk(out)
  const card = out as { props: { borderStyle?: string; marginLeft?: number } }
  // glass draws the frame: the file in the top border, two edges on every row
  expect(card.props.borderStyle).toBeUndefined()
  const rows = lines(out)
  expect(rows[0]!.startsWith(G.arcTL + G.rule + ' hooks/chrome.ts +2 -2 ' + G.rule)).toBe(true)
  expect(rows[rows.length - 1]!.startsWith(G.arcBL)).toBe(true)
  const w = cellWidth(rows[0]!)
  for (const r of rows) expect(cellWidth(r)).toBe(w)
  for (const r of rows.slice(1, -1)) expect(r.startsWith(G.pipe) && r.endsWith(G.pipe)).toBe(true)
  // a line wider than the card breaks into rows glass counts, each framed
  const long = lines(renderDiff(t, p, [{ oldStart: 1, newStart: 1, lines: ['+' + 'x'.repeat(150)] }], { path: 'a.ts', columns: 80 }))
  expect(long.length).toBe(2 + 3)
  for (const r of long) expect(cellWidth(r)).toBe(76)
  // the frame sits on the trunk column, so its left border is the trunk
  expect(card.props.marginLeft).toBe(2)
  expect(colors).toContain(p.ok)
  expect(colors).toContain(p.err)
  expect(colors).toContain(p.codeKw)
  expect(bgs).toContain(p.addBg)
  expect(bgs).toContain(p.delBg)
})

test('the highlighter: keywords, calls, types, strings, numbers, comments, a block comment carried across lines', async () => {
  const [a, b, c] = highlight('const n: number = fmt(42) // note\n/* open\nclose */ "s"', 'ts')
  const kinds = (spans: CodeSpan[]) => spans.filter(s => s.kind !== 'plain').map(s => `${s.kind}:${s.text}`)
  expect(kinds(a!)).toEqual(['kw:const', 'type:number', 'fn:fmt', 'num:42', 'comment:// note'])
  expect(kinds(b!)).toEqual(['comment:/* open'])
  expect(kinds(c!)).toEqual(['comment:close */', 'str:"s"'])
  // python comments open on a hash; a dotted member is never a keyword
  expect(kinds(highlight('x.type = 1 # done', 'py')[0]!)).toEqual(['num:1', 'comment:# done'])
  expect(langOf('/a/b/hooks/chrome.test.ts')).toBe('ts')
  expect(langOf('Makefile')).toBe('makefile')
  // prose files are English: a markdown diff paints nothing
  expect(kinds(highlight("The contract for Claude Code's transcript.", 'md')[0]!)).toEqual([])
  expect(highlight('## Global', 'md')[0]).toEqual([{ text: '## Global', kind: 'plain' }])
  expect(highlight('', 'md')[0]).toEqual([])
})

test('a Bash result that rewrote files: the body folded past the painted lines, then a header and a card per file', async () => {
  const files = [
    { filePath: '/x/hooks/a.ts', hunks: [{ oldStart: 1, newStart: 1, lines: [' const a = 1', '-const b = 2', '+const b = 3', '+const c = 4'] }] },
    { filePath: '/x/README.md', hunks: [], created: true as const },
  ]
  const out = renderBashResult(t, p, ['ok', 'two', 'three', 'four', 'five'], files, { maxLines: 3, moreFiles: 2, columns: 120 })
  const text = flat(out)
  expect(text.startsWith(G.pipe + 'ok')).toBe(true)
  expect(text).toContain('three')
  expect(text).not.toContain('four')
  expect(text).toContain(G.ellipsis + ' +2 lines')
  expect(text).not.toContain('Updated')
  expect(text).toContain(G.arcTL + G.rule + ' /x/hooks/a.ts +2 -1 ' + G.rule)
  expect(text).toContain('2 - const b = 2')
  expect(text).toContain('2 + const b = 3')
  expect(text).toContain('Created /x/README.md')
  expect(text).toContain(G.ellipsis + ' +2 more files')
})

test('0.4.1: no air inside a run, no time under a tenth, one row per output line, the agent launch line, a Bash group names its command', async () => {
  const base = { tool_use_id: 't1', tool: 'Read', input: { file_path: 'a.ts' }, isRunning: false, isErrored: false, isInterrupted: false }
  const tight = flat(renderTreeRow(t, p, base, { last: false, durationMs: 40, air: false }))
  expect(tight.startsWith(G.tee)).toBe(true)
  expect(tight).not.toContain('0.0s')
  expect(flat(renderTreeRow(t, p, base, { last: false, durationMs: 300 })).startsWith(G.pipe + G.tee)).toBe(true)
  const body = renderToolOutput(t, p, ['x'.repeat(300), 'b'], { columns: 80, maxLines: 3 })
  expect(lines(body).length).toBe(2)
  expect(flat(renderAgentLaunch(t, p, false))).toContain('running in the background')
  const group = flat(renderGroupRow(t, p, [{ tool: 'Bash', input: { command: 'git status --short' }, isRunning: false, isErrored: false, isInterrupted: false }], { isActive: false, key: null, onExpand: null }))
  expect(group).toContain('git status --short')
})

test('0.4.2: the clock cells decode to the elapsed time, a running row carries the Raster, a dot and its row share a hover scope', async () => {
  const cells = clockCells(64_000, '#8e8ca1')
  const bin = atob(cells)
  const bytes = Uint8Array.from(bin, ch => ch.charCodeAt(0))
  const words = new Uint32Array(bytes.buffer)
  expect(words.length).toBe(CLOCK_CELLS * 3)
  expect(Array.from({ length: CLOCK_CELLS }, (_, i) => String.fromCharCode(words[i * 3]!)).join('')).toBe(' 1m 04s')
  expect(words[1]).toBe(0x8e8ca1)
  expect(words[2]).toBe(0x01000000)
  const tr = { ...t, Raster: el('Raster') } as unknown as Elements['terminal']
  const running = renderTreeRow(tr, p, { tool_use_id: 'toolu_x', tool: 'Bash', input: { command: 'sleep 9' }, isRunning: true, isErrored: false, isInterrupted: false }, { last: false, durationMs: null, clock: cells })
  const found: { type: string; props: Record<string, unknown> }[] = []
  const walk = (n: RenderNode) => {
    if (typeof n === 'string') return
    found.push(n as never)
    ;(((n as { props?: { children?: RenderNode[] } }).props?.children) ?? []).forEach(walk)
  }
  walk(running)
  expect(found.some(n => n.type === 'Raster' && n.props.columns === CLOCK_CELLS && n.props.key === 'clock')).toBe(true)
  expect(found.some(n => n.type === 'Box' && (n.props.hover as { scope?: string } | undefined)?.scope === callScope('toolu_x'))).toBe(true)
  const row = renderUserRow(t, p, { text: 'hi', submittedAt: 0, startedAt: 0, turn: { turnId: 'x', calls: [{ id: 'toolu_x', tool: 'Bash', status: 'running', ms: null }], done: null, onCopy: null }, columns: 80 })
  const dots: { type: string; props: Record<string, unknown> }[] = []
  const walk2 = (n: RenderNode) => {
    if (typeof n === 'string') return
    dots.push(n as never)
    ;(((n as { props?: { children?: RenderNode[] } }).props?.children) ?? []).forEach(walk2)
  }
  walk2(row)
  expect(dots.some(n => n.type === 'Text' && (n.props.hover as { scope?: string } | undefined)?.scope === callScope('toolu_x'))).toBe(true)
})

test('mounted live: a running row with its Raster clock validates, and the ticker blits it', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  // the world beneath glass: note the call's id, hold the call open
  let id = ''
  let release = () => {}
  const held = new Promise<void>(resolve => (release = resolve))
  on('tool.call', async (_$, e) => {
    id = e.tool_use_id
    await held
    return { isError: false, result: { stdout: 'ok', stderr: '', interrupted: false } } as never
  })
  const running = Promise.resolve($.tool.call({ tool: 'Bash', command: 'sleep 2' } as never)).catch((err: unknown) => err)
  for (let i = 0; i < 50 && id === ''; i++) await new Promise(resolve => setTimeout(resolve, 10))
  expect(id).not.toBe('')
  const row = await $.ui.mount({
    plugin: 'glass',
    surface: 'terminal',
    component: 'ToolUse',
    props: { tool_use_id: id, tool: 'Bash', input: { command: 'sleep 2' }, isRunning: true, isErrored: false, isInterrupted: false },
  })
  expect(await row.find({ type: 'Raster' })).toBeDefined()
  expect(await row.find({ type: 'Text', text: /Bash/ })).toBeDefined()
  // three ticks: each blits the mounted clock; the row stays glass's
  await clock.advance(3000)
  expect(await row.find({ type: 'Raster' })).toBeDefined()
  await row.unmount()
  release()
  await running
})

// a ten-row box-drawing flow, the shape Claude draws in a bare fence
const boxDiagram = (() => {
  const h = cp(0x2500), v = cp(0x2502), down = cp(0x25bc)
  const box = (label: string) => [
    cp(0x250c) + h.repeat(10) + cp(0x2510),
    v + label.padEnd(10) + v,
    cp(0x2514) + h.repeat(10) + cp(0x2518),
  ]
  return [...box(' order'), '     ' + down, ...box(' payment'), '     ' + down, ...box(' settle')]
})()

// the tinted card a fence draws, found anywhere in a reply tree
function fenceCard(node: RenderNode): RenderElement | undefined {
  if (typeof node === 'string' || !node) return undefined
  const props = ((node as { props?: unknown }).props ?? {}) as { backgroundColor?: string; children?: RenderNode[] }
  if (props.backgroundColor === p.blockBg) return node as RenderElement
  for (const child of props.children ?? []) {
    const hit = fenceCard(child)
    if (hit) return hit
  }
  return undefined
}

const reply = (md: string, columns = 100) => renderReply(t, parseMarkdown(md), p, { bullet: false, columns, marks: false })

test('a box-drawing diagram over eight lines draws as itself: no header row, no line numbers', async () => {
  const card = fenceCard(reply('```\n' + boxDiagram.join('\n') + '\n```'))!
  expect(boxDiagram.length).toBeGreaterThan(8)
  expect(lines(card)).toEqual(boxDiagram)
})

test('a diagram row wider than the card truncates instead of wrapping', async () => {
  const wide = cp(0x250c) + cp(0x2500).repeat(70) + cp(0x2510)
  const card = fenceCard(reply('```\n' + wide + '\n' + cp(0x2502) + '\n```', 40))!
  const rows = ((card as { props: { children: RenderElement[] } }).props.children)
  for (const row of rows) expect((row as { props: { wrap?: string } }).props.wrap).toBe('truncate-end')
})

test('code over eight lines keeps its header and numbered gutter', async () => {
  const code = Array.from({ length: 10 }, (_, i) => `const a${i} = ${i}`)
  const rows = lines(fenceCard(reply('```ts\n' + code.join('\n') + '\n```'))!)
  expect(rows[0]).toBe('TS10 lines')
  expect(rows[1]).toBe(' 1  const a0 = 0')
})

test('a quoted diagram is as tall as its rows: no header row is counted', async () => {
  const blocks = parseMarkdown('> ```\n' + boxDiagram.map(l => '> ' + l).join('\n') + '\n> ```')
  if (blocks[0]?.kind !== 'quote') throw new Error('expected a quote')
  expect(quoteRows(blocks[0].blocks, 60)).toBe(boxDiagram.length)
})

test('a plain-text fence of prose with one arrow is still text, gutter and all', async () => {
  const prose = Array.from({ length: 10 }, (_, i) => `step ${i} of the runbook`)
  prose[3] = 'then ' + cp(0x2192) + ' retry'
  const rows = lines(fenceCard(reply('```text\n' + prose.join('\n') + '\n```'))!)
  expect(rows[0]).toBe('TEXT10 lines')
})

test('a quoted short fence with a language is as tall as its code: short fences draw no header', async () => {
  const blocks = parseMarkdown('> ```ts\n> const a = 1\n> const b = 2\n> ```')
  if (blocks[0]?.kind !== 'quote') throw new Error('expected a quote')
  expect(quoteRows(blocks[0].blocks, 60)).toBe(2)
})
