// Paints the DEMO.md fixtures in the terminal, before (the last release
// installed in the plugin cache) and after (this working tree), in real colors.
//
//   bun scripts/show.ts                     every fixture that differs
//   bun scripts/show.ts --all               identical fixtures too
//   bun scripts/show.ts diff-card hint      only fixtures whose name contains these
//   bun scripts/show.ts --theme rose-pine   resolve theme slots through that theme
//   bun scripts/show.ts --theme dark        ... or the stock dark defaults
//   bun scripts/show.ts --plain             no colors, for a paste
//   GLASS_BEFORE=/path/to/old/hooks bun scripts/show.ts
//   GLASS_PALETTE=crimson GLASS_BEFORE_PALETTE=water bun scripts/show.ts --all reply palette
//                                           one palette against another, same tree
//
// Before against the last commit instead of the installed release:
//   rm -rf /tmp/glass-base && mkdir -p /tmp/glass-base && git archive HEAD hooks types | tar -x -C /tmp/glass-base
//   GLASS_BEFORE=/tmp/glass-base/hooks bun scripts/show.ts --all
//
// The painter is scripts/paint.ts (shared with scripts/readme-shots.ts): an
// approximation of the engine's layout. The renderers build plain trees and
// import nothing at runtime from 'claude-code', so both versions load here
// as ordinary modules. A theme
// slot named as a color (planMode, diffAdded) resolves through the active
// custom theme file when settings.json names one, else the dark defaults;
// under a glass theme those slots are the palette's own colors, so the
// diff card and the mode word look the same before and after. Under
// rose-pine or dark they follow that theme, which is the change.
// A row that differs from the before block is marked with a bar.
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { ESC, makePainter } from './paint'
import type { Node } from './paint'
type Mods = {
  chrome: Record<string, (...a: never[]) => unknown>
  render: { renderReply: (...a: never[]) => Node }
  markdown: { parseMarkdown: (s: string) => unknown }
  palette: { PALETTES: Record<string, Record<string, string>> }
  glyphs: { G: Record<string, string> }
}

const HERE = new URL('.', import.meta.url).pathname
const AFTER = join(HERE, '..', 'hooks')
const BEFORE_VERSION = '0.9.1'
const BEFORE = process.env.GLASS_BEFORE ?? join(homedir(), '.claude', 'plugins', 'cache', 'glass', 'glass', BEFORE_VERSION, 'hooks')
const PALETTE = process.env.GLASS_PALETTE ?? 'water'
// the palette the before block paints with: the same unless asked, so one
// palette can stand beside another on the same tree
const BEFORE_PALETTE = process.env.GLASS_BEFORE_PALETTE ?? PALETTE
const COLUMNS = Math.min(process.stdout.columns ?? 100, 110)

// arguments: --all, --theme <name>, then fixture name filters
const argv = process.argv.slice(2)
const SHOW_ALL = argv.includes('--all')
const PLAIN = argv.includes('--plain')
const BEFORE_LABEL = (BEFORE.includes(`/${BEFORE_VERSION}/`) ? `before ${BEFORE_VERSION}` : `before (${BEFORE.replace(/\/hooks\/?$/, '').split('/').pop()})`) + (BEFORE_PALETTE !== PALETTE ? `, palette ${BEFORE_PALETTE}` : '')
const themeArg = argv.includes('--theme') ? argv[argv.indexOf('--theme') + 1] : undefined
const want = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--theme')

// ---- theme slots -----------------------------------------------------------

const DARK: Record<string, string> = {
  success: '#4eba65', error: '#ff6b80',
  planMode: '#5fb3d9', autoAccept: '#8fc98f', warning: '#e5a84b', permission: '#b1b9f9',
  diffAdded: '#225c2a', diffRemoved: '#7a2f2f', diffAddedWord: '#9cce8b', diffRemovedWord: '#e67680',
}
function themeSlots(): { name: string; slots: Record<string, string> } {
  try {
    let name = themeArg
    if (!name) {
      const settings = JSON.parse(readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf8')) as { theme?: string }
      name = /^custom:(.+)$/.exec(settings.theme ?? '')?.[1] ?? 'dark'
    }
    if (name === 'dark') return { name, slots: DARK }
    const file = join(homedir(), '.claude', 'themes', `${name}.json`)
    if (!existsSync(file)) return { name: `dark (no ${file})`, slots: DARK }
    const theme = JSON.parse(readFileSync(file, 'utf8')) as { overrides?: Record<string, string> }
    return { name, slots: { ...DARK, ...(theme.overrides ?? {}) } }
  } catch {
    return { name: 'dark', slots: DARK }
  }
}
const THEME = themeSlots()
const SLOTS = THEME.slots

// ---- painting ----------------------------------------------------------------

const painter = makePainter({ columns: COLUMNS, slots: SLOTS, plain: PLAIN })
const { rows, rgb, RESET } = painter

// ---- fixtures ------------------------------------------------------------------

const el = (type: string) => (props: Record<string, unknown>) => ({ type, props })
const t = { Box: el('Box'), Text: el('Text'), Button: el('Button'), Link: el('Link'), Code: el('Code'), Markdown: el('Markdown'), Raster: el('Raster') }

const REPLY = [
  '## What changed',
  '',
  'The engine now exposes `$.ui.notify` and glass reads it. Run `claude plugin test .` to see the dumps.',
  '',
  '- one item with `code`',
  '- a second item',
  '',
  '```ts',
  'const n: number = fmt(42) // note',
  '```',
  '',
  '**Bottom line**',
  'Verified: the tree validates on the terminal.',
  'Issue: none.',
  'Fix: nothing to do.',
].join('\n')

// 0.5.2 polish: nested items under the parent's text, right-aligned numbers,
// air around a card under an item, a card and a table under a heading
const LISTS = [
  '## Steps',
  '',
  '```ts',
  'const n = 1',
  '```',
  '',
  '8. Install the deps:',
  '   ```',
  '   npm install',
  '   ```',
  '9. Check the tree',
  '   - a child under the text',
  '   - a second child',
  '10. Then open the file',
  '    - its child',
  '',
  '## Results',
  '',
  '| file | cost | p95 | rate |',
  '| --- | --- | --- | --- |',
  '| render.ts | $12 | 1.2s | 3GB |',
  '| width.ts | ' + String.fromCodePoint(0x2014) + ' | 340ms | 4.5MB/s |',
].join('\n')

// 0.5.3: quoted prose in meta; fences by language (Rust lifetimes, JSON and
// YAML keys, Python's range as a call)
const QUOTE_AND_FENCES = [
  'A quote, then fences:',
  '',
  '> The tree validates on the terminal, **every** row, and `cellWidth` agrees.',
  '> Second line of the quote.',
  '',
  '```rs',
  "fn first<'a>(xs: &'a [u8]) -> Option<&'a u8> { xs.first() }",
  '```',
  '',
  '```py',
  'for i in range(10): print(values[i])',
  '```',
  '',
  '```json',
  '{ "name": "glass", "version": "0.5.3", "ok": true }',
  '```',
  '',
  '```yaml',
  'palette: water',
  'files:',
  '  - path: hooks/chrome.ts',
  '```',
].join('\n')

// 0.18.0: the prompt tip card under a Bottom line, so the two read apart
const TIP = [
  '**Bottom line**',
  'Verified: the build passes and devtools shows the hero on 375px.',
  'Issue: the title overflows below 360px.',
  'Fix: clamp the title size in the hero block.',
  '',
  'The fix is one line in `hero.tsx`.',
  '',
  '> **' + String.fromCodePoint(0x270e) + ' Prompt tip:** "Get confident" has no finish line. Name the questions it must answer.',
  '> *"Investigate the migration again before any code. List what still breaks against v17 and which Base parts we still need to port. Stop there and show me."*',
].join('\n')

const turn = {
  turnId: 'demo', durationMs: 146_000, tools: 4, edits: 1, failed: 1, inTokens: 1_800_000, cacheTokens: 1_620_000, outTokens: 5300,
  costUsd: 0.58, lastToolId: 't4', answer: 'done', startedAt: 0, finishedAt: 146_000,
}
const call = (id: string, tool: string, status: string, ms: number | null) => ({ id, tool, status, ms })
const row = (tool: string, input: unknown, failed = false, id = 't1') => ({ tool_use_id: id, tool, input, isRunning: false, isErrored: failed, isInterrupted: false })

function fixtures(m: Mods, paletteName = PALETTE): Record<string, () => Node | null> {
  const p = m.palette.PALETTES[paletteName] ?? m.palette.PALETTES.tidepool!
  const c = m.chrome as unknown as Record<string, (...a: unknown[]) => Node>
  const columns = COLUMNS
  return {
    reply: () => m.render.renderReply(...([t, m.markdown.parseMarkdown(REPLY), p, { first: true, columns, marks: true }] as never[])),
    lists: () => m.render.renderReply(...([t, m.markdown.parseMarkdown(LISTS), p, { first: true, columns, marks: false }] as never[])),
    tip: () => m.render.renderReply(...([t, m.markdown.parseMarkdown(TIP), p, { first: true, columns, marks: false }] as never[])),
    'quote-fences': () => m.render.renderReply(...([t, m.markdown.parseMarkdown(QUOTE_AND_FENCES), p, { first: true, columns, marks: false }] as never[])),
    // a Bash body shown whole against one that folds (the count only on the second)
    'bash-bodies': () =>
      t.Box({
        flexDirection: 'column',
        children: [
          c.renderTreeRow!(t, p, { ...row('Bash', { command: 'git status --short' }, false, 'b1'), output: { stdout: ' M a.ts\n M b.ts\n?? c.ts\n', stderr: '' } }, { durationMs: 400 }),
          c.renderTreeRow!(t, p, { ...row('Bash', { command: 'ls tests' }, false, 'b2'), output: { stdout: Array.from({ length: 12 }, (_, i) => `file-${i}.ts`).join('\n') + '\n', stderr: '' } }, { durationMs: 300 }),
          c.renderMessageRow!(t, p, 'Explore'),
        ],
      }),
    // every palette role in its own color, for the eye (colors only)
    palette: () =>
      t.Box({
        flexDirection: 'column',
        children: Object.entries(p).filter(([, v]) => typeof v === 'string' && /^#/.test(v)).map(([k, v]) =>
          t.Box({ flexDirection: 'row', children: [t.Text({ color: p.faint, children: [k.padEnd(12)] }), t.Text({ color: v, children: [`${v}  sample text 0.8s hooks/a.ts`] })] }),
        ),
      }),
    'event-rows': () =>
      t.Box({
        flexDirection: 'column',
        children: [
          c.renderEventRow!(t, p, 'm1', 'Agent "Hunt widths" finished\nFound 3 call sites.\nAll under hooks/.', { status: 'completed', durationMs: 72_000 }, true),
          c.renderGroupRow!(t, p, [{ tool: 'Read', input: { file_path: 'a.ts' }, isRunning: false, isErrored: false, isInterrupted: false }, { tool: 'Edit', input: { file_path: 'b.ts' }, isRunning: false, isErrored: false, isInterrupted: false }], { isActive: false, key: 'g2' }),
          ...(c.renderServerToolRows ? [c.renderServerToolRows(t, p, [{ id: 's1', name: 'advisor', startedAt: 1000, endedAt: 5200 }])] : []),
        ],
      }),
    summary: () => m.render.renderReply(...([t, m.markdown.parseMarkdown('Summary of the session so far: three files changed.'), p, { first: true, columns, marks: true, summary: true }] as never[])),
    'dots-line': () =>
      c.renderUserRow!(t, p, {
        text: 'add the notify option',
        submittedAt: 1_000_000,
        startedAt: 1_000_500,
        turn: { turnId: 'demo', calls: [call('t1', 'Read', 'ok', 300), call('t2', 'Bash', 'ok', 800), call('t3', 'Edit', 'failed', 120), call('t4', 'Bash', 'ok', 1200)], done: turn },
        columns,
        folded: false,
        onFold: () => undefined,
        onCopy: () => undefined,
      }),
    'tree-rows': () =>
      t.Box({
        flexDirection: 'column',
        children: [
          c.renderTreeRow!(t, p, row('Read', { file_path: 'hooks/register.ts' }), { durationMs: 300 }),
          c.renderTreeRow!(t, p, row('Bash', { command: 'git log --oneline -1' }, false, 't2'), { durationMs: 800 }),
          c.renderTreeRow!(t, p, row('Edit', { file_path: 'hooks/chrome.ts' }, true, 't3'), { durationMs: 120 }),
          c.renderGroupRow!(t, p, [{ tool: 'Read', input: { file_path: 'a.ts' }, isRunning: false, isErrored: false, isInterrupted: false }, { tool: 'Grep', input: { pattern: 'x' }, isRunning: false, isErrored: false, isInterrupted: false }], { isActive: false, key: 'g1' }),
        ],
      }),
    'diff-card': () =>
      c.renderDiff!(t, p, [{ oldStart: 268, newStart: 274, lines: ['  const right = x', '-  return t.Box({', '+  return spaced(t, p, t.Box({', '   key: 1'] }], { path: 'hooks/chrome.ts', columns }),
    'hint-modes': () =>
      t.Box({
        flexDirection: 'column',
        children: ['plan mode on', 'accept edits on', 'auto mode on', 'bypass permissions on'].map(rest => c.renderHint!(t, p, { vim: '-- INSERT --', rest })),
      }),
    band: () =>
      c.renderBand!(t, p, {
        agents: [
          { agentId: 'a1', description: 'Hunt widths', kind: 'Explore', model: 'claude-sonnet-5-5', effort: 'medium', stage: 'Grep', file: 'hooks/width.ts', tokens: 12_400, startedAt: 0 },
          { agentId: 'a2', description: 'Review the diff', kind: 'general-purpose', model: 'claude-opus-5-5', effort: 'high', stage: 'thinking' + m.glyphs.G.ellipsis, file: '', tokens: 900, startedAt: 30_000 },
        ],
        now: 85_000,
        columns,
        open: true,
        onToggle: null,
        tasksCommand: 'tasks',
        onView: () => undefined,
      }),
    'server-tools': () =>
      c.renderServerToolRows
        ? c.renderServerToolRows(t, p, [
            { id: 's1', name: 'advisor', startedAt: 1000, endedAt: 5200 },
            { id: 's2', name: 'advisor', startedAt: 9000 },
          ])
        : null,
  }
}

async function load(dir: string): Promise<Mods | null> {
  if (!existsSync(join(dir, 'chrome.ts'))) return null
  const [chrome, render, markdown, palette, glyphs] = await Promise.all(['chrome', 'render', 'markdown', 'palette', 'glyphs'].map(f => import(join(dir, `${f}.ts`))))
  return { chrome, render, markdown, palette, glyphs } as Mods
}

const before = await load(BEFORE)
const after = await load(AFTER)
if (!after) throw new Error(`no hooks at ${AFTER}`)
if (!before) console.log(`${ESC}[2m(no before: ${BEFORE} not found; set GLASS_BEFORE)${RESET}\n`)

const title = (s: string) => `${ESC}[1m${s}${RESET}`
const dim = (s: string) => `${ESC}[2m${s}${RESET}`
// the changed-row mark: glass's own thin gutter glyph in the palette's meta
// step, so it sits with the palette instead of shouting over it
const markPalette = after.palette.PALETTES[PALETTE] ?? after.palette.PALETTES.tidepool!
const MARK = `${rgb(markPalette.meta ?? '#8e8ca1', false)}${String.fromCodePoint(0x258e)}${RESET} `
const SAME = '  '

console.log(dim(`palette ${PALETTE}, theme slots from ${THEME.name}, ${before ? BEFORE_LABEL : 'no before'}, ${COLUMNS} columns`))
console.log('')

function paint(mods: Mods | null, name: string, paletteName = PALETTE): string[] | null {
  if (!mods) return null
  const make = fixtures(mods, paletteName)[name]
  const tree = make ? make() : null
  return tree === null ? null : rows(tree)
}

const names = Object.keys(fixtures(after)).filter(n => want.length === 0 || want.some(w => n.includes(w)))
let identical = 0
for (const name of names) {
  const a = paint(before, name, BEFORE_PALETTE)
  const b = paint(after, name)
  const same = a !== null && b !== null && a.length === b.length && a.every((r, i) => r === b[i])
  if (same && !SHOW_ALL) {
    identical += 1
    console.log(title(`== ${name}`) + dim('  identical before and after'))
    continue
  }
  console.log(title(`== ${name}`) + (same ? dim('  identical before and after') : ''))
  console.log(dim('-- ' + BEFORE_LABEL))
  if (a === null) console.log(dim('   (nothing drawn)'))
  else for (const r of a) console.log(SAME + r)
  console.log(dim('-- after (working tree)' + (same ? '' : '   (marked rows differ)')))
  if (b === null) console.log(dim('   (nothing drawn)'))
  else b.forEach((r, i) => console.log((a && a[i] === r ? SAME : MARK) + r))
  console.log('')
}
if (identical > 0 && !SHOW_ALL) console.log(dim(`${identical} fixture${identical === 1 ? '' : 's'} unchanged by design; --all shows them too`))
